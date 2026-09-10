// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fork} from "./Fork.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IWETH9} from "v4-periphery/src/interfaces/external/IWETH9.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {MarketZapRouter} from "../src/market/MarketZapRouter.sol";
import {QuoteRegistry, ITickerLauncherLike} from "../src/market/QuoteRegistry.sol";
import {IQuoteKind} from "../src/market/IQuoteKind.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {ISeederLike} from "../src/market/QuoteConverter.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";

/// @dev The router against a coin priced in a fixed-inventory name, on the live pools: PROBETWO is quoted in
/// TESTNAME, TESTNAME trades against USDG in its own hookless market, and USDG trades against native ETH. So a
/// buy is three ordinary v4 hops and needs nothing the router did not already do. What is new is that a wrap hop
/// can no longer be pointed at a name that is not a wrapper.
contract MarketZapRouterForkTest is Test {
    address constant FACTORY = 0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f;
    address constant SEEDER = 0x3733576410312D34B53F90cFE513B0D0995aB6Ca;
    address constant LIVE_TICKER_LAUNCHER = 0x7f6c8bA781b5bDC499F2BA7501A2178508877649;
    address constant MARKET_DEPLOYER = 0x0F72C545Bd455DB7184F5B0eA4725f5AA8494418;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant TESTNAME = 0x4Dd89f107d9b8395237719FA9d621a7A5BC00c52;
    address constant PROBETWO = 0x151073687c3f5B569fdEC876bEb3DBcEF5F3Ac83;
    address constant FUN = 0xF9d30A05A63d795e3eF37b34143f33b2cBEf0f14;

    MarketZapRouter router;
    QuoteRegistry reg;
    address buyer = address(0xB0B);
    bool forked;

    function setUp() public {
        if (!Fork.select()) return;
        forked = true;
        reg = new QuoteRegistry(
            ITickerLauncherLike(LIVE_TICKER_LAUNCHER), MarketTickerDeployer(MARKET_DEPLOYER), USDG
        );
        reg.record(TESTNAME);
        reg.record(FUN);
        router = new MarketZapRouter(
            IFactory(FACTORY), ISeederLike(SEEDER).poolManager(), IWETH9(WETH), reg
        );
        vm.deal(buyer, 100_000 ether);
    }

    function ethUsdg() internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(USDG), 100, 1, IHooks(address(0)));
    }

    function v4(PoolKey memory k) internal pure returns (MarketZapRouter.Hop memory) {
        return MarketZapRouter.Hop({kind: 0, key: k, pool: address(0)});
    }

    function wrap(address name) internal pure returns (MarketZapRouter.Hop memory) {
        PoolKey memory empty;
        return MarketZapRouter.Hop({kind: 2, key: empty, pool: name});
    }

    /// @dev ETH into USDG, USDG into the name at its market price, the name into the coin's own pool.
    function buyPath() internal view returns (MarketZapRouter.Hop[] memory p) {
        p = new MarketZapRouter.Hop[](3);
        p[0] = v4(ethUsdg());
        p[1] = v4(MarketTickerDeployer(MARKET_DEPLOYER).keyFor(TESTNAME));
        p[2] = v4(IFactory(FACTORY).poolKeyOf(PROBETWO));
    }

    function buyParams(uint256 minOut, uint256 deadline)
        internal
        view
        returns (MarketZapRouter.ZapParams memory)
    {
        return MarketZapRouter.ZapParams({
            token: PROBETWO,
            tokenIn: address(0),
            amountIn: 0,
            path: buyPath(),
            minTokensOut: minOut,
            recipient: buyer,
            deadline: deadline
        });
    }

    // ---------------------------------------------------------------- the whole route

    /// @notice A coin priced in a market name is bought with native ETH in one transaction, through three pools,
    /// and the coin lands in the buyer's wallet. Each hop is paid with what the one before it actually returned.
    function test_fork_buysACoinPricedInAMarketNameWithEth() public {
        if (!forked) return;
        vm.prank(buyer);
        uint256 out = router.zapBuy{value: 0.002 ether}(buyParams(1, block.timestamp + 300));

        console.log("coin bought with 0.002 ETH");
        console.log(out);
        assertGt(out, 0, "the coin arrived");
        assertEq(IERC20(PROBETWO).balanceOf(buyer), out, "and all of it went to the buyer, not the router");
        assertEq(IERC20(USDG).balanceOf(address(router)), 0, "no dollars stranded in the router");
        assertEq(IERC20(TESTNAME).balanceOf(address(router)), 0, "no name stranded in the router");
        assertEq(address(router).balance, 0, "no ether stranded in the router");
    }

    /// @notice And back out again: the coin sells through the same three pools in reverse and the seller leaves
    /// with ether. Nothing is left behind in the router on the way.
    function test_fork_sellsTheSameCoinBackToEth() public {
        if (!forked) return;
        vm.prank(buyer);
        uint256 bought = router.zapBuy{value: 0.002 ether}(buyParams(1, block.timestamp + 300));

        MarketZapRouter.Hop[] memory back = new MarketZapRouter.Hop[](3);
        back[0] = v4(IFactory(FACTORY).poolKeyOf(PROBETWO));
        back[1] = v4(MarketTickerDeployer(MARKET_DEPLOYER).keyFor(TESTNAME));
        back[2] = v4(ethUsdg());

        uint256 ethBefore = buyer.balance;
        vm.startPrank(buyer);
        IERC20(PROBETWO).approve(address(router), bought);
        uint256 got = router.zapSell(
            MarketZapRouter.ZapSellParams({
                token: PROBETWO,
                amountIn: bought,
                path: back,
                tokenOut: address(0),
                minOut: 1,
                recipient: buyer,
                deadline: block.timestamp + 300
            })
        );
        vm.stopPrank();

        console.log("coin sold / ether back");
        console.log(bought);
        console.log(got);
        assertGt(got, 0, "ether came back");
        assertEq(buyer.balance, ethBefore + got);
        assertEq(IERC20(TESTNAME).balanceOf(address(router)), 0, "nothing stranded in the router");
    }

    // ---------------------------------------------------------------- the version check

    /// @notice A wrap hop pointed at a market is refused. Left alone it would mint and redeem at par a name that
    /// has a price, which is the whole error this change exists to stop.
    function test_fork_aWrapHopOnAMarketNameIsRefused() public {
        if (!forked) return;
        MarketZapRouter.Hop[] memory p = new MarketZapRouter.Hop[](3);
        p[0] = v4(ethUsdg());
        p[1] = wrap(TESTNAME);
        p[2] = v4(IFactory(FACTORY).poolKeyOf(PROBETWO));

        MarketZapRouter.ZapParams memory params = buyParams(1, block.timestamp + 300);
        params.path = p;
        vm.startPrank(buyer);
        vm.expectPartialRevert(MarketZapRouter.NotAWrapper.selector);
        router.zapBuy{value: 0.002 ether}(params);
        vm.stopPrank();
        assertEq(IERC20(PROBETWO).balanceOf(buyer), 0, "and nothing was bought");
    }

    /// @notice A wrapper nobody has registered still routes, all the way to a real coin priced in it. Provenance
    /// is proved from the launcher that issued the name, so an empty registry does not strand every name that
    /// existed before the registry did. Requiring a record here would have broken every live wrapper on day one.
    function test_fork_anUnregisteredButGenuineWrapperStillRoutes() public {
        if (!forked) return;
        QuoteRegistry bare = new QuoteRegistry(
            ITickerLauncherLike(LIVE_TICKER_LAUNCHER), MarketTickerDeployer(MARKET_DEPLOYER), USDG
        );
        assertEq(uint256(bare.kindOf(FUN)), uint256(IQuoteKind.Kind.UNKNOWN), "nothing is recorded");
        assertEq(uint256(bare.provenanceOf(FUN)), uint256(IQuoteKind.Kind.LEGACY_REDEEMABLE_WRAPPER), "but it is proven");

        address coin = _aCoinPricedIn(FUN);
        assertTrue(coin != address(0), "the chain has a coin priced in the wrapper to test with");

        MarketZapRouter r2 = new MarketZapRouter(
            IFactory(FACTORY), ISeederLike(SEEDER).poolManager(), IWETH9(WETH), bare
        );
        MarketZapRouter.Hop[] memory p = new MarketZapRouter.Hop[](3);
        p[0] = v4(ethUsdg());
        p[1] = wrap(FUN);
        p[2] = v4(IFactory(FACTORY).poolKeyOf(coin));

        vm.prank(buyer);
        uint256 out = r2.zapBuy{value: 0.002 ether}(
            MarketZapRouter.ZapParams({
                token: coin, tokenIn: address(0), amountIn: 0, path: p,
                minTokensOut: 1, recipient: buyer, deadline: block.timestamp + 300
            })
        );
        assertGt(out, 0, "the legacy route worked with an empty registry");
        assertEq(IERC20(coin).balanceOf(buyer), out);
    }

    /// @dev The first live coin quoted in `pair`, or zero if there is none.
    function _aCoinPricedIn(address pair) internal view returns (address) {
        uint256 n = IFactory(FACTORY).launchCount();
        for (uint256 i; i < n; i++) {
            address c = IFactory(FACTORY).launchAt(i);
            if (IFactory(FACTORY).getLaunchedToken(c).pairToken == pair) return c;
        }
        return address(0);
    }

    /// @notice A token neither issuer claims is refused: the router does not guess what an unknown thing is.
    function test_fork_aWrapHopOnSomethingNoIssuerClaimsIsRefused() public {
        if (!forked) return;
        MarketZapRouter.Hop[] memory p = new MarketZapRouter.Hop[](3);
        p[0] = v4(ethUsdg());
        p[1] = wrap(USDG); // a real token, issued by neither launcher
        p[2] = v4(IFactory(FACTORY).poolKeyOf(PROBETWO));

        MarketZapRouter.ZapParams memory params = buyParams(1, block.timestamp + 300);
        params.path = p;
        vm.startPrank(buyer);
        vm.expectPartialRevert(MarketZapRouter.NotAWrapper.selector);
        router.zapBuy{value: 0.002 ether}(params);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- what was already there, still there

    /// @notice The caller's minimum is the last word: a minimum above what the route returns reverts the whole
    /// transaction, and the buyer keeps their ether.
    function test_fork_theCallersMinimumIsEnforced() public {
        if (!forked) return;
        vm.prank(buyer);
        uint256 out = router.zapBuy{value: 0.002 ether}(buyParams(1, block.timestamp + 300));

        uint256 ethBefore = buyer.balance;
        // the params are built first: they read the factory, and a call inside the argument would eat the expectation
        MarketZapRouter.ZapParams memory tooDear = buyParams(out * 2, block.timestamp + 300);
        vm.startPrank(buyer);
        vm.expectRevert(MarketZapRouter.Slippage.selector);
        router.zapBuy{value: 0.002 ether}(tooDear);
        vm.stopPrank();
        assertEq(buyer.balance, ethBefore, "the buyer kept their ether");
    }

    /// @notice The caller's deadline is the last word too.
    function test_fork_theCallersDeadlineIsEnforced() public {
        if (!forked) return;
        MarketZapRouter.ZapParams memory stale = buyParams(1, block.timestamp - 1);
        vm.startPrank(buyer);
        vm.expectRevert(MarketZapRouter.Expired.selector);
        router.zapBuy{value: 0.002 ether}(stale);
        vm.stopPrank();
    }

    /// @notice A hop that cannot be filled whole is refused, and the seller keeps their coin. A partial hop would
    /// leave the difference sitting in the router belonging to nobody, so the router will not take one.
    ///
    /// The live pools are too deep to exhaust: a twenty thousand ether buy still filled. So the shallow pool is
    /// made here, a market holding two hundred units against a sale worth far more than that.
    function test_fork_aHopThatCannotFillWholeIsRefused() public {
        if (!forked) return;
        MarketTickerDeployer live = MarketTickerDeployer(MARKET_DEPLOYER);
        MarketTickerDeployer small = new MarketTickerDeployer(
            address(this), IERC20(TESTNAME), ISeederLike(SEEDER).poolManager(), live.posm(), live.permit2(),
            200e6, live.fee(), live.spacing(), live.width()
        );
        (address shallow,) = small.create(keccak256("SHALLOW"), "SHALLOW", 6);

        uint256 amount = 500_000_000e18;
        deal(PROBETWO, buyer, amount);
        MarketZapRouter.Hop[] memory path = new MarketZapRouter.Hop[](2);
        path[0] = v4(IFactory(FACTORY).poolKeyOf(PROBETWO));
        path[1] = v4(small.keyFor(shallow));
        MarketZapRouter.ZapSellParams memory sell = MarketZapRouter.ZapSellParams({
            token: PROBETWO,
            amountIn: amount,
            path: path,
            tokenOut: shallow,
            minOut: 1,
            recipient: buyer,
            deadline: block.timestamp + 300
        });

        vm.startPrank(buyer);
        IERC20(PROBETWO).approve(address(router), amount);
        vm.expectRevert(MarketZapRouter.InsufficientLiquidity.selector);
        router.zapSell(sell);
        vm.stopPrank();

        assertEq(IERC20(PROBETWO).balanceOf(buyer), amount, "the seller kept their coin");
        assertEq(IERC20(TESTNAME).balanceOf(address(router)), 0, "and nothing was left in the router");
        assertEq(IERC20(shallow).balanceOf(address(router)), 0);
    }

    /// @notice A buy far larger than anything a person would make still leaves the router empty. Whatever the
    /// route does on the way, the coin ends up with the buyer and no intermediate asset stays behind.
    function test_fork_aVeryLargeBuyStrandsNothing() public {
        if (!forked) return;
        vm.prank(buyer);
        uint256 out = router.zapBuy{value: 100 ether}(buyParams(1, block.timestamp + 300));

        console.log("coin bought with 100 ETH");
        console.log(out);
        assertEq(IERC20(PROBETWO).balanceOf(buyer), out, "every coin went to the buyer");
        assertEq(IERC20(USDG).balanceOf(address(router)), 0);
        assertEq(IERC20(TESTNAME).balanceOf(address(router)), 0);
        assertEq(IERC20(PROBETWO).balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }
    /// @notice A market whose inventory is gone answers with a name, not with Uniswap's raw error.
    ///
    /// A one-sided range that has been bought out leaves the pool price parked at the far bound. The next swap in
    /// that direction never reaches the pool's own accounting: v4 rejects it up front with PriceLimitAlreadyExceeded,
    /// which reaches the caller wrapped in a WrappedError and says nothing a buyer could act on. This asserts the
    /// router names the condition itself, and that the would-be buyer keeps every wei.
    ///
    /// Draining is done with v4's own PoolSwapTest because it tolerates a partial fill. Our router deliberately
    /// will not, so it cannot be used to create the state it has to survive.
    function test_fork_anExhaustedMarketRevertsWithAName() public {
        if (!forked) return;
        MarketTickerDeployer live = MarketTickerDeployer(MARKET_DEPLOYER);
        MarketTickerDeployer small = new MarketTickerDeployer(
            address(this), IERC20(TESTNAME), ISeederLike(SEEDER).poolManager(), live.posm(), live.permit2(),
            200e6, live.fee(), live.spacing(), live.width()
        );
        (address name,) = small.create(keccak256("EMPTY"), "EMPTY", 6);
        PoolKey memory key = small.keyFor(name);
        IPoolManager pm = ISeederLike(SEEDER).poolManager();

        // buy the whole inventory out, which parks the price against the bound
        PoolSwapTest swapper = new PoolSwapTest(pm);
        bool buyIsZeroForOne = Currency.unwrap(key.currency0) == TESTNAME;
        deal(TESTNAME, address(this), 1_000_000e6);
        IERC20(TESTNAME).approve(address(swapper), type(uint256).max);
        swapper.swap(
            key,
            SwapParams({
                zeroForOne: buyIsZeroForOne,
                amountSpecified: -int256(500_000e6),
                sqrtPriceLimitX96: buyIsZeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        (uint160 spot,,,) = StateLibrary.getSlot0(pm, PoolIdLibrary.toId(key));
        uint160 bound = buyIsZeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        assertTrue(buyIsZeroForOne ? spot <= bound : spot >= bound, "the market really is drained");
        console.log("drained. spot sqrtPriceX96:");
        console.log(spot);

        // now the router must name it
        // a real sell route: the coin's own pool first, then the drained market
        uint256 amount = 1_000e18;
        deal(PROBETWO, buyer, amount);
        MarketZapRouter.Hop[] memory path = new MarketZapRouter.Hop[](2);
        path[0] = v4(IFactory(FACTORY).poolKeyOf(PROBETWO));
        path[1] = v4(key);
        MarketZapRouter.ZapSellParams memory sell = MarketZapRouter.ZapSellParams({
            token: PROBETWO,
            amountIn: amount,
            path: path,
            tokenOut: name,
            minOut: 1,
            recipient: buyer,
            deadline: block.timestamp + 300
        });

        uint256 held = IERC20(PROBETWO).balanceOf(buyer);
        vm.startPrank(buyer);
        IERC20(PROBETWO).approve(address(router), amount);
        vm.expectRevert(
            abi.encodeWithSelector(MarketZapRouter.MarketExhausted.selector, TESTNAME, name)
        );
        router.zapSell(sell);
        vm.stopPrank();

        assertEq(IERC20(PROBETWO).balanceOf(buyer), held, "the seller kept every unit");
        assertEq(IERC20(name).balanceOf(address(router)), 0, "and the router kept nothing");
    }

}
