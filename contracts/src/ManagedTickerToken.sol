// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";

interface IManagedTickerHookBinding {
    function poolManager() external view returns (IPoolManager);
    function tokenOf(PoolId id) external view returns (address);
}

/// @title ManagedTickerToken
/// @notice An invented ticker: a one-for-one wrapper of USDG that runs its own dollar pool. What is in
/// circulation is backed by USDG the wrapper holds, idle or on the USDG side of its own positions in that pool;
/// the wrapper's own inventory of unsold tokens is neither backing nor circulation. Circulation is total supply
/// minus that inventory; backing is idle USDG plus the USDG in the wrapper's own positions, fees included. The
/// rule that never breaks: backing covers circulation, before and after every operation.
///
/// The pool trades as an ordinary Uniswap v4 pool at a fixed fee, with no custom swap accounting. Before every
/// outside swap the wrapper tops up its inventory and re-centres the price at one dollar, paying for the tiny
/// re-centring swap from its own surplus, never from backing; after the swap it checks the fill was whole, the
/// price is inside the band and the backing still covers circulation. A buy is bounded by the inventory on offer,
/// a sell by what is in circulation. Direct mint and redeem work only while the pool manager is locked. One visit
/// to the pool per transaction unless the caller checkpoints once the pool manager is locked again; a route that
/// crosses this pool twice in one transaction is not supported.
contract ManagedTickerToken is ERC20, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    uint24 public constant FEE = 500;
    uint160 public constant PARITY = uint160(1 << 96);
    uint256 public constant MIN_DONATION = 1_000_000;
    uint256 public constant CASH_KEEP = 10_000;
    uint256 public constant BRIDGE_SIDE = 1_000;
    uint256 public constant RECENTER_BUDGET = 4_096;
    bytes32 private constant VISITED = keccak256("tickr.managed.bridge.visited.v1");

    IERC20 public immutable counter;
    IPoolManager public immutable poolManager;
    address public immutable initializer;
    uint256 public immutable inventoryFloorRaw;
    uint8 private immutable _counterDecimals;
    address public hook;
    bool public maintaining;
    uint8 private _unlockMode;
    uint256 public maintenanceCount;
    uint256 public maintenanceSkipped;
    uint256 public measuredMaintenanceLoss;

    event Minted(address indexed by, address indexed to, uint256 amount);
    event Redeemed(address indexed by, address indexed to, uint256 amount);
    event Maintained(uint256 circulation, uint256 backing, uint256 inventoryCapacity, uint256 loss);
    event MaintenanceSkipped(bytes4 reason);
    event Recentered(uint256 actualInput, uint256 actualOutput, bool roundedOutputToZero);

    error WrongContext();
    error NotInitialized();
    error Insolvent(uint256 backing, uint256 circulation);
    error InsufficientMaintenanceSurplus();
    error CapacityExceeded(uint256 requested, uint256 capacity);
    error PartialFill();
    error MultipleBridgeVisits();

    constructor(
        string memory name_,
        string memory symbol_,
        IERC20 counter_,
        IPoolManager manager_,
        address initializer_,
        uint256 floor_
    ) ERC20(name_, symbol_) {
        require(address(counter_).code.length != 0 && address(manager_).code.length != 0 && initializer_ != address(0));
        require(
            IERC20Metadata(address(counter_)).decimals() == 6 && floor_ >= 1_000_000 && floor_ <= 1e18,
            "six decimal counter, bounded floor"
        );
        counter = counter_;
        poolManager = manager_;
        initializer = initializer_;
        inventoryFloorRaw = floor_;
        _counterDecimals = IERC20Metadata(address(counter_)).decimals();
    }

    function decimals() public view override returns (uint8) {
        return _counterDecimals;
    }

    function poolKey() public view returns (PoolKey memory) {
        bool w0 = address(this) < address(counter);
        return PoolKey(
            Currency.wrap(w0 ? address(this) : address(counter)),
            Currency.wrap(w0 ? address(counter) : address(this)),
            FEE,
            1,
            IHooks(hook)
        );
    }

    function initialize(address hook_, uint256 donation) external nonReentrant {
        if (msg.sender != initializer || hook != address(0) || poolManager.isUnlocked()) revert WrongContext();
        require(hook_.code.length != 0 && donation >= MIN_DONATION);
        uint160 expectedFlags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;
        require(uint160(hook_) & Hooks.ALL_HOOK_MASK == expectedFlags, "exact ordinary-accounting hook flags");
        require(address(IManagedTickerHookBinding(hook_).poolManager()) == address(poolManager));
        hook = hook_;
        require(IManagedTickerHookBinding(hook_).tokenOf(poolKey().toId()) == address(this), "hook binding");
        uint256 beforeBalance = counter.balanceOf(address(this));
        counter.safeTransferFrom(msg.sender, address(this), donation);
        require(counter.balanceOf(address(this)) - beforeBalance == donation, "exact counter only");
        poolManager.initialize(poolKey(), PARITY);
        _unlockMode = 1;
        poolManager.unlock("");
        _unlockMode = 0;
        _assertSolvent();
    }

    function checkpoint() external {
        if (poolManager.isUnlocked() || maintaining) revert WrongContext();
        _assertSolvent();
        _clearVisit();
    }

    function mint(uint256 amount, address to) external nonReentrant {
        _locked();
        require(amount != 0 && to != address(0) && to != address(this) && to != address(poolManager));
        uint256 beforeBalance = counter.balanceOf(address(this));
        counter.safeTransferFrom(msg.sender, address(this), amount);
        require(counter.balanceOf(address(this)) - beforeBalance == amount, "exact counter only");
        _mint(to, amount);
        _assertSolvent();
        emit Minted(msg.sender, to, amount);
    }

    function redeem(uint256 amount, address to) external nonReentrant {
        _locked();
        require(amount != 0 && to != address(0) && to != address(this) && to != address(poolManager));
        _burn(msg.sender, amount);
        if (counter.balanceOf(address(this)) < amount) {
            _unlockMode = 2;
            poolManager.unlock("");
            _unlockMode = 0;
        }
        require(counter.balanceOf(address(this)) >= amount, "owned counter not physically available");
        counter.safeTransfer(to, amount);
        _assertSolvent();
        emit Redeemed(msg.sender, to, amount);
    }

    function reserve() external view returns (uint256 b) {
        (b,) = accounting();
    }

    function circulatingSupply() public view returns (uint256 c) {
        (, c) = accounting();
    }

    function inventoryCapacity() public view returns (uint256) {
        uint256 c = circulatingSupply();
        require(c <= (type(uint128).max - inventoryFloorRaw) / 4);
        return inventoryFloorRaw + 4 * c;
    }

    function accounting() public view returns (uint256 backing, uint256 circulation) {
        uint256 owned = balanceOf(address(this));
        backing = counter.balanceOf(address(this));
        if (hook != address(0)) {
            for (uint256 i = 1; i <= 3; ++i) {
                (uint256 a0, uint256 a1) = _positionAssets(i);
                if (address(this) < address(counter)) {
                    owned += a0;
                    backing += a1;
                } else {
                    owned += a1;
                    backing += a0;
                }
            }
        }
        require(owned <= totalSupply(), "own inventory accounting");
        circulation = totalSupply() - owned;
    }

    function prepare(SwapParams calldata p) external {
        if (msg.sender != hook || !poolManager.isUnlocked() || maintaining) revert WrongContext();
        bytes32 slot = VISITED;
        uint256 visited;
        assembly ("memory-safe") { visited := tload(slot) }
        if (visited != 0) revert MultipleBridgeVisits();
        assembly ("memory-safe") { tstore(slot, 1) }
        uint256 cap = inventoryCapacity();
        uint256 requested = uint256(p.amountSpecified < 0 ? -p.amountSpecified : p.amountSpecified);
        require(requested != 0 && requested <= uint256(uint128(type(int128).max)));
        PoolKey memory k = poolKey();
        bool inputIsCounter = Currency.unwrap(p.zeroForOne ? k.currency0 : k.currency1) == address(counter);
        uint256 allowed = inputIsCounter ? cap : circulatingSupply();
        if (requested > allowed) revert CapacityExceeded(requested, allowed);
        // Atomic optional maintenance: dust rounding or insufficient spare capital must
        // not half-change the owned positions. Existing LP remains available only if
        // the normal outer swap fully fills and its final price/backing checks pass.
        try this.maintainSelf(cap + 100) {}
        catch (bytes memory reason) {
            ++maintenanceSkipped;
            emit MaintenanceSkipped(bytes4(reason));
            _assertSolvent();
        }
    }

    function maintainSelf(uint256 inventory) external {
        if (msg.sender != address(this) || maintaining || !poolManager.isUnlocked()) revert WrongContext();
        _maintain(inventory);
    }

    function validateAfter(SwapParams calldata p, BalanceDelta d) external view {
        if (msg.sender != hook || maintaining) revert WrongContext();
        int128 actual = p.amountSpecified < 0
            ? (p.zeroForOne ? d.amount0() : d.amount1())
            : (p.zeroForOne ? d.amount1() : d.amount0());
        if (int256(actual) != p.amountSpecified) revert PartialFill();
        (uint160 sqrtP,,,) = poolManager.getSlot0(poolKey().toId());
        require(
            sqrtP >= TickMath.getSqrtPriceAtTick(-2) && sqrtP <= TickMath.getSqrtPriceAtTick(2),
            "price outside backed fee band"
        );
        _assertSolvent();
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || _unlockMode == 0) revert WrongContext();
        if (_unlockMode == 1) {
            maintaining = true;
            _mint(address(this), BRIDGE_SIDE);
            _seed(3, BRIDGE_SIDE, BRIDGE_SIDE);
            maintaining = false;
            _maintain(inventoryFloorRaw + 100);
        } else {
            maintaining = true;
            _remove(1);
            _remove(2);
            // Retain the tiny recenter bridge but materialize its actually earned fees.
            poolManager.modifyLiquidity(poolKey(), ModifyLiquidityParams(-2, 2, 0, bytes32(uint256(3))), "");
            _settleOwn();
            maintaining = false;
        }
        return "";
    }

    function _maintain(uint256 inventory) internal {
        (uint256 beforeB, uint256 beforeC) = accounting();
        if (beforeB < beforeC + CASH_KEEP + RECENTER_BUDGET) revert InsufficientMaintenanceSurplus();
        maintaining = true;
        _remove(1);
        _remove(2);
        uint256 idleInventory = balanceOf(address(this));
        if (idleInventory != 0) _burn(address(this), idleInventory);
        _recenter();
        _mint(address(this), inventory);
        uint256 cash = counter.balanceOf(address(this));
        require(cash > CASH_KEEP, "maintenance cash");
        bool wrapper0 = address(this) < address(counter);
        _seed(wrapper0 ? 2 : 1, wrapper0 ? inventory : 0, wrapper0 ? 0 : inventory);
        _seed(wrapper0 ? 1 : 2, wrapper0 ? 0 : cash - CASH_KEEP, wrapper0 ? cash - CASH_KEEP : 0);
        maintaining = false;
        (uint256 afterB, uint256 afterC) = accounting();
        if (afterB < afterC + CASH_KEEP) revert InsufficientMaintenanceSurplus();
        uint256 beforeSurplus = beforeB - beforeC;
        uint256 afterSurplus = afterB - afterC;
        uint256 loss = beforeSurplus > afterSurplus ? beforeSurplus - afterSurplus : 0;
        measuredMaintenanceLoss += loss;
        ++maintenanceCount;
        _assertOwnSettled();
        emit Maintained(afterC, afterB, inventory, loss);
    }

    function _recenter() internal {
        PoolKey memory k = poolKey();
        (uint160 sqrtP,,,) = poolManager.getSlot0(k.toId());
        if (sqrtP == PARITY) return;
        bool zeroForOne = sqrtP > PARITY;
        Currency input = zeroForOne ? k.currency0 : k.currency1;
        if (Currency.unwrap(input) == address(this)) _mint(address(this), RECENTER_BUDGET);
        else require(counter.balanceOf(address(this)) >= RECENTER_BUDGET + CASH_KEEP);
        BalanceDelta d = poolManager.swap(k, SwapParams(zeroForOne, -int256(RECENTER_BUDGET), PARITY), "");
        int128 paid = zeroForOne ? d.amount0() : d.amount1();
        int128 received = zeroForOne ? d.amount1() : d.amount0();
        // A genuine epsilon-price move can round output to zero in six decimals.
        // It still pays actual input against retained LP; it is maintenance, not volume.
        require(paid < 0 && received >= 0 && poolManager.getLiquidity(k.toId()) > 0, "real retained-LP recenter");
        _settleOwn();
        (uint160 afterSqrt,,,) = poolManager.getSlot0(k.toId());
        require(afterSqrt == PARITY, "finite recenter budget exhausted");
        emit Recentered(uint256(uint128(-paid)), uint256(uint128(received)), received == 0);
    }

    function _seed(uint256 which, uint256 amount0, uint256 amount1) internal {
        (int24 low, int24 high) = _range(which);
        uint128 l = LiquidityAmounts.getLiquidityForAmounts(
            PARITY, TickMath.getSqrtPriceAtTick(low), TickMath.getSqrtPriceAtTick(high), amount0, amount1
        );
        if (l == 0) return;
        poolManager.modifyLiquidity(poolKey(), ModifyLiquidityParams(low, high, int256(uint256(l)), bytes32(which)), "");
        _settleOwn();
    }

    function _remove(uint256 which) internal {
        (int24 low, int24 high) = _range(which);
        (uint128 l,,) = poolManager.getPositionInfo(poolKey().toId(), address(this), low, high, bytes32(which));
        if (l == 0) return;
        poolManager.modifyLiquidity(
            poolKey(), ModifyLiquidityParams(low, high, -int256(uint256(l)), bytes32(which)), ""
        );
        _settleOwn();
    }

    function _settleOwn() internal {
        PoolKey memory k = poolKey();
        Currency[2] memory currencies = [k.currency0, k.currency1];
        for (uint256 i; i < 2; ++i) {
            int256 d = poolManager.currencyDelta(address(this), currencies[i]);
            if (d < 0) {
                poolManager.sync(currencies[i]);
                uint256 owed = uint256(-d);
                if (Currency.unwrap(currencies[i]) == address(this)) {
                    _transfer(address(this), address(poolManager), owed);
                } else {
                    counter.safeTransfer(address(poolManager), owed);
                }
                require(poolManager.settle() == owed, "exact own settlement");
            }
        }
        for (uint256 i; i < 2; ++i) {
            int256 d = poolManager.currencyDelta(address(this), currencies[i]);
            if (d > 0) poolManager.take(currencies[i], address(this), uint256(d));
        }
        _assertOwnSettled();
    }

    function _positionAssets(uint256 which) internal view returns (uint256 a0, uint256 a1) {
        PoolKey memory k = poolKey();
        (int24 low, int24 high) = _range(which);
        (uint128 l, uint256 last0, uint256 last1) =
            poolManager.getPositionInfo(k.toId(), address(this), low, high, bytes32(which));
        if (l == 0) return (0, 0);
        (uint160 sqrtP,,,) = poolManager.getSlot0(k.toId());
        uint160 lo = TickMath.getSqrtPriceAtTick(low);
        uint160 hi = TickMath.getSqrtPriceAtTick(high);
        if (sqrtP < hi) a0 = SqrtPriceMath.getAmount0Delta(sqrtP > lo ? sqrtP : lo, hi, l, false);
        if (sqrtP > lo) a1 = SqrtPriceMath.getAmount1Delta(lo, sqrtP < hi ? sqrtP : hi, l, false);
        (uint256 growth0, uint256 growth1) = poolManager.getFeeGrowthInside(k.toId(), low, high);
        unchecked {
            a0 += FullMath.mulDiv(l, growth0 - last0, 1 << 128);
            a1 += FullMath.mulDiv(l, growth1 - last1, 1 << 128);
        }
    }

    function _range(uint256 which) internal pure returns (int24 low, int24 high) {
        if (which == 1) return (-2, 0);
        if (which == 2) return (0, 2);
        return (-2, 2);
    }

    function _assertSolvent() internal view {
        (uint256 b, uint256 c) = accounting();
        if (b < c) revert Insolvent(b, c);
        // Redemptions need not destroy the retained recenter bridge. Its principal is
        // funded by surplus, NOT by claims; its collectable fees remain usable backing.
        uint256 usable = b - _retainedCounterPrincipal();
        if (usable < c) revert Insolvent(usable, c);
    }

    function usableBacking() external view returns (uint256) {
        (uint256 b,) = accounting();
        return b - _retainedCounterPrincipal();
    }

    function _retainedCounterPrincipal() internal view returns (uint256) {
        if (hook == address(0)) return 0;
        PoolKey memory k = poolKey();
        (uint128 l,,) = poolManager.getPositionInfo(k.toId(), address(this), -2, 2, bytes32(uint256(3)));
        if (l == 0) return 0;
        (uint160 sqrtP,,,) = poolManager.getSlot0(k.toId());
        uint160 lo = TickMath.getSqrtPriceAtTick(-2);
        uint160 hi = TickMath.getSqrtPriceAtTick(2);
        if (address(this) < address(counter)) {
            return sqrtP > lo ? SqrtPriceMath.getAmount1Delta(lo, sqrtP < hi ? sqrtP : hi, l, false) : 0;
        }
        return sqrtP < hi ? SqrtPriceMath.getAmount0Delta(sqrtP > lo ? sqrtP : lo, hi, l, false) : 0;
    }

    function _assertOwnSettled() internal view {
        PoolKey memory k = poolKey();
        require(
            poolManager.currencyDelta(address(this), k.currency0) == 0
                && poolManager.currencyDelta(address(this), k.currency1) == 0,
            "own deltas unsettled"
        );
    }

    function _locked() internal {
        if (hook == address(0)) revert NotInitialized();
        if (poolManager.isUnlocked() || maintaining) revert WrongContext();
        _clearVisit();
    }

    function _clearVisit() internal {
        bytes32 slot = VISITED;
        assembly ("memory-safe") { tstore(slot, 0) }
    }
}
