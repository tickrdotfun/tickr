// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {TokenParams} from "../src/Types.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";

contract RevertingClub {
    fallback() external payable {
        revert("club down");
    }
}

/// The owner's levers reach future launches only, and nothing the owner does can block a trade or a collection.
contract OwnerTest is BaseTest {
    function test_owner_swappingTheClubDoesNotTouchAnExistingLaunch() public {
        (Token token,) = launchNative(creator);
        buy(token, alice, 1 ether);
        address broken = address(new RevertingClub());
        address own = factory.owner();
        vm.prank(own);
        factory.setFeeClub(broken);
        (uint256 q,) = locker.collectFees(address(token));
        assertGt(q, 0, "collection still works");
        buy(token, alice, 0.1 ether);
    }

    function test_owner_ctoTimelockMovesAFeeRecipient() public {
        (Token token,) = launchNative(creator);
        address own = factory.owner();
        vm.prank(own);
        factory.proposeCreatorFeeRecipient(address(token), bob);
        vm.expectRevert(IFactory.TimelockNotElapsed.selector);
        factory.executeCreatorFeeRecipientChange(address(token));
        vm.warp(vm.getBlockTimestamp() + 3 days);
        factory.executeCreatorFeeRecipientChange(address(token));
        assertEq(factory.creatorFeeRecipientOf(address(token)), bob);
    }

    function test_owner_creatorMovesTheirOwnRecipient() public {
        (Token token,) = launchNative(creator);
        vm.prank(alice);
        vm.expectRevert(IFactory.NotCreatorFeeRecipient.selector);
        factory.transferCreatorFeeRecipient(address(token), alice);
        vm.prank(creator);
        factory.transferCreatorFeeRecipient(address(token), alice);
        assertEq(factory.creatorFeeRecipientOf(address(token)), alice);
    }

    function test_owner_closingLaunchesKeepsTradingOpen() public {
        (Token token,) = launchNative(creator);
        vm.prank(factory.owner());
        factory.setLaunchEnabled(false);
        TokenParams memory p = defaultParams(address(0), 0);
        vm.prank(alice);
        vm.expectRevert(IFactory.NotWhitelisted.selector);
        factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        buy(token, alice, 0.1 ether);
    }

    function test_owner_maxTaxCapIsTenPercentInCode() public {
        vm.prank(factory.owner());
        vm.expectRevert();
        factory.setMaxCreatorTaxBps(1_001);
    }
}
