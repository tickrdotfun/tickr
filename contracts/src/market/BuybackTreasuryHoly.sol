// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFactory} from "../interfaces/IFactory.sol";
import {IFeeEscrow} from "../interfaces/IFeeEscrow.sol";
import {LaunchSeeder} from "../LaunchSeeder.sol";
import {IQuoteKind} from "./IQuoteKind.sol";
import {MarketTickerDeployer} from "./MarketTickerDeployer.sol";
import {BuybackTreasuryV2} from "./BuybackTreasuryV2.sol";

/// @title BuybackTreasuryHoly
/// @notice The v2 treasury, pointed at the v2 coin.
///
/// Everything is inherited. `collect` turns what the escrow holds into dollars, pays the team its share and
/// earmarks the rest; `buy` spends a tranche of the earmark on the coin, through its name's market and then its
/// own pool, and burns what it bought. The burn share only ratchets up, under the factory owner's proposals.
///
/// Two things are its own. The official coin is fixed at construction rather than read from FUN's first launch,
/// so the buys land on HOLY priced in COW. And this treasury is also HOLY's creator-fee recipient, so it receives
/// HOLY itself: the creator's share of the coin side of every pool fee, credited to it by the locker. A coin is
/// not converted, it is burned, and `burnCoin` does that for whatever has arrived. HOLY must never be passed to
/// `collect`: the base treasury forwards an asset it cannot convert to the team wallet, and that is not where the
/// coin side belongs.
contract BuybackTreasuryHoly is BuybackTreasuryV2 {
    using SafeERC20 for IERC20;

    /// @notice The coin every buy lands on, and burns.
    address public immutable coin;
    /// @notice The name the coin is priced in: a fixed-inventory market, bought with dollars on the way to the coin.
    address public immutable name;
    /// @notice Coin received as the creator's share and burned by `burnCoin`, in addition to what buys burn.
    uint256 public totalCoinBurned;

    event CoinBurned(uint256 amount, address indexed caller);

    error NotACoin(address coin);
    error NotThisTreasury();

    constructor(
        IFactory factory_,
        IFeeEscrow escrow_,
        LaunchSeeder seeder_,
        IERC20 usdg_,
        address teamWallet_,
        IQuoteKind quoteRegistry_,
        MarketTickerDeployer marketIssuer_,
        address coin_,
        address name_
    ) BuybackTreasuryV2(factory_, escrow_, seeder_, usdg_, teamWallet_, quoteRegistry_, marketIssuer_) {
        // the coin has to be a launch of this factory, priced in the name given, or nothing here can size a buy
        if (!factory_.getLaunchedToken(coin_).exists || factory_.getLaunchedToken(coin_).pairToken != name_) revert NotACoin(coin_);
        coin = coin_;
        name = name_;
    }

    /// @inheritdoc BuybackTreasuryV2
    function official() public view override returns (address, address) {
        return (coin, name);
    }

    /// @notice Burn the coin this treasury holds: what the escrow credited it as the creator's share, and anything
    /// sent here directly. Anyone may call.
    function burnCoin() external nonReentrant returns (uint256 burned) {
        if (escrow.balanceOfToken(address(this), coin) > 0) escrow.claimToken(coin);
        burned = IERC20(coin).balanceOf(address(this));
        if (burned == 0) return 0;
        IERC20(coin).safeTransfer(DEAD, burned);
        totalCoinBurned += burned;
        emit CoinBurned(burned, msg.sender);
    }

    /// @notice The coin waiting to be burned: credited in the escrow, or already here.
    function pendingCoin() external view returns (uint256) {
        return escrow.balanceOfToken(address(this), coin) + IERC20(coin).balanceOf(address(this));
    }
}
