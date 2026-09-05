// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {TokenParams, PairEconomics} from "../src/Types.sol";
import {MarketQuoteLauncher} from "../src/mode5/MarketQuoteLauncher.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {MockERC20} from "./mocks/MockUSDG.sol";
import {MockV3Pool} from "./mocks/MockV3Pool.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Market quotes: a launch priced in any token on the chain with a deep enough v3 pool.
contract MarketQuoteTest is BaseTest {
    function test_market_previewPricesFromTheV3Pool() public view {
        (bytes32 expected, PairEconomics memory econ, MarketQuoteLauncher.Market memory m, address base, uint256 px) = marketQuote.previewLaunch(0, address(wild));
        assertEq(m.pool, address(wildPool));
        assertEq(m.counter, address(weth));
        assertEq(m.depth, 6 ether);
        assertEq(base, address(0), "priced against ETH");
        assertEq(px, 1e18, "one WETH per WILD at the mock's one to one price");
        // target 1 ETH at one to one is a threshold of 1e18 WILD; the phantom is forty percent of that
        assertEq(econ.phantomQuote, 0.4e18);
        assertEq(econ.decimals, 18);
        assertTrue(expected != bytes32(0));
        assertTrue(marketQuote.isEligibleQuote(address(wild)));
    }

    function test_market_launchAndDevBuyInTheToken() public {
        (bytes32 expected,,,,) = marketQuote.previewLaunch(0, address(wild));
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        vm.startPrank(alice);
        wild.approve(address(marketQuote), 10e18);
        (address t,, uint256 out) = marketQuote.launchWithMarketQuoteAndBuy{value: LAUNCH_FEE}(p, 0, address(wild), 10e18, 0);
        vm.stopPrank();
        assertGt(out, 0);
        assertEq(Token(t).balanceOf(alice), out);
        assertEq(wild.balanceOf(address(marketQuote)), 0, "nothing stuck");
        assertEq(factory.getLaunchedToken(t).pairToken, address(wild));
        assertEq(factory.getLaunchedToken(t).phantomQuote, 0.4e18);
        // the pool is a plain hookless v4 pool like every other launch, and the position sits in the locker
        assertEq(address(factory.poolKeyOf(t).hooks), address(0));
    }

    function test_market_staleEconomicsRevert() public {
        (bytes32 expected,,,,) = marketQuote.previewLaunch(0, address(wild));
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        // the owner moves the target between the preview and the send: the hash no longer matches
        vm.prank(owner);
        marketQuote.setTargetRaise(address(0), 2 ether);
        vm.prank(alice);
        vm.expectRevert();
        marketQuote.launchWithMarketQuote{value: LAUNCH_FEE}(p, 0, address(wild));
    }

    function test_market_shallowPoolIsNotAMarket() public {
        MockERC20 thin = new MockERC20("Thin", "THIN", 18);
        MockV3Pool pool = new MockV3Pool(address(weth), address(thin), 3000, 1e18);
        v3Factory.set(address(weth), address(thin), 3000, address(pool));
        weth.deposit{value: 1 ether}();
        weth.transfer(address(pool), 1 ether);
        thin.mint(address(pool), 1e18);
        assertFalse(marketQuote.isEligibleQuote(address(thin)));
        vm.expectRevert(MarketQuoteLauncher.NoMarket.selector);
        marketQuote.bestMarket(address(thin));
        // the owner can lower the floor, and with enough liquidity at the price it is a market
        pool.setLiquidity(100e18);
        vm.prank(owner);
        marketQuote.setMinDepth(address(weth), 0.5 ether);
        assertTrue(marketQuote.isEligibleQuote(address(thin)));
    }

    function test_market_usdgPoolWhenNoWethPool() public {
        MockERC20 dollarCoin = new MockERC20("Dollar Coin", "DC", 18);
        // one DC = one USDG raw: 1e18 raw DC per 1e6 raw USDG is a price of 1e-12 or 1e12 depending on the order
        uint256 px = address(usdg) < address(dollarCoin) ? 1e12 * 1e18 : 1e18 / 1e12;
        MockV3Pool pool = new MockV3Pool(address(usdg), address(dollarCoin), 500, px);
        v3Factory.set(address(usdg), address(dollarCoin), 500, address(pool));
        usdg.mint(address(pool), 20_000e6);
        dollarCoin.mint(address(pool), 20_000e18);
        (, PairEconomics memory econ, MarketQuoteLauncher.Market memory m, address base,) = marketQuote.previewLaunch(0, address(dollarCoin));
        assertEq(m.counter, address(usdg));
        assertEq(base, address(usdg));
        // target 2,000 USDG at one dollar per DC is 2,000e18 DC; the phantom is forty percent of that
        assertEq(econ.phantomQuote, 800e18);
    }

    function test_market_anchorsAndTickrCoinsAreRefused() public {
        vm.expectRevert(MarketQuoteLauncher.QuoteIsAnchor.selector);
        marketQuote.bestMarket(address(usdg));
        vm.expectRevert(MarketQuoteLauncher.QuoteIsAnchor.selector);
        marketQuote.bestMarket(address(nvda));
        (Token paper,) = launchNative(creator);
        vm.expectRevert(MarketQuoteLauncher.QuoteLaunchedHere.selector);
        marketQuote.bestMarket(address(paper));
        assertFalse(marketQuote.isEligibleQuote(address(paper)));
    }

    function test_market_zapBuysTheCoinWithEthThroughTheV3Pool() public {
        (bytes32 expected,,,,) = marketQuote.previewLaunch(0, address(wild));
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        vm.prank(creator);
        (address t,) = marketQuote.launchWithMarketQuote{value: LAUNCH_FEE}(p, 0, address(wild));
        ZapRouter.Hop[] memory path = new ZapRouter.Hop[](2);
        PoolKey memory empty;
        path[0] = ZapRouter.Hop({kind: 1, key: empty, pool: address(wildPool)});
        path[1] = ZapRouter.Hop({kind: 0, key: factory.poolKeyOf(t), pool: address(0)});
        vm.prank(bob);
        uint256 out = zap.zapBuy{value: 0.1 ether}(ZapRouter.ZapParams({token: t, tokenIn: address(0), amountIn: 0, path: path, minTokensOut: 0, recipient: bob, deadline: vm.getBlockTimestamp() + 1 hours}));
        assertGt(out, 0, "bob paid ETH and holds a coin priced in WILD");
        assertEq(IERC20(address(wild)).balanceOf(address(zap)), 0, "nothing stuck in the zap");
    }

    function test_market_ranksByWhatItCostsToMoveThePrice_notTheLiquidityFigure() public {
        // a rival pool with an enormous liquidity figure but one WETH in it loses to the honest pool
        MockV3Pool rival = new MockV3Pool(address(weth), address(wild), 500, 1e18);
        v3Factory.set(address(weth), address(wild), 500, address(rival));
        rival.setLiquidity(type(uint128).max / 4);
        weth.deposit{value: 1 ether}();
        weth.transfer(address(rival), 1 ether);
        wild.mint(address(rival), 1e18);
        assertEq(marketQuote.bestMarket(address(wild)).pool, address(wildPool), "the honest pool wins");
        // a second honest pool that absorbs more within the band wins
        MockV3Pool deeper = new MockV3Pool(address(weth), address(wild), 10_000, 1e18);
        v3Factory.set(address(weth), address(wild), 10_000, address(deeper));
        deeper.setLiquidity(600e18);
        weth.deposit{value: 6 ether}();
        weth.transfer(address(deeper), 6 ether);
        wild.mint(address(deeper), 6e18);
        MarketQuoteLauncher.Market memory m = marketQuote.bestMarket(address(wild));
        assertEq(m.pool, address(deeper));
        assertGt(m.inBand, 5 ether);
    }

    function test_market_capitalParkedOutOfRangeIsNotAMarket() public {
        MockERC20 park = new MockERC20("Parked", "PARK", 18);
        MockV3Pool pool = new MockV3Pool(address(weth), address(park), 3000, 1e18);
        v3Factory.set(address(weth), address(park), 3000, address(pool));
        // ten WETH sit in the pool, but next to nothing is at the price
        pool.setLiquidity(1e15);
        weth.deposit{value: 10 ether}();
        weth.transfer(address(pool), 10 ether);
        park.mint(address(pool), 10e18);
        assertFalse(marketQuote.isEligibleQuote(address(park)));
        vm.expectRevert(MarketQuoteLauncher.NoMarket.selector);
        marketQuote.bestMarket(address(park));
    }

    function test_market_refusesQuotesUnderSixDecimals() public {
        MockERC20 tiny = new MockERC20("Tiny", "TINY", 4);
        MockV3Pool pool = new MockV3Pool(address(weth), address(tiny), 3000, 1e18);
        v3Factory.set(address(weth), address(tiny), 3000, address(pool));
        pool.setLiquidity(300e18);
        weth.deposit{value: 6 ether}();
        weth.transfer(address(pool), 6 ether);
        vm.expectRevert(MarketQuoteLauncher.QuoteDecimals.selector);
        marketQuote.bestMarket(address(tiny));
    }
}
