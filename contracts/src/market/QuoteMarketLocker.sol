// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title QuoteMarketLocker
/// @notice Where a name market's position goes to stay. It receives the position NFT and has no function that can
/// move it, decrease it, approve it, upgrade it or rescue it. There is no owner and no admin.
///
/// Deliberately empty. Every line that could be added here is a line that could take the principal back out, so
/// the absence of code is the guarantee. Fee collection, if it is ever wanted, has to arrive as a reviewed
/// contract that can prove it touches accrued fees and never liquidity; until then the market's fees stay in the
/// position, which costs nothing and cannot be confused with principal.
contract QuoteMarketLocker {
    /// @notice The position this locker holds, recorded when it arrives so it can be read without an indexer.
    uint256 public tokenId;
    /// @notice The market this position belongs to, for the same reason.
    address public token;

    error AlreadyHolding();

    /// @dev Recorded once, by the initialiser, in the same transaction that mints the position to this address.
    function record(address token_, uint256 tokenId_) external {
        if (tokenId != 0) revert AlreadyHolding();
        token = token_;
        tokenId = tokenId_;
    }

    /// @dev Accepts the position. It never leaves: there is no transfer, approve or burn path in this contract.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
