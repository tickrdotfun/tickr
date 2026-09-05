// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IAnchorRegistry {
    /// kind: 0 = native ETH, 1 = stablecoin (USDG), 2 = official Stock Token
    struct Anchor {
        string ticker;
        string issuer;
        uint8 kind;
        bool active;
        /// @dev Chainlink aggregator for this asset, or address(0) when it has none.
        address feed;
    }

    event AnchorRegistered(address indexed token, string ticker, uint8 kind, address feed);
    event AnchorStatus(address indexed token, bool active);

    function isApproved(address token) external view returns (bool);
    function isOfficialStock(address token) external view returns (bool);
    function anchorOf(address token) external view returns (Anchor memory);
    function anchorCount() external view returns (uint256);
    function anchorAt(uint256 i) external view returns (address);
    function feedOf(address token) external view returns (address);
    /// @notice True when `ticker` (case-insensitive) belongs to a registered anchor or was reserved by the owner.
    function isReservedTicker(string calldata ticker) external view returns (bool);
    /// @notice True when `name` (case-insensitive) is the name of an official asset or was reserved by the owner.
    function isReservedName(string calldata name) external view returns (bool);
}
