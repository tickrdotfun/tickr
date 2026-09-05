// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

struct LaunchConfig {
    uint256 supply;
    uint256 baseFeeBps; // the pool's base LP fee, before the creator's tax; 100 = 1%
    uint256 phantomQuote; // opening market cap in native ETH, raw units; ERC-20 pairs use pairTokenEconomics
    int24 tickSpacing;
    bool enabled;
}

struct Socials {
    string twitter;
    string telegram;
    string discord;
    string website;
    string farcaster;
}

struct TokenParams {
    string name;
    string symbol;
    string logo;
    string description;
    Socials socials;
    address creatorFeeRecipient;
    uint16 creatorTaxBps;
    bool buybackEnabled;
    bytes32 expectedEconomics;
    bytes32 salt;
}

struct FeePolicy {
    address protocolFeeRecipient;
    uint16 creatorShareBps;
    uint16 clubShareBps;
    uint16 protocolShareBps;
    uint16 buybackBurnBps;
    address club; // the club this launch pays its club share to, frozen at launch; zero when there is none
    uint16 hookFeeBps; // the base LP fee the split applies to, in bps, copied from the config at launch
    uint16 maxInternalPriceImpactBps;
}

/// @notice Everything the factory remembers about a launch. The pool exists from the launch transaction on.
struct LaunchedToken {
    address token;
    address deployer;
    address creatorFeeRecipient;
    address pairToken; // address(0) = native ETH
    uint256 phantomQuote; // the virtual quote reserve the position opens with, raw units of the pair
    uint24 poolFee; // the pool's LP fee in pips: (base + creator tax) * 100
    int24 tickSpacing;
    int24 tickLower;
    int24 tickUpper;
    uint128 liquidity;
    uint256 lpTokenId;
    uint16 creatorTaxBps;
    bool buybackEnabled;
    uint64 launchedAt;
    bool exists;
}

/// @notice The economics of a pair: the virtual quote reserve a launch opens with, in the pair's own units.
struct PairEconomics {
    uint256 phantomQuote;
    uint8 decimals;
}
