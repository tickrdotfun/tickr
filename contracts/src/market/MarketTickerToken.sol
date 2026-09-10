// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MarketTickerToken
/// @notice An invented name as a plain fixed-supply ERC-20. Everything is issued once, to the workflow that locks
/// its market, and there is no way to make more, take any back, tax a transfer or stop one.
///
/// Deliberately less than `ManagedTickerToken`. That token is exactly redeemable for USDG and keeps its own pool
/// centred to make that true. This one promises nothing of the sort: it is worth what its USDG pool will pay,
/// which is near a dollar while that pool holds inventory. No mint, no redeem, no maintenance. The trade is
/// written down in prototype/00-BASELINE.md and must not be hidden behind the old interface.
contract MarketTickerToken is ERC20 {
    /// @notice The asset its market prices it in. Metadata only: holding this token is no claim on that asset.
    address public immutable counter;
    /// @notice The address every unit was issued to: the initialiser of the locked market.
    address public immutable issuer;

    uint8 private immutable _decimals;

    /// @param supply Every unit that will ever exist, in raw units.
    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 supply, address counter_, address issuer_)
        ERC20(name_, symbol_)
    {
        require(supply != 0 && issuer_ != address(0) && counter_ != address(0), "MarketTickerToken: zero");
        _decimals = decimals_;
        counter = counter_;
        issuer = issuer_;
        // the whole issuance, once, into the workflow that locks it; never to a creator's wallet
        _mint(issuer_, supply);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
