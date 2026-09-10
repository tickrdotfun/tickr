// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fork} from "./Fork.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IQuoteKind} from "../src/market/IQuoteKind.sol";
import {QuoteRegistry, ITickerLauncherLike} from "../src/market/QuoteRegistry.sol";
import {QuoteConverter, ISeederLike} from "../src/market/QuoteConverter.sol";
import {TreasuryConversion} from "../src/market/TreasuryConversion.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";

/// @dev Conversion and the treasury accounting around it, against the real contracts on a fork.
contract QuoteConverterForkTest is Test {
    address constant LIVE_TICKER_LAUNCHER = 0x7f6c8bA781b5bDC499F2BA7501A2178508877649;
    address constant MARKET_DEPLOYER = 0x0F72C545Bd455DB7184F5B0eA4725f5AA8494418;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant SEEDER = 0x3733576410312D34B53F90cFE513B0D0995aB6Ca;
    address constant FUN = 0xF9d30A05A63d795e3eF37b34143f33b2cBEf0f14;
    address constant TESTNAME = 0x4Dd89f107d9b8395237719FA9d621a7A5BC00c52;
    address constant TICKR = 0x51d553Efd2E8D772AEe6d602A9ea26C56c9a6942;
    address constant TEAM = address(0x7EA1);
    uint256 constant IMPACT = 300;
    uint256 constant Q96 = 1 << 96;

    QuoteRegistry reg;
    TreasuryConversion t;
    bool forked;

    function setUp() public {
        if (!Fork.select()) return;
        forked = true;
        reg = new QuoteRegistry(ITickerLauncherLike(LIVE_TICKER_LAUNCHER), MarketTickerDeployer(MARKET_DEPLOYER), USDG);
        t = new TreasuryConversion(reg, MarketTickerDeployer(MARKET_DEPLOYER), ISeederLike(SEEDER), IERC20(USDG), TEAM);
    }

    /// @dev Terms a caller decides away from the transaction: a floor rate and an expiry.
    function terms(uint256 minOutPerIn, uint256 secondsAhead) internal view returns (QuoteConverter.Terms memory) {
        return QuoteConverter.Terms({minOutPerInX96: minOutPerIn, deadline: block.timestamp + secondsAhead});
    }

    /// @dev A rate floor of `pct` percent of par, for assets of equal decimals.
    function atPct(uint256 pct) internal pure returns (uint256) {
        return (Q96 * pct) / 100;
    }

    // ---------------------------------------------------------------- terms

    function test_fork_aSwapWithoutTermsIsRefused() public {
        if (!forked) return;
        reg.record(TESTNAME);
        deal(TESTNAME, address(t), 100e6);
        vm.expectRevert(QuoteConverter.NoTerms.selector);
        t.convertStrict(TESTNAME, 100e6, IMPACT, QuoteConverter.Terms({minOutPerInX96: 0, deadline: block.timestamp + 60}));
    }

    function test_fork_expiredTermsAreRefused() public {
        if (!forked) return;
        reg.record(TESTNAME);
        deal(TESTNAME, address(t), 100e6);
        vm.expectRevert(abi.encodeWithSelector(QuoteConverter.TermsExpired.selector, block.timestamp - 1, block.timestamp));
        t.convertStrict(TESTNAME, 100e6, IMPACT, QuoteConverter.Terms({minOutPerInX96: atPct(50), deadline: block.timestamp - 1}));
    }

    /// @notice The rate the caller decided is enforced against what was actually spent, so a partial fill is held
    /// to the same standard as a full one. A floor above what the pool can pay is refused outright.
    function test_fork_aRateFloorAboveTheMarketIsRefused() public {
        if (!forked) return;
        reg.record(TESTNAME);
        deal(TESTNAME, address(t), 1_000e6);
        // the achieved rate is well under par, so a floor at 150% of par must be refused by name
        vm.expectPartialRevert(QuoteConverter.RateTooLow.selector);
        t.convertStrict(TESTNAME, 1_000e6, IMPACT, terms(atPct(150), 60));
    }

    // ---------------------------------------------------------------- legacy preserved

    function test_fork_legacyIsExactBothWays() public {
        if (!forked) return;
        reg.record(FUN);
        deal(FUN, address(t), 1_000e6);
        (uint256 out, uint256 used) = t.convertStrict(FUN, 1_000e6, IMPACT, terms(atPct(99), 60));
        assertEq(out, 1_000e6, "redeem is one for one");
        assertEq(used, 1_000e6);

        deal(USDG, address(t), 500e6);
        t.earmark(500e6);
        (uint256 minted, uint256 spent) = t.buy(FUN, 500e6, IMPACT, terms(atPct(99), 60));
        assertEq(minted, 500e6, "mint is one for one");
        assertEq(spent, 500e6);
        assertEq(t.earmarked(), 0, "and the whole earmark was used");
    }

    // ---------------------------------------------------------------- fixed inventory, both directions

    function test_fork_fixedInventorySellsAndOnlyWhatArrivedIsRecognised() public {
        if (!forked) return;
        reg.record(TESTNAME);
        deal(TESTNAME, address(t), 1_000e6);
        uint256 before = IERC20(USDG).balanceOf(address(t));
        (uint256 recognised, uint256 spent) = t.collectOne(TESTNAME, IMPACT, terms(atPct(90), 60));
        uint256 arrived = IERC20(USDG).balanceOf(address(t)) - before;
        console.log("sold / dollars in");
        console.log(spent);
        console.log(recognised);
        assertEq(recognised, arrived, "only what arrived is recognised");
        assertEq(t.totalRecognised(), arrived);
        assertLt(recognised, spent, "a swap costs a fee");
        assertEq(t.unconverted(TESTNAME), 1_000e6 - spent, "what did not convert is still ours and still counted");
    }

    function test_fork_fixedInventoryBuys() public {
        if (!forked) return;
        reg.record(TESTNAME);
        deal(USDG, address(t), 20e6);
        t.earmark(20e6);
        uint256 before = IERC20(TESTNAME).balanceOf(address(t));
        (uint256 got, uint256 spent) = t.buy(TESTNAME, 20e6, IMPACT, terms(atPct(90), 60));
        console.log("dollars spent / name bought");
        console.log(spent);
        console.log(got);
        assertGt(got, 0, "the buying direction must work, not only the selling one");
        assertEq(IERC20(TESTNAME).balanceOf(address(t)) - before, got, "and the reported amount is what arrived");
        assertEq(t.earmarked(), 20e6 - spent, "only what was spent leaves the earmark");
    }

    // ---------------------------------------------------------------- partial and zero fills

    /// @notice A partial fill spends only what it used, leaves the rest earmarked, and cannot pass for a
    /// completed buy.
    function test_fork_aPartialFillIsReportedAsPartial() public {
        if (!forked) return;
        reg.record(TESTNAME);
        // selling into the thin side: the market holds five hundred million name against a few dollars, so a
        // sale this size cannot complete and must report what it actually did
        deal(TESTNAME, address(t), 5_000e6);
        (uint256 recognised, uint256 spent) = t.collectOne(TESTNAME, IMPACT, terms(atPct(50), 60));
        console.log("asked / spent / recognised");
        console.log(uint256(5_000e6));
        console.log(spent);
        console.log(recognised);
        assertGt(recognised, 0, "it did convert something");
        assertLt(spent, 5_000e6, "but not all of it");
        assertEq(t.unconverted(TESTNAME), 5_000e6 - spent, "the rest is still ours and still counted");
        assertEq(IERC20(TESTNAME).balanceOf(address(t)), 5_000e6 - spent, "and still held");
    }

    /// @dev A market with a small issuance, so the pool can actually be exhausted at test sizes. The live
    /// deployer mints five hundred million over a range 0.3% wide, whose liquidity is enormous next to anything
    /// worth testing; this one mints a thousand.
    function _smallMarket(string memory symbol) internal returns (MarketTickerDeployer d, address name_) {
        MarketTickerDeployer live = MarketTickerDeployer(MARKET_DEPLOYER);
        d = new MarketTickerDeployer(
            address(this),
            IERC20(USDG),
            ISeederLike(SEEDER).poolManager(),
            live.posm(),
            live.permit2(),
            1_000e6, // a thousand units, not five hundred million
            live.fee(),
            live.spacing(),
            live.width()
        );
        (name_,) = d.create(keccak256(abi.encodePacked(symbol)), symbol, 6);
    }

    /// @notice A buy the market cannot fill completely spends only what it took, leaves the rest earmarked, and
    /// cannot pass for a completed buy. This is a real AMM partial fill: the market holds a thousand units and
    /// the caller asks for far more than that.
    function test_fork_anAmmPartialFillOnABuyIsReportedAsPartial() public {
        if (!forked) return;
        (MarketTickerDeployer d, address small) = _smallMarket("SMALLBUY");
        QuoteRegistry r2 = new QuoteRegistry(ITickerLauncherLike(LIVE_TICKER_LAUNCHER), d, USDG);
        TreasuryConversion t2 = new TreasuryConversion(r2, d, ISeederLike(SEEDER), IERC20(USDG), TEAM);
        r2.record(small);

        uint256 want = 50_000e6; // fifty times the whole issuance
        deal(USDG, address(t2), want);
        t2.earmark(want);

        // a caller who insists on completion is told it did not complete, and the shortfall is the market's
        vm.expectPartialRevert(TreasuryConversion.BuyIncomplete.selector);
        t2.buyOrRevert(small, want, IMPACT, terms(atPct(50), 60));

        (uint256 got, uint256 spent) = t2.buy(small, want, IMPACT, terms(atPct(50), 60));
        console.log("issuance / wanted / spent / bought");
        console.log(uint256(1_000e6));
        console.log(want);
        console.log(spent);
        console.log(got);
        assertGt(got, 0, "it bought something");
        assertLt(spent, want, "but the market could not take it all");
        assertEq(t2.earmarked(), want - spent, "the unspent remainder is still earmarked");
        assertEq(IERC20(small).balanceOf(address(t2)), got, "and what arrived is what is held");

        // and once the issuance is gone, a further buy refuses by name rather than reporting a fill of nothing
        vm.expectRevert(abi.encodeWithSelector(QuoteConverter.MarketNotPrimed.selector, small));
        t2.buyOrRevert(small, want, IMPACT, terms(atPct(50), 60));
    }

    /// @notice And the same shortfall reported when the earmark, rather than the market, is the limit.
    function test_fork_aBuyBeyondTheEarmarkSpendsOnlyTheEarmark() public {
        if (!forked) return;
        reg.record(TESTNAME);
        deal(USDG, address(t), 30e6);
        t.earmark(20e6);
        (uint256 got, uint256 spent) = t.buy(TESTNAME, 25e6, IMPACT, terms(atPct(50), 60));
        assertGt(got, 0);
        assertEq(spent, 20e6, "it spent the earmark and no more");
        assertEq(IERC20(USDG).balanceOf(address(t)), 10e6, "and never touched counter that was not earmarked");
    }

    // ---------------------------------------------------------------- the fresh market boundary

    /// @dev A market whose name sorts on a chosen side of the counter, so the boundary is checked in both
    /// currency orderings rather than in whichever one a salt happened to give.
    function _freshWithOrdering(string memory symbol, bool nameBelowCounter) internal returns (address name_) {
        MarketTickerDeployer d = MarketTickerDeployer(MARKET_DEPLOYER);
        for (uint256 i = 0; i < 512; ++i) {
            bytes32 salt = keccak256(abi.encodePacked(symbol, i));
            address predicted = d.predict(salt, symbol, 6);
            if ((predicted < USDG) == nameBelowCounter) {
                vm.prank(d.issuer());
                (name_,) = d.create(salt, symbol, 6);
                return name_;
            }
        }
        revert("no salt for that ordering");
    }

    /// @notice A brand new market holds only its name and not one unit of the counter, so selling into it can
    /// move nothing. That refusal is by name, and the treasury records the balance as still ours.
    ///
    /// Checked in both currency orderings, because which direction a sale pushes the price depends on how the
    /// two addresses sort, and a conclusion from one ordering says nothing about the other.
    function test_fork_aFreshMarketCannotBeSoldIntoInEitherOrdering() public {
        if (!forked) return;
        for (uint256 k = 0; k < 2; ++k) {
            bool nameBelow = k == 0;
            address fresh = _freshWithOrdering(nameBelow ? "FRESHLO" : "FRESHHI", nameBelow);
            assertEq(fresh < USDG, nameBelow, "fixture: ordering");
            reg.record(fresh);
            deal(fresh, address(t), 1_000e6);

            vm.expectRevert(abi.encodeWithSelector(QuoteConverter.MarketNotPrimed.selector, fresh));
            t.convertStrict(fresh, 1_000e6, IMPACT, terms(atPct(50), 60));

            (uint256 recognised, uint256 spent) = t.collectOne(fresh, IMPACT, terms(atPct(50), 60));
            assertEq(recognised, 0);
            assertEq(spent, 0);
            assertEq(t.unconverted(fresh), 1_000e6, "still attributed");
            assertEq(IERC20(fresh).balanceOf(address(t)), 1_000e6, "still held");
            console.log(nameBelow ? "name below the counter: refused" : "name above the counter: refused");
        }
        assertEq(t.totalRecognised(), 0, "nothing was recognised in either ordering");
    }

    // ---------------------------------------------------------------- isolation

    /// @notice Converting one asset never touches another's balance or the standing earmark.
    function test_fork_convertingOneAssetLeavesTheOthersAlone() public {
        if (!forked) return;
        reg.record(FUN);
        reg.record(TESTNAME);
        deal(FUN, address(t), 400e6);
        deal(TESTNAME, address(t), 300e6);
        deal(USDG, address(t), 100e6);
        t.earmark(100e6);

        uint256 funBefore = IERC20(FUN).balanceOf(address(t));
        t.collectOne(TESTNAME, IMPACT, terms(atPct(90), 60));
        assertEq(IERC20(FUN).balanceOf(address(t)), funBefore, "the other name is untouched");
        assertEq(t.earmarked(), 100e6, "and the standing earmark is untouched");
    }

    // ---------------------------------------------------------------- refusals

    function test_fork_registrationIsRequiredAndRepeatsAreRefused() public {
        if (!forked) return;
        deal(FUN, address(t), 100e6);
        vm.expectRevert(abi.encodeWithSelector(QuoteConverter.NotRegistered.selector, FUN));
        t.convertStrict(FUN, 100e6, IMPACT, terms(atPct(99), 60));

        reg.record(FUN);
        vm.expectRevert(
            abi.encodeWithSelector(QuoteRegistry.AlreadyRecorded.selector, FUN, IQuoteKind.Kind.LEGACY_REDEEMABLE_WRAPPER)
        );
        reg.record(FUN);
        (uint256 out,) = t.convertStrict(FUN, 100e6, IMPACT, terms(atPct(99), 60));
        assertEq(out, 100e6, "still converts after a refused repeat");
    }

    function test_fork_aCoinIsNeverAQuoteAsset() public {
        if (!forked) return;
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.UnknownProvenance.selector, TICKR));
        reg.record(TICKR);
        deal(TICKR, address(t), 1e18);
        vm.expectRevert(abi.encodeWithSelector(QuoteConverter.NotRegistered.selector, TICKR));
        t.convertStrict(TICKR, 1e18, IMPACT, terms(atPct(50), 60));
    }

    function test_fork_aBrokenIssuerBreaksNothingAlreadyRecorded() public {
        if (!forked) return;
        reg.record(FUN);
        reg.record(TESTNAME);
        vm.etch(LIVE_TICKER_LAUNCHER, hex"fe");
        assertEq(uint8(reg.kindOf(FUN)), uint8(IQuoteKind.Kind.LEGACY_REDEEMABLE_WRAPPER));
        assertEq(uint8(reg.provenanceOf(0xf38B8695e5B9280da287f6BdDBD115C083200258)), uint8(IQuoteKind.Kind.UNKNOWN));
        deal(TESTNAME, address(t), 100e6);
        (uint256 out,) = t.convertStrict(TESTNAME, 100e6, IMPACT, terms(atPct(90), 60));
        assertGt(out, 0, "the other generation is unaffected");
    }
}
