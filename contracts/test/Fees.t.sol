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
        assertApproxEqRel(proto * 6, cre * 4, 0.001e18, "40 / 60 outside a ticker");
        assertEq(proto + cre, quoteOut, "every wei accounted for");
        (a0, a1) = locker.pendingFees(address(token));
        assertEq(a0, 0, "nothing left to collect");
        assertEq(address(locker).balance, 0, "locker keeps nothing");
    }

    /// The coin side splits like the quote side: under a ticker with a 2% creator tax, the creator's escrow in the
    /// coin is its 50% of the base part plus the whole tax part, and the dead address gains exactly the other 50%
    /// of the base part (40% protocol, 10% club). Nothing else moves.
    function test_fees_sellSide_creatorKeepsTheirShare_protocolAndClubBurn() public {
        (,, bytes32 expected,) = tickers.previewLaunch("BANANA", 0);
        TokenParams memory p = defaultParams(address(0), 200);
        p.expectedEconomics = expected;
        uint256 value = LAUNCH_FEE + tickers.NEW_TICKER_FEE();
        vm.prank(creator);
        (address banana, address bread,) = tickers.launch{value: value}("BANANA", p, 0);
        pastTheWindow();
        vm.startPrank(alice);
        usdg.approve(banana, 2_000e6);
        (bool ok,) = banana.call(abi.encodeWithSignature("mint(uint256,address)", 2_000e6, alice));
        require(ok);
        vm.stopPrank();
        Token token = Token(bread);
        uint256 got = buy(token, alice, 2_000e6);
        sell(token, alice, got / 2);
        (uint256 a0, uint256 a1) = locker.pendingFees(bread);
        PoolKey memory key = factory.poolKeyOf(bread);
        uint256 coinPending = Currency.unwrap(key.currency0) == bread ? a0 : a1;
        assertGt(coinPending, 0, "coin-side fee from the sell");
        uint256 burnedBefore = token.balanceOf(BURN);
        uint256 lockerBefore = token.balanceOf(address(locker));
        uint256 protoCoinBefore = escrow.balanceOfToken(protocolFees, bread);
        (, uint256 coinOut) = locker.collectFees(bread);
        // the base part is 1% of the 3% pool fee; the tax part is the other two thirds
        uint256 base = (coinOut * 100) / 300;
        uint256 burned = (base * 4_000) / 10_000 + (base * 1_000) / 10_000;
        assertEq(token.balanceOf(BURN) - burnedBefore, burned, "the protocol's and the club's halves of the base part are dead");
        assertEq(escrow.balanceOfToken(creator, bread), coinOut - burned, "the creator holds its half of the base part and the whole tax part");
        assertEq(escrow.balanceOfToken(protocolFees, bread), protoCoinBefore, "the protocol is not paid in the coin");
        assertEq(token.balanceOf(address(locker)), lockerBefore, "the locker keeps none of the fee");
        assertEq(token.totalSupply(), SUPPLY, "supply is untouched, the burn is a dead balance");
        assertEq(escrow.balanceOfToken(creator, bread) + burned, coinOut, "every coin accounted for");
    }

    function test_fees_creatorTaxIsTheCreatorsAlone() public {
        TokenParams memory p = defaultParams(address(0), 200); // 2% tax on top of the 1% base
        vm.prank(creator);
        (address t,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        pastTheWindow();
        assertEq(factory.getLaunchedToken(t).poolFee, 30_000, "3% pool fee");
        buy(Token(t), alice, 1 ether);
        (uint256 a0,) = locker.pendingFees(t);
        assertApproxEqRel(a0, 0.03 ether, 0.01e18, "3% of the buy");
        uint256 protoBefore = escrow.balanceOf(protocolFees);
        uint256 creatorBefore = escrow.balanceOf(creator);
        locker.collectFees(t);
        uint256 proto = escrow.balanceOf(protocolFees) - protoBefore;
        uint256 cre = escrow.balanceOf(creator) - creatorBefore;
        // base 1% of 3%: protocol 40% of a third is two fifteenths of the total; the creator gets the other thirteen
        assertApproxEqRel(proto * 13, cre * 2, 0.001e18, "protocol two fifteenths, creator thirteen fifteenths");
    }

    function test_fees_underATickerTheClubGetsItsTenPercent() public {
        (,, bytes32 expected,) = tickers.previewLaunch("BANANA", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        uint256 value = LAUNCH_FEE + tickers.NEW_TICKER_FEE(); // read before the prank: a view call would consume it
        vm.prank(creator);
        (address banana, address bread,) = tickers.launch{value: value}("BANANA", p, 0);
        pastTheWindow();
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
        assertApproxEqRel(proto * 10, quoteOut * 4, 0.001e18, "40% to the protocol");
        assertApproxEqRel(cre * 10, quoteOut * 5, 0.001e18, "50% to the creator");
        assertGt(tickers.volumeOf(bread, epoch), 0, "the club records volume from the fee");
    }

    function test_fees_nothingToCollectIsANoop() public {
        (Token token,) = launchNative(creator);
        (uint256 q, uint256 c) = locker.collectFees(address(token));
        assertEq(q, 0);
        assertEq(c, 0);
    }
}
