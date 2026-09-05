// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BuybackVault} from "../src/BuybackVault.sol";
import {FeeOnTransferERC20} from "./mocks/MockUSDG.sol";

/// Round four: the buyback vault books what arrived, so a token that takes a cut in transit cannot leave the vault
/// owing more than it holds.
contract AuditRound4Test is Test {
    function test_buybackVault_creditsWhatArrived_notWhatWasAsked() public {
        BuybackVault vault = new BuybackVault(address(this));
        FeeOnTransferERC20 fot = new FeeOnTransferERC20();
        fot.mint(address(this), 1_000e18);
        fot.approve(address(vault), 1_000e18);
        vault.deposit(address(0xC0FFEE), address(fot), 1_000e18);
        uint256 held = fot.balanceOf(address(vault));
        assertEq(held, 980e18, "two percent stayed on the road");
        assertEq(vault.balance(address(0xC0FFEE), address(fot)), held, "the book matches the balance");
    }

    function test_buybackVault_ethIsExact() public {
        BuybackVault vault = new BuybackVault(address(this));
        vault.deposit{value: 1 ether}(address(0xC0FFEE), address(0), 1 ether);
        assertEq(vault.balance(address(0xC0FFEE), address(0)), 1 ether);
    }
}
