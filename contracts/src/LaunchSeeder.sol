// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {ILaunchSeeder} from "./interfaces/ILaunchSeeder.sol";
import {IFactory} from "./interfaces/IFactory.sol";
import {ITickerToken} from "./interfaces/ITickerToken.sol";
import {PriceMath} from "./libraries/PriceMath.sol";
import {V4Seeder} from "./libraries/V4Seeder.sol";

/// @notice Opens pools and locks positions. Two kinds:
///
/// A launch pool: a plain Uniswap v4 pool with no hook, opened at the coin's opening price with the entire supply
/// in one position that spans from that price to the end of the range. That position is the bonding curve: it
/// behaves exactly like a constant product pool whose quote side starts with a virtual balance of `phantomQuote`,
/// and it is locked in the locker from the first block. Nothing graduates, because nothing needs to.
///
/// A wrapper's dollar pool: an invented ticker is a one-for-one wrapper of USDG and needs no market, but chart
/// sites price a pair by walking from its quote token to a dollar through pools. So when a ticker is invented, the
/// fee for inventing it buys USDG and opens a guarded WRAPPER/USDG pool at exactly one dollar, locked, behind
/// `ChartGuardHook`, which refuses any swap that would leave the pool off one dollar. One small swap follows so
/// indexers list the pair.
///
/// The seeder also offers a plain exact-input swap on any pool, used for the creator's dev buy in the launch
/// transaction and for the site's trades. It holds nothing between calls and has no owner.
contract LaunchSeeder is ILaunchSeeder, IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint24 internal constant CHART_FEE = 100;
    int24 internal constant CHART_TICK_SPACING = 1;
    int24 internal constant CHART_BAND = 10; // ticks either side of one dollar, about 0.1%; the guard's band
    uint160 internal constant SQRT_ONE = 79228162514264337593543950336; // sqrt(1) * 2^96; a wrapper has its counter's decimals

    address public immutable override factory;
    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;
    address public immutable locker;
    /// @notice The guard every wrapper's dollar pool is created behind.
    IHooks public immutable chartHook;
    /// @notice USDG, and the live ETH/USDG pool the ticker fee is converted through.
    address public immutable usdg;
    PoolKey internal ethUsdgKey;

    event LaunchSeeded(address indexed token, bytes32 indexed poolId, uint256 tokenId, int24 tickLower, int24 tickUpper, uint128 liquidity);
    event DollarPoolSeeded(address indexed wrapper, bytes32 poolId, uint256 usdgIn, uint256 wrapperIn, uint256 tokenId);

    error OnlyPoolManager();
    error NotOneSided();
    error BadValue();
    error PoolAlreadyExists();
    error PositionNotLocked();
    error RefundFailed();

    constructor(
        address factory_,
        IPoolManager pm,
        IPositionManager posm,
        IAllowanceTransfer permit2_,
        address locker_,
        IHooks chartHook_,
        address usdg_,
        uint24 ethUsdgFee,
        int24 ethUsdgTickSpacing
    ) {
        factory = factory_;
        poolManager = pm;
        positionManager = posm;
        permit2 = permit2_;
        locker = locker_;
        chartHook = chartHook_;
        usdg = usdg_;
        ethUsdgKey = PoolKey({currency0: Currency.wrap(address(0)), currency1: Currency.wrap(usdg_), fee: ethUsdgFee, tickSpacing: ethUsdgTickSpacing, hooks: IHooks(address(0))});
    }

    // ---------------------------------------------------------------- the launch pool

    /// @inheritdoc ILaunchSeeder
    function seedLaunch(PoolKey calldata key, bool tokenIs0, uint256 supply, uint256 phantomQuote)
        external
        override
        returns (uint256 tokenId, int24 tickLower, int24 tickUpper, uint128 liquidity)
    {
        if (msg.sender != factory) revert OnlyFactory();
        // opening price: phantomQuote per supply. price = currency1 per currency0
        uint160 sqrtP = tokenIs0 ? PriceMath.sqrtPriceX96(phantomQuote, supply) : PriceMath.sqrtPriceX96(supply, phantomQuote);
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtP);
        int24 spacing = key.tickSpacing;
        uint160 sqrtInit;
        if (tokenIs0) {
            // the coin is currency0: its one-sided position sits above the price, from the next aligned tick up
            tickLower = _ceilAlign(tick + 1, spacing);
            tickUpper = TickMath.maxUsableTick(spacing);
            sqrtInit = TickMath.getSqrtPriceAtTick(tickLower);
        } else {
            // the coin is currency1: its one-sided position sits below the price, up to the aligned tick at it
            tickLower = TickMath.minUsableTick(spacing);
            tickUpper = _floorAlign(tick, spacing);
            sqrtInit = TickMath.getSqrtPriceAtTick(tickUpper);
        }
        {
            (uint160 existing,,,) = poolManager.getSlot0(key.toId());
            if (existing != 0) revert PoolAlreadyExists();
        }
        poolManager.initialize(key, sqrtInit);
        (uint256 a0, uint256 a1) = tokenIs0 ? (supply, uint256(0)) : (uint256(0), supply);
        (uint256 id, uint256 used0, uint256 used1) =
            V4Seeder.seedRange(positionManager, permit2, key, sqrtInit, tickLower, tickUpper, a0, a1, locker);
        if (id == 0) revert NotOneSided();
        if (IERC721(address(positionManager)).ownerOf(id) != locker) revert PositionNotLocked();
        tokenId = id;
        liquidity = positionManager.getPositionLiquidity(id);
        // rounding dust of the coin stays locked too
        uint256 used = tokenIs0 ? used0 : used1;
        address token = Currency.unwrap(tokenIs0 ? key.currency0 : key.currency1);
        if (supply > used) IERC20(token).safeTransfer(locker, supply - used);
        emit LaunchSeeded(token, PoolId.unwrap(key.toId()), tokenId, tickLower, tickUpper, liquidity);
    }

    // ---------------------------------------------------------------- the dollar pool

    /// @inheritdoc ILaunchSeeder
    function seedDollarPool(address wrapper) external payable override nonReentrant {
        if (msg.sender != IFactory(factory).tickerLauncher()) revert OnlyTickerLauncher();
        if (msg.value == 0) revert BadValue();
        // the ticker fee becomes dollars through the live ETH/USDG pool
        (uint256 got,) = _swap(ethUsdgKey, true, msg.value, address(this), TickMath.MIN_SQRT_PRICE + 1);
        // one part in two hundred stays for the listing swap; of the rest, half becomes the wrapper
        uint256 dust = got / 200;
        uint256 pool = got - dust;
        uint256 half = pool / 2;
        IERC20(usdg).forceApprove(wrapper, half);
        ITickerToken(wrapper).mint(half, address(this));

        PoolKey memory key = _chartKey(wrapper, usdg);
        poolManager.initialize(key, SQRT_ONE);
        bool wrapperIs0 = Currency.unwrap(key.currency0) == wrapper;
        (uint256 w, uint256 u) = (half, pool - half);
        (uint256 b0, uint256 b1) = wrapperIs0 ? (w, u) : (u, w);
        (uint256 tokenId,,) = V4Seeder.seedRange(positionManager, permit2, key, SQRT_ONE, -CHART_BAND, CHART_BAND, b0, b1, locker);
        // one small trade, dollars into the wrapper, so indexers that wait for a swap list the pair
        _swap(key, !wrapperIs0, dust, locker, !wrapperIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
        _flush(Currency.wrap(usdg), locker);
        _flush(Currency.wrap(wrapper), locker);
        emit DollarPoolSeeded(wrapper, PoolId.unwrap(key.toId()), u, w, tokenId);
    }

    // ---------------------------------------------------------------- swaps

    /// @inheritdoc ILaunchSeeder
    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut, address recipient)
        external
        payable
        override
        nonReentrant
        returns (uint256 amountOut)
    {
        return _swapExactIn(key, zeroForOne, amountIn, minOut, recipient, zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1, false);
    }

    /// @inheritdoc ILaunchSeeder
    function swapExactInBounded(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut, address recipient, uint160 sqrtPriceLimitX96)
        external
        payable
        override
        nonReentrant
        returns (uint256 amountOut)
    {
        return _swapExactIn(key, zeroForOne, amountIn, minOut, recipient, sqrtPriceLimitX96, true);
    }

    /// @dev Exact input up to `limit`: the pool stops there and whatever it did not take goes back to the caller.
    /// `proRata` is the bounded swap's consent to a cut-short fill: its minimum is a price, held on the part the pool
    /// took. The plain swap's minimum is a quantity, and a fill that falls short of it reverts whole.
    function _swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut, address recipient, uint160 limit, bool proRata)
        internal
        returns (uint256 amountOut)
    {
        Currency cIn = zeroForOne ? key.currency0 : key.currency1;
        if (cIn.isAddressZero()) {
            if (msg.value != amountIn) revert BadValue();
        } else {
            if (msg.value != 0) revert BadValue();
            IERC20(Currency.unwrap(cIn)).safeTransferFrom(msg.sender, address(this), amountIn);
        }
        uint256 owed;
        address to = recipient == address(0) ? msg.sender : recipient;
        Currency cOut = zeroForOne ? key.currency1 : key.currency0;
        // what the pool counts out is not always what arrives: a coin inside its launch window burns its snipe tax on
        // the way out. the minimum, and the amount reported, are what `to` actually received
        uint256 before = cOut.isAddressZero() ? 0 : IERC20(Currency.unwrap(cOut)).balanceOf(to);
        (amountOut, owed) = _swap(key, zeroForOne, amountIn, to, limit);
        if (!cOut.isAddressZero()) amountOut = IERC20(Currency.unwrap(cOut)).balanceOf(to) - before;
        // the plain swap insists on `minOut` coins whatever the pool took; the bounded swap, whose caller asked for a
        // fill that may stop short, is held to the same price on the part the pool took. the rest is refunded below
        uint256 need = proRata && owed != amountIn ? FullMath.mulDiv(minOut, owed, amountIn) : minOut;
        if (amountOut < need) revert Slippage();
        // a pool that runs out of the other side takes less than was sent: the rest goes back
        if (amountIn > owed) {
            uint256 back = amountIn - owed;
            if (cIn.isAddressZero()) {
                (bool ok,) = msg.sender.call{value: back}("");
                if (!ok) revert RefundFailed();
            } else {
                IERC20(Currency.unwrap(cIn)).safeTransfer(msg.sender, back);
            }
        }
    }

    function _swap(PoolKey memory key, bool zeroForOne, uint256 amountIn, address to, uint160 limit) internal returns (uint256 amountOut, uint256 owed) {
        bytes memory res = poolManager.unlock(abi.encode(key, zeroForOne, amountIn, to, limit));
        (amountOut, owed) = abi.decode(res, (uint256, uint256));
    }

    /// @dev Exact input of `amountIn` of the input currency, settled from this contract's balance, output to `to`.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (PoolKey memory key, bool zeroForOne, uint256 amount, address to, uint160 limit) = abi.decode(data, (PoolKey, bool, uint256, address, uint160));
        Currency cIn = zeroForOne ? key.currency0 : key.currency1;
        Currency cOut = zeroForOne ? key.currency1 : key.currency0;
        BalanceDelta d = poolManager.swap(key, SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amount), sqrtPriceLimitX96: limit}), "");
        int128 dIn = zeroForOne ? d.amount0() : d.amount1();
        int128 dOut = zeroForOne ? d.amount1() : d.amount0();
        uint256 owed;
        if (dIn < 0) {
            owed = uint256(uint128(-dIn));
            if (cIn.isAddressZero()) {
                poolManager.settle{value: owed}();
            } else {
                poolManager.sync(cIn);
                IERC20(Currency.unwrap(cIn)).safeTransfer(address(poolManager), owed);
                poolManager.settle();
            }
        }
        uint256 out = dOut > 0 ? uint256(uint128(dOut)) : 0;
        if (out > 0) poolManager.take(cOut, to, out);
        return abi.encode(out, owed);
    }

    // ---------------------------------------------------------------- views

    function chartKey(address wrapper) external view override returns (PoolKey memory) {
        return _chartKey(wrapper, usdg);
    }

    function hasChartPool(address wrapper) external view override returns (bool) {
        (uint160 sqrtP,,,) = poolManager.getSlot0(_chartKey(wrapper, usdg).toId());
        return sqrtP != 0;
    }

    function _chartKey(address a, address b) internal view returns (PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey({currency0: Currency.wrap(c0), currency1: Currency.wrap(c1), fee: CHART_FEE, tickSpacing: CHART_TICK_SPACING, hooks: chartHook});
    }

    function _ceilAlign(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 q = tick / spacing;
        if (tick % spacing != 0 && tick > 0) q += 1;
        int24 aligned = q * spacing;
        int24 maxTick = TickMath.maxUsableTick(spacing);
        return aligned > maxTick - spacing ? maxTick - spacing : aligned;
    }

    function _floorAlign(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 q = tick / spacing;
        if (tick % spacing != 0 && tick < 0) q -= 1;
        int24 aligned = q * spacing;
        int24 minTick = TickMath.minUsableTick(spacing);
        return aligned < minTick + spacing ? minTick + spacing : aligned;
    }

    function _flush(Currency c, address to) internal {
        uint256 bal = IERC20(Currency.unwrap(c)).balanceOf(address(this));
        if (bal > 0) IERC20(Currency.unwrap(c)).safeTransfer(to, bal);
    }

    receive() external payable {}
}
