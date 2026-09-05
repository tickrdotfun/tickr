// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IBuybackVault} from "./interfaces/IBuybackVault.sol";

/// @notice v1 buyback vault: accounts buyback slices per (launch token, quote asset).
/// A strategy contract (set by the owner, defaults to none) may release funds to execute TWAP buys of the platform token.
/// Default launch configs do not enable buybacks; enabling one is an explicit creator choice.
contract BuybackVault is IBuybackVault, Ownable2Step {
    using SafeERC20 for IERC20;

    address public strategy;
    mapping(address => mapping(address => uint256)) public override balance;

    constructor(address owner_) Ownable(owner_) {}

    function setStrategy(address strategy_) external onlyOwner {
        strategy = strategy_;
        emit StrategyUpdated(strategy_);
    }

    function deposit(address launchToken, address quoteAsset, uint256 amount) external payable override {
        uint256 received = amount;
        if (quoteAsset == address(0)) {
            require(msg.value == amount, "BuybackVault: value");
        } else {
            require(msg.value == 0, "BuybackVault: no value");
            // credit what arrived, not what was asked for: a token that takes a cut in transit is never owed the cut
            uint256 before = IERC20(quoteAsset).balanceOf(address(this));
            IERC20(quoteAsset).safeTransferFrom(msg.sender, address(this), amount);
            received = IERC20(quoteAsset).balanceOf(address(this)) - before;
        }
        balance[launchToken][quoteAsset] += received;
        emit Deposited(launchToken, quoteAsset, received);
    }

    /// @notice Release to the strategy for a buyback. Only the configured strategy can pull.
    function release(address launchToken, address quoteAsset, uint256 amount) external {
        require(msg.sender == strategy && strategy != address(0), "BuybackVault: not strategy");
        balance[launchToken][quoteAsset] -= amount;
        if (quoteAsset == address(0)) {
            (bool ok,) = strategy.call{value: amount}("");
            require(ok, "BuybackVault: transfer");
        } else {
            IERC20(quoteAsset).safeTransfer(strategy, amount);
        }
        emit Released(launchToken, quoteAsset, strategy, amount);
    }
}
