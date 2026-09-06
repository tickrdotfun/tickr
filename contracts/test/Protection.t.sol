// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {TokenParams} from "../src/Types.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// Launch protection, in blocks, beside the snipe tax: the launch block is for the launch's own wallets only; for the
/// two blocks after, every other wallet is held to 5% of supply held and 5.5% bought, net of the tax; sells and
/// transfers are never limited; from the fourth block every limit is gone.
contract ProtectionTest is BaseTest {
    address constant DEAD_ADDR = 0x000000000000000000000000000000000000dEaD;

    function _launchNow(address who) internal returns (Token t) {
        TokenParams memory p = defaultParams(address(0), 0);
        vm.prank(who);
        (address a,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        return Token(a);
    }

    /// the second block of the window, after the snipe tax has run out: the caps alone
    function _secondBlockAfterTheTax() internal {
        vm.warp(vm.getBlockTimestamp() + 6);
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// a buy that must fail: the swap itself is the call that reverts, wrapped by the pool manager, so the
    /// expectation is set right before it and matches any revert; the caller checks that nothing moved
    function _buyMustRevert(Token t, address who, uint256 amount) internal {
        PoolKey memory key = factory.poolKeyOf(address(t));
        bool zeroForOne = Currency.unwrap(key.currency0) == address(0);
        vm.expectRevert();
        vm.prank(who);
        seeder.swapExactIn{value: amount}(key, zeroForOne, amount, 0, who);
    }

    function _pctOfSupply(Token t, address who) internal view returns (uint256 bps) {
        return (t.balanceOf(who) * 10_000) / t.totalSupply();
    }

    function test_protection_launchBlockOnlyExemptWallets() public {
        Token t = _launchNow(creator);
        assertEq(t.remainingBuy(alice), 0, "nothing for a stranger in the launch block");
        assertEq(t.remainingBuy(creator), type(uint256).max, "no limit for the launcher");
        uint256 before = t.balanceOf(alice);
        _buyMustRevert(t, alice, 0.01 ether);
        assertEq(t.balanceOf(alice), before, "nothing arrived in the launch block");
        uint256 got = buy(t, creator, 0.05 ether);
        assertEq(t.balanceOf(creator), got, "the launcher buys in the launch block");
        // the dev buy inside the launch transaction itself, on a second coin
        TokenParams memory p = defaultParams(address(0), 0);
        p.salt = keccak256("dev buy");
        vm.prank(creator);
        (address a,, uint256 dev) = router.launchAndBuy{value: LAUNCH_FEE + 0.1 ether}(p, 0, address(0), 0.1 ether, 0, creator);
        assertEq(Token(a).balanceOf(creator), dev, "the dev buy passes");
    }

    function test_protection_holdCapFivePercent() public {
        Token t = _launchNow(creator);
        _secondBlockAfterTheTax();
        buy(t, alice, 0.08 ether);
        uint256 held = _pctOfSupply(t, alice);
        assertGt(held, 400);
        assertLt(held, 500, "under the hold cap after one buy");
        assertGt(t.remainingHold(alice), 0);
        _buyMustRevert(t, alice, 0.02 ether);
        assertEq(_pctOfSupply(t, alice), held, "nothing partial");
    }

    function test_protection_buyCapFiveAndAHalfPercent() public {
        Token t = _launchNow(creator);
        _secondBlockAfterTheTax();
        uint256 first = buy(t, alice, 0.08 ether);
        sell(t, alice, first / 2);
        assertLt(_pctOfSupply(t, alice), 300, "sold half, holds under three percent");
        assertGt(t.remainingHold(alice), 0, "the hold cap has room");
        assertEq(t.boughtInWindow(alice), first, "selling does not give buying room back");
        // this buy would keep the wallet under 5% held but push the window's buys over 5.5%
        _buyMustRevert(t, alice, 0.04 ether);
    }

    function test_protection_secondWalletIsIndependent() public {
        Token t = _launchNow(creator);
        _secondBlockAfterTheTax();
        buy(t, alice, 0.08 ether);
        buy(t, bob, 0.08 ether);
        assertGt(_pctOfSupply(t, bob), 400, "bob has his own allowance");
        assertEq(t.boughtInWindow(bob), t.balanceOf(bob));
    }

    function test_protection_liftedAfterTwoBlocks() public {
        Token t = _launchNow(creator);
        vm.warp(vm.getBlockTimestamp() + 6);
        vm.roll(vm.getBlockNumber() + 3); // block four
        assertEq(t.remainingBuy(alice), type(uint256).max, "no cap left");
        assertEq(t.remainingHold(alice), type(uint256).max);
        buy(t, alice, 0.2 ether);
        assertGt(_pctOfSupply(t, alice), 1_000, "ten percent in one wallet");
        assertEq(t.boughtInWindow(alice), 0, "nothing counted after the window");
    }

    function test_protection_sellsAndTransfersNeverRestricted() public {
        Token t = _launchNow(creator);
        _secondBlockAfterTheTax();
        uint256 got = buy(t, alice, 0.08 ether);
        vm.prank(alice);
        t.transfer(bob, got); // a wallet-to-wallet transfer, inside the window, passes whole
        assertEq(t.balanceOf(bob), got);
        uint256 out = sell(t, bob, got / 2); // a sell, inside the window, passes
        assertGt(out, 0);
        // and the hold check reads the balance: bob holds about 2.3%, so he may still buy up to 5%
        assertGt(t.remainingHold(bob), 0);
        buy(t, bob, 0.03 ether);
        assertLt(_pctOfSupply(t, bob), 500);
    }

    function test_protection_stacksWithTheSnipeTax() public {
        Token t = _launchNow(creator);
        vm.roll(vm.getBlockNumber() + 1); // block two, still the launch second: 99% tax
        assertEq(t.currentSnipeTaxBps(alice), 9_900);
        uint256 dead = t.balanceOf(DEAD_ADDR);
        uint256 out = buy(t, alice, 0.5 ether);
        uint256 tax = (out * 9_900) / 10_000;
        assertEq(t.balanceOf(DEAD_ADDR) - dead, tax, "the tax burned");
        assertEq(t.balanceOf(alice), out - tax, "the net arrived");
        assertEq(t.boughtInWindow(alice), out - tax, "the caps count the net, not the pool's count");
        assertLt(_pctOfSupply(t, alice), 500, "and the net is under the cap although the gross was not");
    }
}
