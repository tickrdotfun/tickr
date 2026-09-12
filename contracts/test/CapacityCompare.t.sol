// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fork} from "./Fork.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITickerToken} from "../src/interfaces/ITickerToken.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {ISeederLike} from "../src/market/QuoteConverter.sol";
import {LaunchSeeder} from "../src/LaunchSeeder.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {MarketTickerLauncher} from "../src/market/MarketTickerLauncher.sol";
import {MarketZapRouter} from "../src/market/MarketZapRouter.sol";
import {QuoteRegistry, ITickerLauncherLike} from "../src/market/QuoteRegistry.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {IWETH9} from "v4-periphery/src/interfaces/external/IWETH9.sol";
import {TokenParams, Socials, PairEconomics} from "../src/Types.sol";

interface ITickerLauncherFull {
    function launch(string calldata symbol, TokenParams calldata coin, uint256 launchConfigId)
        external payable returns (address ticker, address token, bytes32 poolId);
    function previewLaunch(string calldata symbol, uint256 launchConfigId)
        external view returns (address ticker, bool exists, bytes32 expected, PairEconomics memory econ);
}

interface ILaunchDeployerLike {
    function predictToken(address initiator, TokenParams calldata params, uint256 supply) external view returns (address);
}

/// @dev What the two bridges cost and how much they can take.
///
/// The coin's own pool is the same in both designs, so it is not what is being compared. The bridge is: the step
/// that turns dollars into the name a coin is priced in. A managed wrapper mints one for one and can mint for
/// ever. A market sells from a fixed inventory at a price, so it costs a fee and some slippage, and it runs out.
///
/// These are measurements, not a verdict. What they are worth depends on what a name is supposed to be.
contract CapacityCompareForkTest is Test {
    address constant SEEDER = 0x3733576410312D34B53F90cFE513B0D0995aB6Ca;
    address constant MARKET_DEPLOYER = 0x0F72C545Bd455DB7184F5B0eA4725f5AA8494418;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant FUN = 0xF9d30A05A63d795e3eF37b34143f33b2cBEf0f14;
    address constant TESTNAME = 0x4Dd89f107d9b8395237719FA9d621a7A5BC00c52;
    /// @dev The enabled 82 bps launch configuration on mainnet.
    uint256 constant CONFIG_82 = 2;
    address constant FACTORY = 0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f;
    address constant TICKER_LAUNCHER = 0x7f6c8bA781b5bDC499F2BA7501A2178508877649;
    address constant MANAGED_HOOK = 0x3adE2d75475e3262A4dfd1b55c012d39d704eAC0;
    address constant LAUNCH_DEPLOYER = 0xD86C1Cc523256519Dbd608318395e0C97e0368d6;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    address buyer = address(0xB0B);
    bool forked;

    function setUp() public {
        if (!Fork.select()) return;
        forked = true;
    }

    function marketKey() internal view returns (PoolKey memory) {
        return MarketTickerDeployer(MARKET_DEPLOYER).keyFor(TESTNAME);
    }

    /// @dev Dollars into the name through the market, reporting what arrived and what it cost in gas.
    function buyMarket(uint256 dollars) internal returns (uint256 got, uint256 gas, uint256 used) {
        PoolKey memory k = marketKey();
        bool zeroForOne = Currency.unwrap(k.currency0) == USDG;
        deal(USDG, buyer, dollars);
        vm.startPrank(buyer);
        IERC20(USDG).approve(SEEDER, dollars);
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        uint256 spentBefore = IERC20(USDG).balanceOf(buyer);
        uint256 before = gasleft();
        got = LaunchSeeder(payable(SEEDER)).swapExactInBounded(k, zeroForOne, dollars, 0, buyer, limit);
        gas = before - gasleft();
        // what the pool actually took, not what it was offered: a bounded swap refunds the rest
        used = spentBefore - IERC20(USDG).balanceOf(buyer);
        vm.stopPrank();
    }

    /// @dev The wrapper's other route: its own pool, the one an outside app would find and use. A wrapper is
    /// not only a mint; it trades too, and that is the leg a router picks when the pool pays better.
    function managedKey() internal pure returns (PoolKey memory) {
        (address c0, address c1) = FUN < USDG ? (FUN, USDG) : (USDG, FUN);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), 500, 1, IHooks(MANAGED_HOOK));
    }

    /// @dev External so a caller can catch a refusal. The managed pool has a hook, and a hook can say no.
    function tryBuyManagedPool(uint256 dollars) external returns (uint256 got, uint256 gas, uint256 used) {
        return buyManagedPool(dollars);
    }

    function buyManagedPool(uint256 dollars) internal returns (uint256 got, uint256 gas, uint256 used) {
        PoolKey memory k = managedKey();
        bool zeroForOne = Currency.unwrap(k.currency0) == USDG;
        deal(USDG, buyer, dollars);
        vm.startPrank(buyer);
        IERC20(USDG).approve(SEEDER, dollars);
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        uint256 before = gasleft();
        uint256 spentBefore = IERC20(USDG).balanceOf(buyer);
        got = LaunchSeeder(payable(SEEDER)).swapExactInBounded(k, zeroForOne, dollars, 0, buyer, limit);
        gas = before - gasleft();
        used = spentBefore - IERC20(USDG).balanceOf(buyer);
        vm.stopPrank();
    }

    /// @dev The same, through the wrapper, which mints.
    function buyWrapper(uint256 dollars) internal returns (uint256 got, uint256 gas, uint256 used) {
        deal(USDG, buyer, dollars);
        vm.startPrank(buyer);
        IERC20(USDG).approve(FUN, dollars);
        uint256 balBefore = IERC20(FUN).balanceOf(buyer);
        uint256 spentBefore = IERC20(USDG).balanceOf(buyer);
        uint256 before = gasleft();
        ITickerToken(FUN).mint(dollars, buyer);
        gas = before - gasleft();
        got = IERC20(FUN).balanceOf(buyer) - balBefore;
        used = spentBefore - IERC20(USDG).balanceOf(buyer);
        vm.stopPrank();
    }

    /// @notice One purchase, four sizes, all three bridges: the wrapper's mint, the wrapper's own pool, and the
    /// market's pool. What arrives, what it consumed, and what the step cost in gas.
    function test_fork_whatOneBuyCostsOnEachOfThreeRoutes() public {
        if (!forked) return;
        uint256[4] memory sizes = [uint256(100e6), 1_000e6, 10_000e6, 100_000e6];
        console.log("in | mint out/used/gas | managed pool out/used/gas | market out/used/gas");
        for (uint256 i; i < sizes.length; i++) {
            uint256 snap = vm.snapshotState();
            (uint256 wOut, uint256 wGas, uint256 wUsed) = buyWrapper(sizes[i]);
            vm.revertToState(snap);
            uint256 pOut;
            uint256 pGas;
            uint256 pUsed;
            bool pOk = true;
            try this.tryBuyManagedPool(sizes[i]) returns (uint256 a, uint256 b, uint256 c) {
                (pOut, pGas, pUsed) = (a, b, c);
            } catch {
                pOk = false;
            }
            vm.revertToState(snap);
            (uint256 mOut, uint256 mGas, uint256 mUsed) = buyMarket(sizes[i]);
            vm.revertToState(snap);

            console.log(sizes[i]);
            console.log(wOut); console.log(wUsed); console.log(wGas);
            if (pOk) { console.log(pOut); console.log(pUsed); console.log(pGas); } else { console.log("the managed pool refused this size"); }
            console.log(mOut); console.log(mUsed); console.log(mGas);
            console.log("bps of par: mint | managed pool | market");
            console.log((wOut * 10_000) / sizes[i]);
            console.log(pOk && pUsed != 0 ? (pOut * 10_000) / pUsed : 0);
            console.log((mOut * 10_000) / mUsed);

            assertEq(wOut, sizes[i], "a mint is exactly one for one, at every size");
            assertEq(wUsed, sizes[i], "and it consumes everything offered");
            assertEq(mUsed, sizes[i], "the market took the whole offer at these sizes");
            assertLe(mOut, sizes[i], "and never paid more than a dollar a name");
            assertGe((mOut * 10_000) / mUsed, 9_900, "the market stayed within a percent of par");
            // recorded as a difference between the designs, not as a fault: the wrapper's pool is behind a hook
            // and the hook has a size at which it says no. The market's pool has no hook and no such point.
            if (!pOk) {
                console.log("that size went through the market and not the managed pool");
                assertGe(sizes[i], 100_000e6, "the managed pool only refused at the largest size");
            }
        }
    }

    /// @notice How much each bridge can take. Twenty steps of fifty thousand dollars, and the acceptance
    /// conditions are asserted rather than left to the log: every step must complete, every step must stay above
    /// the floor, and what is counted is the input each step actually consumed.
    function test_fork_howMuchEachBridgeCanTake() public {
        if (!forked) return;
        uint256 step = 50_000e6;
        uint256 want = 20;
        uint256 floorBps = 9_700;
        uint256 consumed;
        uint256 received;
        uint256 done;
        uint256 worstBps = type(uint256).max;

        for (uint256 i; i < want; i++) {
            (uint256 got,, uint256 used) = buyMarket(step);
            if (used == 0) break; // the market took nothing at all: it is finished
            uint256 bps = (got * 10_000) / used;
            if (bps < worstBps) worstBps = bps;
            consumed += used;
            received += got;
            done++;
            if (bps < floorBps) break;
        }
        console.log("market: steps completed | dollars consumed | name out | worst step bps | average bps");
        console.log(done);
        console.log(consumed);
        console.log(received);
        console.log(worstBps);
        console.log((received * 10_000) / consumed);

        assertEq(done, want, "every step completed; none stopped short");
        assertGe(worstBps, floorBps, "and no single step fell below the floor");
        assertEq(consumed, step * want, "the market consumed every dollar offered, not merely part of each step");

        uint256 snap = vm.snapshotState();
        (uint256 wOut,, uint256 wUsed) = buyWrapper(consumed);
        console.log("wrapper: the same dollars consumed, name out");
        console.log(wOut);
        assertEq(wUsed, consumed);
        assertEq(wOut, consumed, "the wrapper takes the same amount at par, with no step at which it stops");
        vm.revertToState(snap);
        assertLe(received, consumed, "the market pays no more than par");
    }

    /// @notice The one cost that does not depend on size: the step itself.
    function test_fork_theStepItselfIsTheDifference() public {
        if (!forked) return;
        uint256 snap = vm.snapshotState();
        (, uint256 wGas,) = buyWrapper(1_000e6);
        vm.revertToState(snap);
        (, uint256 pGas,) = buyManagedPool(1_000e6);
        vm.revertToState(snap);
        (, uint256 mGas,) = buyMarket(1_000e6);
        vm.revertToState(snap);

        console.log("gas: mint | managed pool swap | market swap");
        console.log(wGas);
        console.log(pGas);
        console.log(mGas);
        // recorded because it is the opposite of what the shape of the two suggests: a swap through a pool is
        // cheaper here than a mint, because the wrapper's mint does more than move tokens
        assertLt(mGas, wGas, "the market's swap is cheaper than the mint");
    }

    // ---------------------------------------------------------------- complete buys and sells

    /// @dev Two coins with the same launch config, so the same supply, the same opening reserve and the same fee:
    /// one priced in the wrapper, one priced in the market name. Their own pools are therefore matched, and what
    /// differs between the round trips is the bridge and nothing else. The config is the enabled 82 bps one, the
    /// only one a market name's coin may launch on (`NotTheFrozenFee` refuses the others).
    function _twoMatchedCoins() internal returns (address legacy, address market, MarketTickerLauncher ml) {
        address me = address(0xC0FFEE);
        vm.deal(me, 10 ether);
        uint256 supply = IFactory(FACTORY).getLaunchConfig(CONFIG_82).supply;
        uint256 f = IFactory(FACTORY).launchFee();

        // the legacy side: the ticker launcher's own path, under the live wrapper's symbol
        (address ticker,, bytes32 expected,) = ITickerLauncherFull(TICKER_LAUNCHER).previewLaunch("FUN", CONFIG_82);
        TokenParams memory lp = _params("LEGACYSIDE", expected);
        lp.salt = _saltBelow(lp, ticker, me, supply);
        vm.prank(me);
        (, legacy,) = ITickerLauncherFull(TICKER_LAUNCHER).launch{value: f}("FUN", lp, CONFIG_82);

        // the market side: the same config, under the market name
        ml = new MarketTickerLauncher(IFactory(FACTORY), MarketTickerDeployer(MARKET_DEPLOYER));
        vm.prank(IFactory(FACTORY).owner());
        (bool ok,) = FACTORY.call(abi.encodeWithSignature("setRegistrar(address,bool)", address(ml), true));
        require(ok, "setRegistrar");
        TokenParams memory mp = _params("MARKETSIDE", ml.previewEconomics(CONFIG_82, TESTNAME));
        mp.salt = _saltBelow(mp, TESTNAME, me, supply);
        vm.prank(me);
        (market,) = ml.launch{value: f}(mp, CONFIG_82, TESTNAME);

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 25 hours);
    }

    function _params(string memory sym, bytes32 expected) internal pure returns (TokenParams memory p) {
        p = TokenParams({
            name: sym, symbol: sym, logo: "", description: "",
            socials: Socials("", "", "", "", ""), creatorFeeRecipient: address(0), creatorTaxBps: 0,
            buybackEnabled: false, expectedEconomics: expected, salt: bytes32(0)
        });
    }

    function _saltBelow(TokenParams memory p, address name, address who, uint256 supply) internal view returns (bytes32) {
        for (uint256 i = 1; i < 80_000; ++i) {
            p.salt = bytes32(i);
            if (ILaunchDeployerLike(LAUNCH_DEPLOYER).predictToken(who, p, supply) < name) return bytes32(i);
        }
        revert("no salt sorts below the name");
    }

    /// @notice The whole round trip on matched pools: dollars into a coin and back out again, on each design.
    /// This is the number that matters to somebody trading, because it carries every fee and every refund on
    /// both legs, not just the bridge's.
    function test_fork_aCompleteBuyAndSellOnMatchedPools() public {
        if (!forked) return;
        (address legacy, address market,) = _twoMatchedCoins();

        QuoteRegistry reg = new QuoteRegistry(
            ITickerLauncherLike(TICKER_LAUNCHER), MarketTickerDeployer(MARKET_DEPLOYER), USDG
        );
        reg.record(FUN);
        reg.record(TESTNAME);
        MarketZapRouter router = new MarketZapRouter(
            IFactory(FACTORY), ISeederLike(SEEDER).poolManager(), IWETH9(WETH), reg
        );

        // the opening reserve is 3,236 dollars, and a coin caps what one wallet may hold, so the stake is a
        // fraction of the pool rather than a multiple of it
        uint256 stake = 100e6;
        (uint256 lBack, uint256 lCoins) = _roundTrip(router, legacy, _wrapHop(FUN), stake);
        (uint256 mBack, uint256 mCoins) = _roundTrip(router, market, _v4Hop(marketKey()), stake);

        console.log("stake | legacy coins / dollars back | market coins / dollars back");
        console.log(stake);
        console.log(lCoins);
        console.log(lBack);
        console.log(mCoins);
        console.log(mBack);
        console.log("round trip kept, bps: legacy | market");
        console.log((lBack * 10_000) / stake);
        console.log((mBack * 10_000) / stake);

        assertGt(lCoins, 0, "the legacy route bought coins");
        assertGt(mCoins, 0, "the market route bought coins");
        assertGt(lBack, 0, "and both sold back");
        assertGt(mBack, 0);
        assertLt(lBack, stake, "a round trip costs something on both, because both pay pool fees");
        assertLt(mBack, stake);
        assertEq(IERC20(USDG).balanceOf(address(router)), 0, "nothing stranded either way");

        // the whole difference between the designs, on a complete trade: the market is crossed twice, at the
        // pool fee each way, and nothing else about the two round trips differs
        uint256 legacyKept = (lBack * 10_000) / stake;
        uint256 marketKept = (mBack * 10_000) / stake;
        assertGt(legacyKept, marketKept, "the market round trip keeps less, because it pays a fee both ways");
        assertLe(legacyKept - marketKept, 25, "and the gap is the two crossings, not something larger");
    }

    function _wrapHop(address name) internal pure returns (MarketZapRouter.Hop memory) {
        PoolKey memory empty;
        return MarketZapRouter.Hop({kind: 2, key: empty, pool: name});
    }

    function _v4Hop(PoolKey memory k) internal pure returns (MarketZapRouter.Hop memory) {
        return MarketZapRouter.Hop({kind: 0, key: k, pool: address(0)});
    }

    /// @dev Dollars in through `bridge` and the coin's own pool, then all the coins back out the same way.
    function _roundTrip(MarketZapRouter router, address coin, MarketZapRouter.Hop memory bridge, uint256 stake)
        internal
        returns (uint256 dollarsBack, uint256 coins)
    {
        address trader = address(0x77AD);
        deal(USDG, trader, stake);
        MarketZapRouter.Hop[] memory inPath = new MarketZapRouter.Hop[](2);
        inPath[0] = bridge;
        inPath[1] = _v4Hop(IFactory(FACTORY).poolKeyOf(coin));

        vm.startPrank(trader);
        IERC20(USDG).approve(address(router), stake);
        coins = router.zapBuy(
            MarketZapRouter.ZapParams({
                token: coin, tokenIn: USDG, amountIn: stake, path: inPath,
                minTokensOut: 1, recipient: trader, deadline: block.timestamp + 300
            })
        );

        MarketZapRouter.Hop[] memory outPath = new MarketZapRouter.Hop[](2);
        outPath[0] = inPath[1];
        outPath[1] = bridge;
        IERC20(coin).approve(address(router), coins);
        uint256 before = IERC20(USDG).balanceOf(trader);
        router.zapSell(
            MarketZapRouter.ZapSellParams({
                token: coin, amountIn: coins, path: outPath, tokenOut: USDG,
                minOut: 1, recipient: trader, deadline: block.timestamp + 300
            })
        );
        dollarsBack = IERC20(USDG).balanceOf(trader) - before;
        vm.stopPrank();
    }
}
