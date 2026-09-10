// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IQuoteKind} from "./IQuoteKind.sol";
import {MarketTickerDeployer} from "./MarketTickerDeployer.sol";

interface ITickerLauncherLike {
    /// @notice The live launcher's own record of every wrapper it has created.
    function isTicker(address token) external view returns (bool);
}

/// @title QuoteRegistry
/// @notice The one authority on what kind of quote asset an address is. Every component reads this rather than
/// sniffing selectors or trusting a symbol.
///
/// A kind is never asserted by a caller. It is **proved** from the record of the issuer that created the token:
/// `TickerLauncher.isTicker` for a legacy wrapper, `MarketTickerDeployer.market` for a fixed-inventory name.
/// Anyone may therefore register anything, because registering something the issuers do not recognise is
/// impossible. That removes three problems at once:
///
/// - the live `TickerLauncher` does not know this registry exists and cannot be changed to call it, yet every
///   wrapper it has made or will make is recognisable, so no seeding and no impersonation is needed
/// - an issuer's permission is not mistaken for a token's provenance
/// - there is no owner, and so no owner mistake
///
/// A kind, once written, never changes. A coin launched against a legacy wrapper must still read as legacy in
/// five years, whatever else has been deployed since.
contract QuoteRegistry is IQuoteKind {
    /// @notice The live launcher whose `isTicker` proves a legacy wrapper.
    ITickerLauncherLike public immutable legacyIssuer;
    /// @notice The deployer whose `market` proves a fixed-inventory name.
    MarketTickerDeployer public immutable marketIssuer;
    /// @notice The counter asset, USDG, which needs no conversion and can never be registered as anything else.
    address public immutable counter;

    mapping(address => Kind) private _kind;

    event QuoteRecorded(address indexed token, Kind kind, address indexed by);

    error ZeroAddress();
    error NotAContract(address token);
    error IsTheCounter(address token);
    error AlreadyRecorded(address token, Kind existing);
    error UnknownProvenance(address token);

    constructor(ITickerLauncherLike legacyIssuer_, MarketTickerDeployer marketIssuer_, address counter_) {
        if (address(legacyIssuer_) == address(0) || address(marketIssuer_) == address(0) || counter_ == address(0)) {
            revert ZeroAddress();
        }
        if (counter_.code.length == 0) revert NotAContract(counter_);
        legacyIssuer = legacyIssuer_;
        marketIssuer = marketIssuer_;
        counter = counter_;
    }

    /// @inheritdoc IQuoteKind
    function kindOf(address token) external view returns (Kind) {
        if (token == counter) return Kind.COUNTER_ASSET;
        return _kind[token];
    }

    /// @notice What the issuers say `token` is, without writing anything. `UNKNOWN` means neither claims it.
    /// @inheritdoc IQuoteKind
    function provenanceOf(address token) public view returns (Kind) {
        if (token == counter) return Kind.COUNTER_ASSET;
        if (token == address(0) || token.code.length == 0) return Kind.UNKNOWN;
        // an issuer that reverts, or that is not what we think it is, means "not claimed by this one" rather
        // than a broken registry: classification must keep working for the other generation
        try legacyIssuer.isTicker(token) returns (bool yes) {
            if (yes) return Kind.LEGACY_REDEEMABLE_WRAPPER;
        } catch {
            // not claimed
        }
        try marketIssuer.market(token) returns (MarketTickerDeployer.Market memory m) {
            if (m.token == token) return Kind.FIXED_INVENTORY_MARKET;
        } catch {
            // not claimed
        }
        return Kind.UNKNOWN;
    }

    /// @notice Records `token`'s kind, proved from its issuer. Callable by anyone; refuses anything unproven.
    function record(address token) external returns (Kind kind) {
        if (token == address(0)) revert ZeroAddress();
        if (token == counter) revert IsTheCounter(token);
        if (token.code.length == 0) revert NotAContract(token);
        Kind existing = _kind[token];
        if (existing != Kind.UNKNOWN) revert AlreadyRecorded(token, existing);

        kind = provenanceOf(token);
        if (kind != Kind.LEGACY_REDEEMABLE_WRAPPER && kind != Kind.FIXED_INVENTORY_MARKET) {
            revert UnknownProvenance(token);
        }
        _kind[token] = kind;
        emit QuoteRecorded(token, kind, msg.sender);
    }

    /// @notice Records several at once, for convenience. Each is proved individually.
    function recordMany(address[] calldata tokens) external {
        for (uint256 i; i < tokens.length; ++i) {
            this.record(tokens[i]);
        }
    }
}
