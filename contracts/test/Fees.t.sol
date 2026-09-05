// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {TokenParams} from "../src/Types.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// Fees are the pool's own LP fee. The locker collects them and splits them by the terms frozen at launch.
contract FeesTest is BaseTest {
    address constant BURN = 0x000000000000000000000000000000000000dEaD;

    function test_fees_buysPayInTheQuote_collectSplitsProtocolAndCreator() public {
        (Token token,) = launchNative(creator);
        buy(token, alice, 1 ether);
        (uint256 a0, uint256 a1) = locker.pendingFees(address(token));
        // ETH is currency0: about 1% of 1 ETH is owed on the quote side, nothing on the coin side yet
        assertApproxEqRel(a0, 0.01 ether, 0.01e18, "1% of the buy, in ETH");
        assertEq(a1, 0);

        uint256 protoBefore = escrow.balanceOf(protocolFees);
        uint256 creatorBefore = escrow.balanceOf(creator);
        vm.prank(bob); // anyone
        (uint256 quoteOut, uint256 coinOut) = locker.collectFees(address(token));
        assertApproxEqRel(quoteOut, 0.01 ether, 0.01e18);
        assertEq(coinOut, 0);
        uint256 proto = escrow.balanceOf(protocolFees) - protoBefore;
        uint256 cre = escrow.balanceOf(creator) - creatorBefore;
        assertApproxEqRel(proto * 7, cre * 3, 0.001e18, "30 / 70 outside a ticker");
        assertEq(proto + cre, quoteOut, "every wei accounted for");
        (a0, a1) = locker.pendingFees(address(token));
        assertEq(a0, 0, "nothing left to collect");
        assertEq(address(locker).balance, 0, "locker keeps nothing");
    }

    function test_fees_sellSideFeesBurnInFull_creatorGetsNoCoin() public {
        (Token token,) = launchNative(creator);
        uint256 got = buy(token, alice, 1 ether);
        sell(token, alice, got / 2);
        (, uint256 a1) = locker.pendingFees(address(token));
        assertGt(a1, 0, "coin-side fee from the sell");
        uint256 burnedBefore = token.balanceOf(BURN);
        uint256 lockerBefore = token.balanceOf(address(locker)); // the launch's rounding dust, locked, not a fee
        uint256 protoBefore = escrow.balanceOf(protocolFees);
        uint256 creatorBefore = escrow.balanceOf(creator);
        (uint256 quoteOut, uint256 coinOut) = locker.collectFees(address(token));
        // every coin taken on the sell side is dead
        assertEq(token.balanceOf(BURN) - burnedBefore, coinOut, "the whole coin-side fee burned");
        assertEq(escrow.balanceOfToken(creator, address(token)), 0, "the creator is not paid in the coin");
        assertEq(escrow.balanceOfToken(protocolFees, address(token)), 0, "nor is the protocol");
        assertEq(token.balanceOf(address(locker)), lockerBefore, "the locker keeps none of the fee");
        // the quote side still splits as before
        uint256 proto = escrow.balanceOf(protocolFees) - protoBefore;
        uint256 cre = escrow.balanceOf(creator) - creatorBefore;
        assertApproxEqRel(proto * 7, cre * 3, 0.001e18, "30 / 70 on the quote");
        assertEq(proto + cre, quoteOut);
        assertEq(token.totalSupply(), SUPPLY, "supply is untouched, the burn is a dead balance");
    }

    function test_fees_creatorTaxIsTheCreatorsAlone() public {
        TokenParams memory p = defaultParams(address(0), 200); // 2% tax on top of the 1% base
        vm.prank(creator);
        (address t,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        assertEq(factory.getLaunchedToken(t).poolFee, 30_000, "3% pool fee");
        buy(Token(t), alice, 1 ether);
        (uint256 a0,) = locker.pendingFees(t);
        assertApproxEqRel(a0, 0.03 ether, 0.01e18, "3% of the buy");
        uint256 protoBefore = escrow.balanceOf(protocolFees);
        uint256 creatorBefore = escrow.balanceOf(creator);
        locker.collectFees(t);
        uint256 proto = escrow.balanceOf(protocolFees) - protoBefore;
        uint256 cre = escrow.balanceOf(creator) - creatorBefore;
        // base 1% of 3%: protocol 30% of a third = 10% of the total; creator gets the other 90%
        assertApproxEqRel(proto * 9, cre, 0.001e18, "protocol 10%, creator 90%");
    }

    function test_fees_underATickerTheClubGetsItsTenPercent() public {
        (,, bytes32 expected,) = tickers.previewLaunch("BANANA", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        uint256 value = LAUNCH_FEE + tickers.NEW_TICKER_FEE(); // read before the prank: a view call would consume it
        vm.prank(creator);
        (address banana, address bread,) = tickers.launch{value: value}("BANANA", p, 0);
        // alice buys BREAD with dollars wrapped into BANANA
        vm.startPrank(alice);
        usdg.approve(banana, 1_000e6);
        tickers.usdg(); // touch
        (bool ok,) = banana.call(abi.encodeWithSignature("mint(uint256,address)", 1_000e6, alice));
        require(ok);
        vm.stopPrank();
        buy(Token(bread), alice, 1_000e6);
        uint256 protoBefore = escrow.balanceOfToken(protocolFees, banana);
        (uint256 quoteOut,) = locker.collectFees(bread);
        uint256 epoch = tickers.currentEpoch();
        uint256 club = tickers.pot(banana, epoch, bread);
        uint256 proto = escrow.balanceOfToken(protocolFees, banana) - protoBefore;
        uint256 cre = escrow.balanceOfToken(creator, banana);
        assertApproxEqRel(club * 10, quoteOut, 0.001e18, "10% to the club");
        assertApproxEqRel(proto * 10, quoteOut * 3, 0.001e18, "30% to the protocol");
        assertApproxEqRel(cre * 10, quoteOut * 6, 0.001e18, "60% to the creator");
        assertGt(tickers.volumeOf(bread, epoch), 0, "the club records volume from the fee");
    }

    function test_fees_nothingToCollectIsANoop() public {
        (Token token,) = launchNative(creator);
        (uint256 q, uint256 c) = locker.collectFees(address(token));
        assertEq(q, 0);
        assertEq(c, 0);
    }
}
