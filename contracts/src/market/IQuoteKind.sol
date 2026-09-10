// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IQuoteKind
/// @notice How every component decides what a quote asset is, and therefore how to convert it.
///
/// Two generations of invented name now exist and they behave differently in the one way that matters:
///
/// - `LEGACY_REDEEMABLE_WRAPPER` is a `ManagedTickerToken`. One unit is exactly one USDG, by `mint` and `redeem`,
///   for any size, with no fee and no price impact. Thirteen live coins are priced in one of these.
/// - `FIXED_INVENTORY_MARKET` is a `MarketTickerToken`. It has no mint and no redeem. It is worth what its USDG
///   pool will pay, which is near a dollar while that pool has inventory. Converting it is a swap: it has a fee,
///   a price, a minimum output and a finite depth.
///
/// Confusing the two is the failure this interface exists to prevent. Calling `redeem` on a fixed-inventory name
/// reverts, which is survivable. Treating a swapped amount as if it were exact is not: it silently mis-states
/// backing, club pots and treasury balances.
///
/// ## The rules every component follows
///
/// 1. **Classification is by address, never by symbol, name or the presence of a selector.** Old FUN and a new
///    FUN would be different assets with the same ticker. A registry keyed on the token address is the only
///    authority, and it is written at creation by the deployer that made the token.
/// 2. **Never infer the kind from a successful call.** A contract can implement `redeem` and mean something else
///    by it. `UNKNOWN` is a refusal, not a default to the legacy path.
/// 3. **An unsupported asset is rejected, loudly.** No component guesses, falls back, or skips the asset and
///    carries on with the rest; a failure to convert one asset must not lose or misclassify another.
/// 4. **Legacy behaviour is preserved exactly.** A live wrapper keeps mint and redeem, keeps its exactness
///    assumptions, and keeps its accounting. Nothing in the new path may change what an existing coin does.
/// 5. **A fixed-inventory conversion is a protected swap.** A minimum output from a fresh quote, a deadline, and
///    the actual received amount used afterwards, never the amount sent.
interface IQuoteKind {
    enum Kind {
        /// @dev Not a quote asset this deployment knows. Always a refusal.
        UNKNOWN,
        /// @dev A `ManagedTickerToken`: exact mint and redeem against USDG.
        LEGACY_REDEEMABLE_WRAPPER,
        /// @dev A `MarketTickerToken`: a fixed issuance traded in an ordinary USDG pool.
        FIXED_INVENTORY_MARKET,
        /// @dev USDG itself, or another asset that needs no conversion at all.
        COUNTER_ASSET
    }

    /// @notice What kind of quote asset `token` is, by address, as recorded.
    function kindOf(address token) external view returns (Kind);

    /// @notice What the issuers say `token` is, whether or not it has been recorded yet. A component that is
    /// about to treat an asset as unsupported must consult this first: a market created five minutes ago is
    /// legitimate and simply has not been registered, and forwarding it as unconvertible would give away an
    /// asset that a later registration would have converted.
    function provenanceOf(address token) external view returns (Kind);
}
