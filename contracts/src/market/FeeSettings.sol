// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title FeeSettings
/// @notice The frozen fee configuration, in one place, so a deployment and a test cannot drift apart.
///
/// These are the settings the accounting milestone closed on. Everything here is expressible: the factory builds
/// a pool fee as `(baseFeeBps + creatorTaxBps) * 100`, so only whole basis points exist, and 82 with no surcharge
/// is one of them.
///
/// The floors matter as much as the shares. A treasury's conversion is callable by anyone, so the floor is what
/// stops a caller selling the protocol's revenue cheaply, and it belongs in the deployment rather than in
/// whatever a caller happens to offer. **These are the intended live floors.** A test that wants a conversion
/// never refused for policy should say so where it does it, not lower these.
library FeeSettings {
    /// @notice The coin's pool fee, in basis points. 8,200 pips once the factory multiplies it.
    uint16 internal constant BASE_FEE_BPS = 82;
    /// @notice No surcharge on top. The creator's share comes out of the total, not in addition to it.
    uint16 internal constant CREATOR_TAX_BPS = 0;

    // No fee shares here. How a coin pool's fee is divided is the factory's default policy, frozen into each coin
    // at its launch, and nothing in this library sets or describes it. Live since the market release: 5000 / 1000 /
    // 4000 (creator / club / protocol), which a coin without a club, as every coin under a fixed-inventory name is,
    // freezes as 6000 / 0 / 4000. This library once carried a 4000 / 0 / 6000 split that was proposed and not
    // adopted; it was removed so that no script could install it by reading it from here.

    uint256 internal constant Q96 = 1 << 96;

    /// @notice Selling a name for dollars: at least 99 cents on the dollar.
    ///
    /// A name's market opens at parity and cannot sell a name below a dollar, so a conversion in a working
    /// market returns par less that pool's own fee and a tick of movement. 99% leaves room for exactly that and
    /// nothing else. Measured: a real conversion returned 99.94%.
    uint256 internal constant MIN_RATE_NAME_TO_COUNTER_X96 = (Q96 * 99) / 100;

    /// @notice Buying a name with dollars: at least 99 hundredths of a name per dollar.
    ///
    /// The same bound from the other side. A market never sells a name below a dollar, so the most this can cost
    /// is the pool's fee and a tick.
    uint256 internal constant MIN_RATE_COUNTER_TO_NAME_X96 = (Q96 * 99) / 100;

    /// @notice What the trader pays on the deepest route these settings were measured against, in pips. Not a
    /// guarantee: it holds for those pools at their fees, and an outside app charges what it charges.
    uint256 internal constant MEASURED_DEEPEST_ROUTE_PIPS = 9_936;
}
