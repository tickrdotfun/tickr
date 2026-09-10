// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fork} from "./Fork.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IQuoteKind} from "../src/market/IQuoteKind.sol";
import {QuoteRegistry, ITickerLauncherLike} from "../src/market/QuoteRegistry.sol";
import {QuoteConverter} from "../src/market/QuoteConverter.sol";
import {FeeSettings} from "../src/market/FeeSettings.sol";
import {BuybackTreasuryV2} from "../src/market/BuybackTreasuryV2.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {IFeeEscrow} from "../src/interfaces/IFeeEscrow.sol";
import {LaunchSeeder} from "../src/LaunchSeeder.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Something the registry can prove nothing about: no launcher made it, no deployer made it.
contract StrangeToken is ERC20 {
    constructor() ERC20("Strange", "STRANGE") {
        _mint(msg.sender, 1_000e6);
    }
}

/// @dev The real treasury's three conversion sites, made version aware, against the live contracts. The legacy
/// paths must behave exactly as they do today; the fixed-inventory paths must swap under the owner's policy and
/// credit only what arrived.
contract BuybackTreasuryV2ForkTest is Test {
    address constant FACTORY = 0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f;
    address constant ESCROW = 0xCf706542a17ee6C0Cc9595E3f49d9131aF3331ba;
    address constant SEEDER = 0x3733576410312D34B53F90cFE513B0D0995aB6Ca;
    address constant LIVE_TICKER_LAUNCHER = 0x7f6c8bA781b5bDC499F2BA7501A2178508877649;
    address constant MARKET_DEPLOYER = 0x0F72C545Bd455DB7184F5B0eA4725f5AA8494418;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant FUN = 0xF9d30A05A63d795e3eF37b34143f33b2cBEf0f14;
    address constant TESTNAME = 0x4Dd89f107d9b8395237719FA9d621a7A5BC00c52;
    address constant TEAM = address(0x7EA1);
    uint256 constant Q96 = 1 << 96;

    BuybackTreasuryV2 t;
    QuoteRegistry reg;
    address owner;
    bool forked;

    function setUp() public {
        if (!Fork.select()) return;
        forked = true;
        owner = IFactory(FACTORY).owner();
        reg = new QuoteRegistry(ITickerLauncherLike(LIVE_TICKER_LAUNCHER), MarketTickerDeployer(MARKET_DEPLOYER), USDG);
        t = new BuybackTreasuryV2(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            reg, MarketTickerDeployer(MARKET_DEPLOYER)
        );
    }

    function terms(uint256 pct, uint256 ahead) internal view returns (QuoteConverter.Terms memory) {
        return QuoteConverter.Terms({minOutPerInX96: (Q96 * pct) / 100, deadline: block.timestamp + ahead});
    }

    function one(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function oneTerm(QuoteConverter.Terms memory x) internal pure returns (QuoteConverter.Terms[] memory r) {
        r = new QuoteConverter.Terms[](1);
        r[0] = x;
    }

    // ---------------------------------------------------------------- the terms policy

    /// @notice A caller cannot bring its own weak floor. Without a policy the conversion is refused outright.
    /// @notice A name with no floor of its own is held to the default, not left unprotected and not refused.
    ///
    /// This asserted `NoPolicy` before the default existed. Refusing outright was safe but it meant an owner
    /// transaction per launch, and a missed one stopped the allocation silently. The protection is unchanged:
    /// terms this weak are still refused, now against the frozen policy rather than against nothing.
    function test_fork_aFixedInventoryConversionIsHeldToTheDefaultPolicy() public {
        if (!forked) return;
        reg.record(TESTNAME);
        deal(TESTNAME, address(t), 100e6);
        assertEq(t.minRateToCounterX96(TESTNAME), 0, "no floor was set for this name");
        assertEq(t.defaultMinRateToCounterX96(), FeeSettings.MIN_RATE_NAME_TO_COUNTER_X96, "so the frozen one applies");

        vm.expectRevert(
            abi.encodeWithSelector(
                BuybackTreasuryV2.TermsWeakerThanPolicy.selector, TESTNAME, (Q96 * 1) / 100, FeeSettings.MIN_RATE_NAME_TO_COUNTER_X96
            )
        );
        t.checkTerms(TESTNAME, true, terms(1, 60));

        // and terms that meet the frozen floor are accepted with no setup at all. The floor is 99% of par,
        // not par: a pool charges a fee, so demanding par exactly would refuse every real swap
        QuoteConverter.Terms memory ok = t.checkTerms(TESTNAME, true, terms(99, 60));
        assertGe(ok.minOutPerInX96, FeeSettings.MIN_RATE_NAME_TO_COUNTER_X96);
    }

    /// @notice And a caller may be stricter than the policy, never weaker.
    function test_fork_aCallerMayNotOfferWorseTermsThanThePolicy() public {
        if (!forked) return;
        reg.record(TESTNAME);
        vm.prank(owner);
        t.setMinRate(TESTNAME, true, (Q96 * 90) / 100);
        deal(TESTNAME, address(t), 100e6);

        vm.expectRevert(
            abi.encodeWithSelector(BuybackTreasuryV2.TermsWeakerThanPolicy.selector, TESTNAME, (Q96 * 50) / 100, (Q96 * 90) / 100)
        );
        t.checkTerms(TESTNAME, true, terms(50, 60));

        // stricter is fine, and it is the caller's stricter terms that are used
        QuoteConverter.Terms memory used = t.checkTerms(TESTNAME, true, terms(95, 60));
        assertEq(used.minOutPerInX96, (Q96 * 95) / 100, "the caller's stricter floor is what applies");
    }

    /// @notice A deadline further ahead than the window is refused, so an old authorisation cannot be replayed.
    function test_fork_aDeadlineBeyondTheWindowIsRefused() public {
        if (!forked) return;
        reg.record(TESTNAME);
        vm.prank(owner);
        t.setMinRate(TESTNAME, true, (Q96 * 90) / 100);
        deal(TESTNAME, address(t), 100e6);
        vm.expectPartialRevert(BuybackTreasuryV2.DeadlineTooFar.selector);
        t.checkTerms(TESTNAME, true, terms(95, 2 hours));
    }

    function test_fork_onlyTheOwnerSetsThePolicy() public {
        if (!forked) return;
        vm.prank(address(0xbad));
        vm.expectRevert(BuybackTreasuryV2.NotOwner.selector);
        t.setMinRate(TESTNAME, true, Q96);
    }

    // ---------------------------------------------------------------- collect

    /// @notice The legacy path through the real `collect` is unchanged: a wrapper redeems at par, and the whole
    /// balance becomes dollars split between the team and the earmark.
    function test_fork_collectRedeemsALegacyWrapperExactly() public {
        if (!forked) return;
        reg.record(FUN);
        deal(FUN, address(t), 1_000e6);
        (uint256 total, uint256 toTeam, uint256 earmarked) = t.collect(one(FUN), oneTerm(terms(99, 60)));
        assertEq(total, 1_000e6, "a wrapped dollar is still exactly a dollar");
        assertEq(toTeam + earmarked, total);
        assertEq(IERC20(USDG).balanceOf(TEAM), toTeam);
        assertEq(t.earmarkedUsdg(), earmarked);
    }

    /// @notice The fixed-inventory path through the real `collect` credits only what arrived, and what the market
    /// could not take stays as the name rather than going to the team as unconvertible.
    function test_fork_collectSwapsAFixedInventoryNameAndCreditsOnlyWhatArrived() public {
        if (!forked) return;
        reg.record(TESTNAME);
        vm.prank(owner);
        t.setMinRate(TESTNAME, true, (Q96 * 50) / 100);
        deal(TESTNAME, address(t), 5_000e6);

        (uint256 total,,) = t.collect(one(TESTNAME), oneTerm(terms(50, 60)));
        console.log("dollars recognised / name still held");
        console.log(total);
        console.log(IERC20(TESTNAME).balanceOf(address(t)));
        assertGt(total, 0, "something converted");
        assertLt(total, 5_000e6, "and not at par: it is a market");
        assertGt(IERC20(TESTNAME).balanceOf(address(t)), 0, "the rest is still ours");
        assertEq(IERC20(TESTNAME).balanceOf(TEAM), 0, "and was never forwarded as unconvertible");
    }

    /// @notice A refusal on one asset must not lose or misclassify another.
    function test_fork_aRefusalOnOneAssetLeavesTheOthersIntact() public {
        if (!forked) return;
        reg.record(FUN);
        reg.record(TESTNAME);
        // no policy for TESTNAME, so its conversion is refused
        deal(FUN, address(t), 400e6);
        deal(TESTNAME, address(t), 300e6);

        address[] memory both = new address[](2);
        both[0] = TESTNAME;
        both[1] = FUN;
        QuoteConverter.Terms[] memory ts = new QuoteConverter.Terms[](2);
        ts[0] = terms(50, 60);
        ts[1] = terms(99, 60);

        (uint256 total,,) = t.collect(both, ts);
        assertEq(total, 400e6, "the wrapper converted in full");
        assertEq(IERC20(TESTNAME).balanceOf(address(t)), 300e6, "the refused name is untouched and still ours");
        assertEq(IERC20(TESTNAME).balanceOf(TEAM), 0, "and not forwarded");
    }

    // ---------------------------------------------------------------- provenance before forwarding

    /// @notice A real fixed-inventory name that nobody has registered yet is held, not handed to the team. The
    /// registry can prove the deployer made it, so it is ours whether or not anyone has recorded it.
    /// @notice An unregistered but genuine market records itself and converts, and never reaches the team.
    ///
    /// This used to assert that the balance was held. Holding was the safe half of the answer; it was not the
    /// whole one, because the revenue then sat there until somebody remembered a transaction. The registry is
    /// permissionless and decides by provenance, so recording it here proves nothing the registry would not
    /// have checked anyway. The property that must survive is the one below: it is never given away.
    function test_fork_anUnregisteredButGenuineMarketRecordsItselfAndConverts() public {
        if (!forked) return;
        assertEq(uint256(reg.kindOf(TESTNAME)), uint256(IQuoteKind.Kind.UNKNOWN), "not registered");
        assertEq(uint256(reg.provenanceOf(TESTNAME)), uint256(IQuoteKind.Kind.FIXED_INVENTORY_MARKET), "but genuine");
        deal(TESTNAME, address(t), 900e6);

        (uint256 total,,) = t.collect(one(TESTNAME), oneTerm(terms(99, 60)));

        assertGt(total, 0, "it converted with no registration and no floor set by hand");
        assertEq(uint256(reg.kindOf(TESTNAME)), uint256(IQuoteKind.Kind.FIXED_INVENTORY_MARKET), "and is now recorded");
        assertEq(IERC20(TESTNAME).balanceOf(TEAM), 0, "and none of it went to the team");
    }

    /// @notice The same balance is still held, not forwarded, when the terms are refused.
    function test_fork_aGenuineMarketIsHeldWhenTermsAreRefused() public {
        if (!forked) return;
        deal(TESTNAME, address(t), 900e6);
        (uint256 total,,) = t.collect(one(TESTNAME), oneTerm(terms(50, 60)));
        assertEq(total, 0, "terms under the floor convert nothing");
        assertEq(IERC20(TESTNAME).balanceOf(address(t)), 900e6, "all of it is still ours");
        assertEq(IERC20(TESTNAME).balanceOf(TEAM), 0, "and none of it went to the team");
    }

    /// @notice And once someone records it, the same balance converts. Registration is the only thing that was
    /// missing; the balance was never at risk in the meantime.
    /// @notice A name needs no unblocking: the first collect is the one that converts it.
    function test_fork_theFirstCollectConvertsWithNoSetupAtAll() public {
        if (!forked) return;
        assertEq(uint256(reg.kindOf(TESTNAME)), uint256(IQuoteKind.Kind.UNKNOWN), "nobody recorded it");
        assertEq(t.minRateToCounterX96(TESTNAME), 0, "and nobody set a floor for it");
        deal(TESTNAME, address(t), 900e6);
        (uint256 total,,) = t.collect(one(TESTNAME), oneTerm(terms(99, 60)));
        assertGt(total, 0, "the very first collect converted it");
    }

    /// @notice A token with no provenance at all is still forwarded. Holding is for assets the registry can vouch
    /// for; anything else would accumulate here forever.
    function test_fork_aTokenWithNoProvenanceIsStillForwarded() public {
        if (!forked) return;
        StrangeToken s = new StrangeToken();
        s.transfer(address(t), 1_000e6);

        vm.expectEmit(true, false, false, true, address(t));
        emit BuybackTreasuryV2.Forwarded(address(s), 1_000e6);
        (uint256 total,,) = t.collect(one(address(s)), oneTerm(terms(50, 60)));

        assertEq(total, 0);
        assertEq(s.balanceOf(TEAM), 1_000e6, "it went to the team as before");
        assertEq(s.balanceOf(address(t)), 0);
    }
}
