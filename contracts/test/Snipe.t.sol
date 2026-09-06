// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {TokenParams} from "../src/Types.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// The snipe tax: a buy out of the pool in the coin's first five seconds pays a tax that starts at 99% and is gone
/// by the fifth second, burned to the dead address. The launch's own wallets never pay it, sells never pay it, the
/// locker's fee collection never pays it, and a zap's quote is what its buyer keeps.
contract SnipeTest is BaseTest {
    address constant DEAD_ADDR = 0x000000000000000000000000000000000000dEaD;

    /// a launch with no step past the window, so the next trade lands in the launch second
    function _launchNow(address who) internal returns (Token t) {
        TokenParams memory p = defaultParams(address(0), 0);
        vm.prank(who);
        (address a,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        return Token(a);
    }

    function _coinPending(Token t) internal view returns (uint256) {
        (uint256 a0, uint256 a1) = locker.pendingFees(address(t));
        PoolKey memory key = factory.poolKeyOf(address(t));
        return Currency.unwrap(key.currency0) == address(t) ? a0 : a1;
    }

    function test_snipe_aStrangerPaysNinetyNinePercentInTheLaunchSecond() public {
        Token t = _launchNow(creator);
        pastTheBlocks(); // the launch block is closed to strangers; the tax alone from here
        assertEq(t.currentSnipeTaxBps(alice), 9_900, "the launch second");
        assertEq(t.currentSnipeTaxBps(creator), 0, "the launcher never pays");
        uint256 out = buy(t, alice, 1 ether);
        uint256 tax = (out * 9_900) / 10_000;
        assertEq(t.balanceOf(alice), out - tax, "one percent arrives");
        assertEq(t.balanceOf(DEAD_ADDR), tax, "ninety-nine percent is burned");
        assertEq(t.totalSupply(), SUPPLY, "the supply does not change");
    }

    function test_snipe_theLaunchersOwnBuyIsExempt() public {
        // the dev buy inside the launch transaction, through the router
        TokenParams memory p = defaultParams(address(0), 0);
        vm.prank(creator);
        (address a,, uint256 got) = router.launchAndBuy{value: LAUNCH_FEE + 0.1 ether}(p, 0, address(0), 0.1 ether, 0, creator);
        Token t = Token(a);
        assertEq(t.balanceOf(creator), got, "the whole buy arrives");
        assertEq(t.balanceOf(DEAD_ADDR), 0, "nothing burned");
        // and a plain buy by the launcher in the same second
        uint256 out = buy(t, creator, 0.1 ether);
        assertEq(t.balanceOf(creator), got + out, "still whole");
    }

    function test_snipe_aNamedFeeWalletIsExemptToo() public {
        TokenParams memory p = defaultParams(address(0), 0);
        p.creatorFeeRecipient = bob;
        vm.prank(creator);
        (address a,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        assertEq(Token(a).currentSnipeTaxBps(bob), 0, "the fee wallet");
        assertEq(Token(a).currentSnipeTaxBps(creator), 0, "the launcher");
        assertEq(Token(a).currentSnipeTaxBps(alice), 9_900, "anyone else");
    }

    function test_snipe_decaysBySecondAndEnds() public {
        Token t = _launchNow(creator);
        pastTheBlocks();
        uint256[6] memory bps = [uint256(9_900), 2_500, 300, 50, 10, 0];
        for (uint256 i; i < 6; i++) {
            vm.warp(uint256(t.launchedAt()) + i);
            assertEq(t.currentSnipeTaxBps(alice), bps[i], "the rate for this second");
            uint256 dead = t.balanceOf(DEAD_ADDR);
            uint256 held = t.balanceOf(alice);
            uint256 out = buy(t, alice, 0.01 ether);
            uint256 tax = (out * bps[i]) / 10_000;
            assertEq(t.balanceOf(alice) - held, out - tax, "what arrives");
            assertEq(t.balanceOf(DEAD_ADDR) - dead, tax, "what burns");
        }
        assertEq(t.currentSnipeTaxBps(alice), 0, "gone for good");
    }

    function test_snipe_zapBuyPaysAndItsQuoteMatches() public {
        Token t = _launchNow(creator);
        pastTheBlocks();
        ZapRouter.Hop[] memory path = new ZapRouter.Hop[](1);
        path[0] = ZapRouter.Hop({kind: zap.HOP_V4(), key: factory.poolKeyOf(address(t)), pool: address(0)});
        ZapRouter.ZapParams memory p = ZapRouter.ZapParams({token: address(t), tokenIn: address(0), amountIn: 0, path: path, minTokensOut: 0, recipient: bob, deadline: block.timestamp + 60});
        uint256 quoted;
        vm.prank(bob);
        try zap.previewZap{value: 0.05 ether}(p) {
            revert("preview did not revert");
        } catch (bytes memory r) {
            uint256 b;
            assembly {
                b := mload(add(r, 68))
            }
            quoted = b;
        }
        vm.prank(bob);
        uint256 got = zap.zapBuy{value: 0.05 ether}(p);
        assertEq(got, quoted, "the quote is the trade, tax included");
        assertEq(t.balanceOf(bob), got, "bob keeps what the router forwarded");
        assertApproxEqRel(t.balanceOf(DEAD_ADDR), got * 99, 0.001e18, "the pool gave out a hundred times what bob kept");
    }

    function test_snipe_sellsAndFeeCollectionAreUntaxed() public {
        Token t = _launchNow(creator);
        pastTheBlocks();
        buy(t, alice, 1 ether);
        uint256 kept = t.balanceOf(alice);
        uint256 deadBefore = t.balanceOf(DEAD_ADDR);
        sell(t, alice, kept);
        assertEq(t.balanceOf(alice), 0, "sold it all");
        assertEq(t.balanceOf(DEAD_ADDR), deadBefore, "no tax on a sell");
        // the coin side of the fees reaches the locker whole and splits there: the protocol's 40% burns, the creator's 60% is escrowed
        uint256 pending = _coinPending(t);
        assertGt(pending, 0);
        (, uint256 c) = locker.collectFees(address(t));
        assertEq(c, pending, "the locker collected the whole coin fee, untaxed");
        assertEq(t.balanceOf(DEAD_ADDR) - deadBefore, (c * 4_000) / 10_000, "the protocol's share of the coin fees burned");
        assertEq(escrow.balanceOfToken(creator, address(t)), c - (c * 4_000) / 10_000, "the creator's share sits in the escrow");
    }
}
