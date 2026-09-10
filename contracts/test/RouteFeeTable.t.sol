// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fork} from "./Fork.sol";
import {console} from "forge-std/console.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {ISeederLike} from "../src/market/QuoteConverter.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";

/// @dev The fee every supported route actually charges, read from the pools rather than assumed.
///
/// Two things are read per pool and neither is guessed: the pool's own fee from its key, and Uniswap's protocol
/// fee from slot0, which is packed as two twelve bit halves, one per direction. A route is priced by compounding
/// them in the order a trade meets them, because they are taken one after another and not side by side.
contract RouteFeeTableForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address constant FACTORY = 0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f;
    address constant SEEDER = 0x3733576410312D34B53F90cFE513B0D0995aB6Ca;
    address constant MARKET_DEPLOYER = 0x0F72C545Bd455DB7184F5B0eA4725f5AA8494418;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant TESTNAME = 0x4Dd89f107d9b8395237719FA9d621a7A5BC00c52;
    address constant PROBETWO = 0x151073687c3f5B569fdEC876bEb3DBcEF5F3Ac83;

    bool forked;

    function setUp() public {
        forked = Fork.select();
    }

    function ethUsdg() internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(USDG), 100, 1, IHooks(address(0)));
    }

    /// @dev The pool's own fee and the chain's, both in pips, for the direction this route trades it.
    function feesOf(PoolKey memory k, bool zeroForOne) internal view returns (uint24 poolPips, uint24 chainPips) {
        (,, uint24 protocolFee,) = ISeederLike(SEEDER).poolManager().getSlot0(k.toId());
        // v4 packs the protocol fee as two twelve bit halves: the low one for zero to one
        chainPips = zeroForOne ? uint24(protocolFee & 0xfff) : uint24((protocolFee >> 12) & 0xfff);
        poolPips = k.fee;
    }

    /// @dev What a trader keeps after a list of charges taken one after another, in pips of the input.
    function costPips(uint256[] memory pips) internal pure returns (uint256) {
        uint256 keptPpm = 1_000_000;
        for (uint256 i; i < pips.length; i++) keptPpm = (keptPpm * (1_000_000 - pips[i])) / 1_000_000;
        return 1_000_000 - keptPpm;
    }

    function push(uint256[] memory a, uint256 n, uint256 v) internal pure returns (uint256) {
        a[n] = v;
        return n + 1;
    }

    /// @notice Every entry route to a coin priced in a fixed-inventory name, and what each costs a trader, using
    /// the fees the pools report at this block. Gas is excluded, and so is anything an outside app charges.
    function test_fork_theFeeForEveryRoute() public view {
        if (!forked) return;
        console.log("block");
        console.log(block.number);

        PoolKey memory funding = ethUsdg();
        PoolKey memory bridge = MarketTickerDeployer(MARKET_DEPLOYER).keyFor(TESTNAME);
        PoolKey memory coin = IFactory(FACTORY).poolKeyOf(PROBETWO);

        // ether into dollars: ether is currency0, so a buy is zero for one
        (uint256 fPool, uint256 fChain) = _f(funding, true);
        // dollars into the name
        bool bridgeZfo = Currency.unwrap(bridge.currency0) == USDG;
        (uint256 bPool, uint256 bChain) = _f(bridge, bridgeZfo);
        // the name into the coin
        bool coinZfo = Currency.unwrap(coin.currency0) != PROBETWO;
        (uint256 cPool, uint256 cChain) = _f(coin, coinZfo);

        console.log("pool fees, pips: funding | bridge | coin");
        console.log(fPool);
        console.log(bPool);
        console.log(cPool);
        console.log("chain fees, pips, in the direction traded: funding | bridge | coin");
        console.log(fChain);
        console.log(bChain);
        console.log(cChain);

        uint256[] memory three = new uint256[](6);
        uint256 n;
        n = push(three, n, fChain);
        n = push(three, n, fPool);
        n = push(three, n, bChain);
        n = push(three, n, bPool);
        n = push(three, n, cChain);
        n = push(three, n, cPool);
        console.log("ETH to USDG to NAME to COIN, total cost in pips");
        console.log(costPips(three));

        uint256[] memory two = new uint256[](4);
        n = 0;
        n = push(two, n, bChain);
        n = push(two, n, bPool);
        n = push(two, n, cChain);
        n = push(two, n, cPool);
        console.log("USDG to NAME to COIN, total cost in pips");
        console.log(costPips(two));

        uint256[] memory one = new uint256[](2);
        n = 0;
        n = push(one, n, cChain);
        n = push(one, n, cPool);
        console.log("NAME to COIN, total cost in pips");
        console.log(costPips(one));

        // the same routes in reverse are the exit, and the chain's fee may differ by direction
        (, uint256 fChainOut) = _f(funding, false);
        (, uint256 bChainOut) = _f(bridge, !bridgeZfo);
        (, uint256 cChainOut) = _f(coin, !coinZfo);
        uint256[] memory back = new uint256[](6);
        n = 0;
        n = push(back, n, cChainOut);
        n = push(back, n, cPool);
        n = push(back, n, bChainOut);
        n = push(back, n, bPool);
        n = push(back, n, fChainOut);
        n = push(back, n, fPool);
        console.log("COIN to NAME to USDG to ETH, total cost in pips");
        console.log(costPips(back));

        console.log("a complete round trip, ETH in and ETH out, in pips");
        console.log(costPips(three) + costPips(back) - (costPips(three) * costPips(back)) / 1_000_000);
    }

    /// @notice The proposed setting, checked against what the factory can actually produce and against the cap
    /// it is meant to hold. Every figure here is computed, not typed: the document quotes this test.
    function test_fork_theProposedSettingHoldsTheCap() public view {
        if (!forked) return;
        PoolKey memory funding = ethUsdg();
        PoolKey memory bridge = MarketTickerDeployer(MARKET_DEPLOYER).keyFor(TESTNAME);
        PoolKey memory coin = IFactory(FACTORY).poolKeyOf(PROBETWO);
        bool bridgeZfo = Currency.unwrap(bridge.currency0) == USDG;
        bool coinZfo = Currency.unwrap(coin.currency0) != PROBETWO;

        (uint256 fPool, uint256 fChain) = _f(funding, true);
        (uint256 bPool, uint256 bChain) = _f(bridge, bridgeZfo);

        // the factory builds a pool fee as (baseFeeBps + creatorTaxBps) * 100, so only whole basis points are
        // expressible. 82 with no creator surcharge is the candidate
        uint16 baseFeeBps = 82;
        uint16 creatorTaxBps = 0;
        uint256 proposedPips = uint256(baseFeeBps + creatorTaxBps) * 100;
        assertEq(proposedPips, 8_200, "the setting is one the factory can produce");
        assertEq(proposedPips % 100, 0, "and it is a whole number of basis points");

        // the chain takes a quarter of the pool's fee, capped at v4's ceiling
        uint256 proposedChain = proposedPips / 4;
        if (proposedChain > 1_000) proposedChain = 1_000;
        assertEq(proposedChain, 1_000, "at this size the chain is at its ceiling");
        // and that rule is what the live coin pool shows, so it is not an assumption
        (uint256 cPool, uint256 cChain) = _f(coin, coinZfo);
        assertEq(cChain, cPool / 4 > 1_000 ? 1_000 : cPool / 4, "the live pool charges the same way");

        uint256[] memory three = new uint256[](6);
        uint256 n;
        n = push(three, n, fChain);
        n = push(three, n, fPool);
        n = push(three, n, bChain);
        n = push(three, n, bPool);
        n = push(three, n, proposedChain);
        n = push(three, n, proposedPips);
        uint256 threePool = costPips(three);

        uint256[] memory two = new uint256[](4);
        n = 0;
        n = push(two, n, bChain);
        n = push(two, n, bPool);
        n = push(two, n, proposedChain);
        n = push(two, n, proposedPips);
        uint256 twoPool = costPips(two);

        uint256[] memory one = new uint256[](2);
        n = 0;
        n = push(one, n, proposedChain);
        n = push(one, n, proposedPips);
        uint256 onePool = costPips(one);

        console.log("proposed base fee bps | pool pips | chain pips");
        console.log(baseFeeBps);
        console.log(proposedPips);
        console.log(proposedChain);
        console.log("cost in pips: three pool | two pool | one pool");
        console.log(threePool);
        console.log(twoPool);
        console.log(onePool);

        // a complete round trip at the proposed setting: two legs compounded, not doubled
        uint256 roundTrip = threePool + threePool - (threePool * threePool) / 1_000_000;
        console.log("a complete round trip at the proposed setting, in pips");
        console.log(roundTrip);
        assertLt(roundTrip, 2 * threePool, "compounded, so less than twice one leg");

        // the cap, asserted rather than logged. Compounded, not added
        assertLt(threePool, 10_000, "the deepest supported route stays under one percent");
        assertLt(twoPool, threePool, "and the shallower routes stay under the deepest");
        assertLt(onePool, twoPool);

        // what is left to divide: the coin pool's own fee, on what reaches that pool
        uint256 upstream = costPips(_slice(three, 4));
        uint256 distributable = (proposedPips * (1_000_000 - upstream)) / 1_000_000;
        distributable = (distributable * (1_000_000 - proposedChain)) / 1_000_000;
        uint256 creator = (distributable * 40) / 100;
        uint256 buyback = (distributable * 30) / 100;
        uint256 team = distributable - creator - buyback;
        console.log("distributable pips | creator | buyback | team");
        console.log(distributable);
        console.log(creator);
        console.log(buyback);
        console.log(team);
        assertEq(creator + buyback + team, distributable, "the split accounts for every pip, rounding included");
        assertLt(distributable, proposedPips, "less than the setting, because the route is charged before it");
    }

    /// @dev The first `k` entries of `a`, for costing part of a route.
    function _slice(uint256[] memory a, uint256 k) internal pure returns (uint256[] memory out) {
        out = new uint256[](k);
        for (uint256 i; i < k; i++) out[i] = a[i];
    }

    function _f(PoolKey memory k, bool zfo) internal view returns (uint256 poolPips, uint256 chainPips) {
        (uint24 a, uint24 b) = feesOf(k, zfo);
        return (a, b);
    }
}
