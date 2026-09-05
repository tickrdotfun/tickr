// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFeeEscrow} from "./interfaces/IFeeEscrow.sol";

/// @notice Pull-based fee balances. Crediting is open (it only ever gives money to a recipient); claiming is by the recipient.
contract FeeEscrow is IFeeEscrow, ReentrancyGuard {
    using SafeERC20 for IERC20;

    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override balanceOfToken;

    function credit(address recipient) external payable override {
        balanceOf[recipient] += msg.value;
        emit Credited(recipient, msg.value);
    }

    function creditToken(address recipient, address token, uint256 amount) external override {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        balanceOfToken[recipient][token] += received;
        emit CreditedToken(recipient, token, received);
    }

    function claim() external override nonReentrant {
        uint256 amount = balanceOf[msg.sender];
        balanceOf[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "FeeEscrow: transfer failed");
        emit Claimed(msg.sender, amount);
    }

    function claimToken(address token) external override nonReentrant {
        uint256 amount = balanceOfToken[msg.sender][token];
        balanceOfToken[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit ClaimedToken(msg.sender, token, amount);
    }
}
