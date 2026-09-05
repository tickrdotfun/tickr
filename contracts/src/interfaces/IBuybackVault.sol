// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Receives the buyback slice of fees in the launch's quote asset. v1 holds; a strategy may TWAP-buy later.
interface IBuybackVault {
    event Deposited(address indexed launchToken, address indexed quoteAsset, uint256 amount);
    event StrategyUpdated(address indexed strategy);
    event Released(address indexed launchToken, address indexed quoteAsset, address indexed to, uint256 amount);

    /// @dev quoteAsset == address(0) means native: send value. Otherwise the vault pulls `amount` via transferFrom.
    function deposit(address launchToken, address quoteAsset, uint256 amount) external payable;
    function balance(address launchToken, address quoteAsset) external view returns (uint256);
}
