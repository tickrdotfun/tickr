// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {ManagedTickerToken} from "../src/ManagedTickerToken.sol";
import {ManagedTickerHook} from "../src/ManagedTickerHook.sol";
import {TickerLauncher} from "../src/TickerLauncher.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {TokenParams} from "../src/Types.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

/// The managed wrapper's pool in production: every invented name runs one, behind the one hook, and coins under
/// the name are bought and sold through it by ordinary routes. What must hold: backing covers circulation after
/// everything, buys and sells fill whole or not at all, the pool stays at one dollar, one visit per transaction,
/// the two activation buys land in a wallet, and nothing but the launcher can create or register a pool.
contract ManagedTickerTest is BaseTest {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    ManagedTickerToken banana;
    Token bread;
    PoolKey key;
    bool usdgIs0;
    /// the wrapper counts its own positions conservatively, so a few raw units per maintenance read as circulation
    uint256 internal constant DUST = 1_000;

    function setUp() public override {
        super.setUp();
        (,, bytes32 expected,) = tickers.previewLaunch("BANANA", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        p.salt = saltUnder(creator, p, tickers.predictTicker("BANANA"));
        vm.prank(creator);
        (address q, address t,) = tickers.launch{value: LAUNCH_FEE + tickers.NEW_TICKER_FEE()}("BANANA", p, 0);
        pastTheWindow();
        banana = ManagedTickerToken(q);
        bread = Token(t);
        key = banana.poolKey();
        usdgIs0 = Currency.unwrap(key.currency0) == address(usdg);
        usdg.mint(bob, 10_000_000e6);
        vm.startPrank(bob);
        usdg.approve(address(swapRouter), type(uint256).max);
        banana.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    function _buy(address who, uint256 usdgIn) internal returns (uint256 got) {
        uint256 before = banana.balanceOf(who);
        vm.prank(who);
        swapRouter.swap(key, SwapParams({zeroForOne: usdgIs0, amountSpecified: -int256(usdgIn), sqrtPriceLimitX96: usdgIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1}), PoolSwapTest.TestSettings(false, false), "");
        got = banana.balanceOf(who) - before;
    }

    function _sell(address who, uint256 bananaIn) internal returns (uint256 got) {
        uint256 before = usdg.balanceOf(who);
        vm.prank(who);
        swapRouter.swap(key, SwapParams({zeroForOne: !usdgIs0, amountSpecified: -int256(bananaIn), sqrtPriceLimitX96: !usdgIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1}), PoolSwapTest.TestSettings(false, false), "");
        got = usdg.balanceOf(who) - before;
    }

    /// backing covers circulation, the usable part too, the price is at one dollar, and nothing is stranded
    function _solvent() internal view {
        (uint256 backing, uint256 circulation) = banana.accounting();
        assertGe(backing, circulation, "backing covers circulation");
        assertGe(banana.usableBacking(), circulation, "the usable backing covers it too");
        (, int24 tick,,) = poolManager.getSlot0(key.toId());
        assertTrue(tick >= -2 && tick <= 2, "inside the band");
        assertEq(usdg.balanceOf(address(swapRouter)), 0);
        assertEq(banana.balanceOf(address(swapRouter)), 0);
    }

    // ---------------------------------------------------------------- the pool at work

    function test_managed_sustainedBuysThenAFullSell_staysBacked() public {
        uint256 held;
        for (uint256 i; i < 10; i++) {
            held += _buy(bob, 10_000e6);
            _solvent();
        }
        (uint256 backing, uint256 circulation) = banana.accounting();
        assertApproxEqAbs(circulation, held, DUST);
        assertGe(backing, 100_000e6 * 99 / 100, "bob's dollars are the backing");
        uint256 got = _sell(bob, held);
        assertGt(got, held * 99 / 100, "a dollar each, less the fee, all the way back");
        (, circulation) = banana.accounting();
        assertLe(circulation, DUST);
        _solvent();
        assertGt(banana.maintenanceCount(), 10, "the pool was maintained before every swap");
    }

    function test_managed_theOfferGrowsWithWhatIsOut() public {
        uint256 floor = tickers.INVENTORY_FLOOR();
        assertApproxEqAbs(banana.inventoryCapacity(), floor, 4 * DUST, "the floor at rest");
        uint256 got = _buy(bob, 5_000e6);
        assertApproxEqAbs(banana.inventoryCapacity(), floor + 4 * got, 4 * DUST, "four times the circulation on top");
        // a buy the size of the whole offer fills whole
        uint256 cap = banana.inventoryCapacity();
        usdg.mint(bob, cap);
        uint256 big = _buy(bob, cap);
        assertGt(big, cap * 99 / 100, "the whole offer, at about a dollar");
        _solvent();
    }

    function test_managed_aSellAboveTheCirculationIsRefused() public {
        uint256 got = _buy(bob, 1_000e6);
        // nobody can sell more than is in circulation: the wrapper refuses before anything moves, with its own error
        vm.prank(bob);
        try swapRouter.swap(key, SwapParams({zeroForOne: !usdgIs0, amountSpecified: -int256(got + 1_000e6), sqrtPriceLimitX96: !usdgIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1}), PoolSwapTest.TestSettings(false, false), "") {
            revert("a sell above the circulation went through");
        } catch (bytes memory reason) {
            assertTrue(_has(reason, ManagedTickerToken.CapacityExceeded.selector), "CapacityExceeded");
        }
    }

    function test_managed_redeemPullsDollarsOutOfThePool_andTheNextSwapRebuildsIt() public {
        uint256 got = _buy(bob, 5_000e6);
        // the dollars bob paid sit on the pool's cash side, not idle in the wrapper
        assertLt(usdg.balanceOf(address(banana)), got, "not idle");
        uint256 before = usdg.balanceOf(bob);
        vm.prank(bob);
        banana.redeem(got, bob);
        assertEq(usdg.balanceOf(bob) - before, got, "one for one, from the pool's own cash");
        (, uint256 circulation) = banana.accounting();
        assertLe(circulation, DUST);
        // the pool still works: alice buys and the wrapper rebuilds its positions first
        usdg.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usdg.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
        uint256 a = _buy(alice, 1_000e6);
        assertGt(a, 990e6);
        _solvent();
    }

    function test_managed_mintAndRedeemStayOneForOne_afterPoolTrades() public {
        _buy(bob, 5_000e6);
        vm.startPrank(alice);
        usdg.approve(address(banana), 100e6);
        banana.mint(100e6, alice);
        assertEq(banana.balanceOf(alice), 100e6);
        banana.redeem(100e6, alice);
        vm.stopPrank();
        assertEq(banana.balanceOf(alice), 0);
        _solvent();
    }

    // ---------------------------------------------------------------- routes

    function test_managed_ethIntoACoinThroughTheNamePool_oneUnlock() public {
        // ETH -> USDG -> BANANA (its pool) -> BREAD (its pool): three v4 hops, one unlock, coins to alice
        ZapRouter.Hop[] memory path = new ZapRouter.Hop[](3);
        path[0] = _v4(ethUsdgKey);
        path[1] = _v4(key);
        path[2] = _v4(factory.poolKeyOf(address(bread)));
        vm.prank(alice);
        uint256 out = zap.zapBuy{value: 0.5 ether}(ZapRouter.ZapParams({token: address(bread), tokenIn: address(0), amountIn: 0, path: path, minTokensOut: 0, recipient: alice, deadline: vm.getBlockTimestamp() + 60}));
        assertGt(out, 0);
        assertEq(bread.balanceOf(alice), out);
        assertEq(banana.balanceOf(address(zap)), 0);
        _solvent();
        (, uint256 circulation) = banana.accounting();
        assertGt(circulation, 0, "the BANANA the coin's pool now holds is in circulation, and backed");
        // and back out through the same pools
        ZapRouter.Hop[] memory back = new ZapRouter.Hop[](3);
        back[0] = _v4(factory.poolKeyOf(address(bread)));
        back[1] = _v4(key);
        back[2] = _v4(ethUsdgKey);
        uint256 ethBefore = alice.balance;
        vm.startPrank(alice);
        bread.approve(address(zap), out);
        uint256 got = zap.zapSell(ZapRouter.ZapSellParams({token: address(bread), amountIn: out, path: back, tokenOut: address(0), minOut: 0, recipient: alice, deadline: vm.getBlockTimestamp() + 60}));
        vm.stopPrank();
        assertGt(got, 0);
        assertEq(alice.balance - ethBefore, got);
        _solvent();
    }

    function test_managed_activation_theNameLandsInTheWallet_thenTheCoin() public {
        // 1. the name itself, bought through its own pool, paid to alice by the pool manager, in its own transaction
        usdg.mint(alice, 100e6);
        vm.startPrank(alice);
        usdg.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
        uint256 got = _buy(alice, 20e6);
        assertEq(banana.balanceOf(alice), got, "the wallet holds the name");
        assertGt(got, 19e6, "about twenty dollars of it");
        _solvent();
        // 2. the coin, through the name's pool and its own, in a second transaction; the name from step 1 is kept
        ZapRouter.Hop[] memory path = new ZapRouter.Hop[](3);
        path[0] = _v4(ethUsdgKey);
        path[1] = _v4(key);
        path[2] = _v4(factory.poolKeyOf(address(bread)));
        vm.prank(alice);
        uint256 out = zap.zapBuy{value: 0.01 ether}(ZapRouter.ZapParams({token: address(bread), tokenIn: address(0), amountIn: 0, path: path, minTokensOut: 1, recipient: alice, deadline: vm.getBlockTimestamp() + 60}));
        assertGt(out, 0);
        assertEq(banana.balanceOf(alice), got, "the name bought first is not spent by the coin buy");
        _solvent();
    }

    function test_managed_oneVisitPerTransaction() public {
        // two swaps on the name's pool inside one unlock: the second is refused with the wrapper's own error
        TwoVisits visits = new TwoVisits(poolManager);
        usdg.mint(address(visits), 1_000e6);
        bytes memory reason = visits.run(key, usdgIs0, 100e6);
        assertTrue(_has(reason, ManagedTickerToken.MultipleBridgeVisits.selector), "MultipleBridgeVisits");
        // one visit per transaction is fine
        uint256 got = _buy(bob, 100e6);
        assertGt(got, 99e6);
        _solvent();
    }

    // ---------------------------------------------------------------- the hook

    function test_hook_ordinaryAccountingOnly_andBoundToTheLauncher() public view {
        uint160 flags = uint160(address(managedHook)) & Hooks.ALL_HOOK_MASK;
        assertEq(flags, Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG, "the five plain callbacks");
        assertEq(flags & Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG, 0, "no swap deltas");
        assertEq(flags & Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG, 0);
        assertEq(managedHook.issuer(), address(tickers));
        assertEq(address(managedHook.poolManager()), address(poolManager));
        assertEq(address(tickers.hook()), address(managedHook));
    }

    function test_hook_onlyTheWrapperTouchesItsOwnLiquidity() public {
        // an outsider adding liquidity to the name's pool, inside its own unlock: the hook's own refusal, by name
        Intruder intruder = new Intruder(poolManager);
        usdg.mint(address(intruder), 1_000e6);
        deal(address(banana), address(intruder), 1_000e6, true);
        bytes memory reason = intruder.add(key, 1e12);
        assertTrue(_has(reason, ManagedTickerHook.NotTheWrapper.selector), "NotTheWrapper on add");
        reason = intruder.remove(key, 1);
        assertTrue(_has(reason, ManagedTickerHook.NotTheWrapper.selector), "NotTheWrapper on remove");
        assertEq(address(managedHook.tokenOf(key.toId())), address(banana));
    }

    function test_hook_aSecondNameGetsItsOwnPoolBehindTheSameHook() public {
        (,, bytes32 expected,) = tickers.previewLaunch("BREADY", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        p.salt = saltUnder(alice, p, tickers.predictTicker("BREADY"));
        vm.prank(alice);
        (address q,,) = tickers.launch{value: LAUNCH_FEE + tickers.NEW_TICKER_FEE()}("BREADY", p, 0);
        ManagedTickerToken bready = ManagedTickerToken(q);
        assertEq(bready.hook(), address(managedHook));
        assertTrue(PoolId.unwrap(bready.poolKey().toId()) != PoolId.unwrap(key.toId()));
        assertEq(address(managedHook.tokenOf(bready.poolKey().toId())), q);
        assertEq(tickers.tickerCount(), 2);
    }

    function _v4(PoolKey memory k) internal pure returns (ZapRouter.Hop memory h) {
        h = ZapRouter.Hop({kind: 0, key: k, pool: address(0)});
    }

    /// @dev Whether revert data carries `sel` anywhere: the pool manager wraps a hook's revert in its own error,
    /// with the inner reason inside, so the wrapper's selector is what proves which check fired.
    function _has(bytes memory data, bytes4 sel) internal pure returns (bool) {
        if (data.length < 4) return false;
        for (uint256 i; i + 4 <= data.length; i++) {
            if (bytes4(uint32(uint8(data[i])) << 24 | uint32(uint8(data[i + 1])) << 16 | uint32(uint8(data[i + 2])) << 8 | uint32(uint8(data[i + 3]))) == sel) return true;
        }
        return false;
    }
}

/// @dev Two swaps on the same name's pool inside one unlock, the way a split route would visit it twice.
contract TwoVisits is IUnlockCallback {
    IPoolManager immutable pm;
    PoolKey key;
    bool usdgIs0;
    uint256 amount;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function run(PoolKey memory k, bool usdgIs0_, uint256 amount_) external returns (bytes memory reason) {
        key = k;
        usdgIs0 = usdgIs0_;
        amount = amount_;
        try pm.unlock("") {
            revert("two visits went through");
        } catch (bytes memory r) {
            reason = r;
        }
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm));
        // first visit: dollars in, the name out
        BalanceDelta d = pm.swap(key, SwapParams({zeroForOne: usdgIs0, amountSpecified: -int256(amount), sqrtPriceLimitX96: usdgIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1}), "");
        uint256 got = uint256(uint128(usdgIs0 ? d.amount1() : d.amount0()));
        // second visit in the same unlock: the name back to dollars
        pm.swap(key, SwapParams({zeroForOne: !usdgIs0, amountSpecified: -int256(got), sqrtPriceLimitX96: !usdgIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1}), "");
        return "";
    }
}

/// @dev An outsider that tries to add to or remove from a name's pool positions inside its own unlock.
contract Intruder is IUnlockCallback {
    IPoolManager immutable pm;
    PoolKey key;
    int256 delta;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function add(PoolKey memory k, uint256 liquidity) external returns (bytes memory) {
        return _try(k, int256(liquidity));
    }

    function remove(PoolKey memory k, uint256 liquidity) external returns (bytes memory) {
        return _try(k, -int256(liquidity));
    }

    function _try(PoolKey memory k, int256 d) internal returns (bytes memory reason) {
        key = k;
        delta = d;
        try pm.unlock("") {
            revert("an outsider touched the name's liquidity");
        } catch (bytes memory r) {
            reason = r;
        }
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm));
        pm.modifyLiquidity(key, ModifyLiquidityParams({tickLower: -2, tickUpper: 2, liquidityDelta: delta, salt: 0}), "");
        return "";
    }
}
