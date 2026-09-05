// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {TokenParams, PairEconomics} from "../src/Types.sol";
import {CoinQuoteLauncher} from "../src/mode3/CoinQuoteLauncher.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Stock Token quotes and coin quotes: the opening market cap comes from the quote's own price.
contract QuotesTest is BaseTest {
    function test_stock_launchAndDevBuyInNvda() public {
        (bytes32 expected, PairEconomics memory econ,) = stockQuote.previewLaunch(0, address(nvda));
        assertGt(econ.phantomQuote, 0);
        TokenParams memory p = defaultParams(address(nvda), 0);
        p.expectedEconomics = expected;
        vm.startPrank(alice);
        nvda.approve(address(stockQuote), 5e18);
        (address t,, uint256 out) = stockQuote.launchWithStockQuoteAndBuy{value: LAUNCH_FEE}(p, 0, address(nvda), 5e18, 0);
        vm.stopPrank();
        assertGt(out, 0);
        assertEq(Token(t).balanceOf(alice), out);
        assertEq(nvda.balanceOf(address(stockQuote)), 0, "nothing stuck");
        assertEq(factory.getLaunchedToken(t).pairToken, address(nvda));
    }

    function test_coin_launchPricedInALaunchedCoin_andWildQuotesAreRefused() public {
        (Token paper,) = launchNative(creator);
        buy(paper, bob, 2 ether);
        (bytes32 expected, PairEconomics memory econ,,) = coinQuote.previewLaunch(0, address(paper));
        assertGt(econ.phantomQuote, 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        uint256 have = paper.balanceOf(bob);
        vm.startPrank(bob);
        paper.approve(address(coinQuote), have / 10);
        (address t,, uint256 out) = coinQuote.launchWithCoinQuoteAndBuy{value: LAUNCH_FEE}(p, 0, address(paper), have / 10, 0);
        vm.stopPrank();
        assertGt(out, 0);
        assertEq(factory.getLaunchedToken(t).pairToken, address(paper));
        // a token this factory did not launch cannot be a quote
        vm.expectRevert(CoinQuoteLauncher.QuoteNotLaunchedHere.selector);
        coinQuote.previewLaunch(0, address(nvda));
    }
}
