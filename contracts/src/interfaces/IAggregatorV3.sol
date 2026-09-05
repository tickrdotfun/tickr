// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The Chainlink feed interface. Robinhood Chain publishes a feed per Stock Token, and the answer is the
/// price of one token with the corporate-action multiplier already applied, so callers must not apply it again.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
