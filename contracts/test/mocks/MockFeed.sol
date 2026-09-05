// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";

/// @notice A Chainlink-shaped feed. Robinhood Chain's Stock Token feeds report 8 decimals.
contract MockFeed is IAggregatorV3 {
    uint8 public immutable override decimals;
    int256 public answer;
    uint256 public updatedAt;
    string private _description;

    constructor(int256 answer_, uint8 decimals_, string memory description_) {
        answer = answer_;
        decimals = decimals_;
        _description = description_;
        updatedAt = block.timestamp;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function description() external view override returns (string memory) {
        return _description;
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
