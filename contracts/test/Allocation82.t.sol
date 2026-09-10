// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fork} from "./Fork.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IWETH9} from "v4-periphery/src/interfaces/external/IWETH9.sol";
import {MarketTickerLauncher} from "../src/market/MarketTickerLauncher.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {MarketZapRouter} from "../src/market/MarketZapRouter.sol";
import {QuoteRegistry, ITickerLauncherLike} from "../src/market/QuoteRegistry.sol";
import {ISeederLike} from "../src/market/QuoteConverter.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {IFeeEscrow} from "../src/interfaces/IFeeEscrow.sol";
import {TokenParams, Socials, LaunchConfig, FeePolicy} from "../src/Types.sol";
import {BuybackTreasuryV2} from "../src/market/BuybackTreasuryV2.sol";
import {QuoteConverter} from "../src/market/QuoteConverter.sol";
import {LaunchSeeder} from "../src/LaunchSeeder.sol";
import {FeeSettings} from "../src/market/FeeSettings.sol";

interface ILaunchDeployerLike {
    function predictToken(address initiator, TokenParams calldata params, uint256 supply) external view returns (address);
}

interface ILockerLike {
    function collectFees(address token) external returns (uint256 quoteOut, uint256 coinOut);
}

/// @dev The proposed settings, run rather than argued: an 82 basis point coin fee with no creator surcharge, and
/// the fees it collects divided 40 creator, 30 buyback, 30 team.
///
/// The division is checked against **what was actually collected**, read out of the escrow after real trading,
/// never against a figure written into the test. A payout asserted at 81.84 bps would only prove the test can
/// repeat a number from a document.
contract Allocation82ForkTest is Test {
    address constant FACTORY = 0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f;
    address constant SEEDER = 0x3733576410312D34B53F90cFE513B0D0995aB6Ca;
    address constant ESCROW = 0xCf706542a17ee6C0Cc9595E3f49d9131aF3331ba;
    address constant LOCKER = 0xDfD29cB10Ff0491CdF7896F75e54f4357F4a42b8;
    address constant LAUNCH_DEPLOYER = 0xD86C1Cc523256519Dbd608318395e0C97e0368d6;
    address constant MARKET_DEPLOYER = 0x0F72C545Bd455DB7184F5B0eA4725f5AA8494418;
    address constant LIVE_TICKER_LAUNCHER = 0x7f6c8bA781b5bDC499F2BA7501A2178508877649;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant TESTNAME = 0x4Dd89f107d9b8395237719FA9d621a7A5BC00c52;
    uint256 constant BPS = 10_000;

    /// @notice The settings being tested. Not a payout figure: the shares the collected fee is divided by.
    uint16 constant BASE_FEE_BPS = FeeSettings.BASE_FEE_BPS;
    uint16 constant CREATOR_SHARE = FeeSettings.CREATOR_SHARE_BPS;
    uint16 constant PROTOCOL_SHARE = FeeSettings.PROTOCOL_SHARE_BPS;

    MarketTickerLauncher launcher;
    BuybackTreasuryV2 vault; // the treasury this policy pays, wired for the test rather than assumed
    QuoteRegistry registry;
    address team = address(0x7EA1);
    address owner;
    address creator = address(0xC0FFEE);
    address trader = address(0x77AD);
    address treasury; // whatever the policy names as the protocol's recipient
    uint256 configId;
    address coin;
    bool forked;

    function setUp() public {
        if (!Fork.select()) return;
        forked = true;
        owner = IFactory(FACTORY).owner();

        LaunchConfig memory base = IFactory(FACTORY).getLaunchConfig(0);
        LaunchConfig memory c = LaunchConfig({
            supply: base.supply,
            baseFeeBps: BASE_FEE_BPS,
            phantomQuote: base.phantomQuote,
            tickSpacing: base.tickSpacing,
            enabled: true
        });

        registry = new QuoteRegistry(ITickerLauncherLike(LIVE_TICKER_LAUNCHER), MarketTickerDeployer(MARKET_DEPLOYER), USDG);
        registry.record(TESTNAME);
        vault = new BuybackTreasuryV2(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), team,
            registry, MarketTickerDeployer(MARKET_DEPLOYER)
        );

        FeePolicy memory p = _policy();
        // the protocol's share is paid to the treasury under test, so its payout can be executed rather than
        // multiplied out on paper
        p.protocolFeeRecipient = address(vault);
        treasury = address(vault);
        p.creatorShareBps = CREATOR_SHARE;
        p.clubShareBps = 0;
        p.protocolShareBps = PROTOCOL_SHARE;
        p.buybackBurnBps = 0; // the treasury divides the protocol's share; the locker does not pre-split it

        launcher = new MarketTickerLauncher(IFactory(FACTORY), MarketTickerDeployer(MARKET_DEPLOYER));
        vm.startPrank(owner);
        (bool okc, bytes memory cid) = FACTORY.call(abi.encodeWithSignature("addLaunchConfig((uint256,uint256,uint256,int24,bool))", c));
        require(okc, "addLaunchConfig");
        configId = abi.decode(cid, (uint256));
        (bool ok1,) = FACTORY.call(abi.encodeWithSignature("setFeePolicy((address,uint16,uint16,uint16,uint16,address,uint16,uint16))", p));
        (bool ok2,) = FACTORY.call(abi.encodeWithSignature("setRegistrar(address,bool)", address(launcher), true));
        vm.stopPrank();
        require(ok1 && ok2, "owner setup");
        vm.prank(owner);
        // the intended live floor, from the frozen settings, not a loose test value. Everything below meets it
        vault.setMinRate(TESTNAME, true, FeeSettings.MIN_RATE_NAME_TO_COUNTER_X96);
        vm.prank(owner);
        vault.setMinRate(TESTNAME, false, FeeSettings.MIN_RATE_COUNTER_TO_NAME_X96);

        TokenParams memory tp = TokenParams({
            name: "EIGHTYTWO", symbol: "EIGHTYTWO", logo: "", description: "",
            socials: Socials("", "", "", "", ""), creatorFeeRecipient: address(0), creatorTaxBps: 0,
            buybackEnabled: true, expectedEconomics: launcher.previewEconomics(configId, TESTNAME), salt: bytes32(0)
        });
        for (uint256 i = 1; i < 80_000; ++i) {
            tp.salt = bytes32(i);
            if (ILaunchDeployerLike(LAUNCH_DEPLOYER).predictToken(creator, tp, c.supply) < TESTNAME) break;
        }
        uint256 fee = IFactory(FACTORY).launchFee();
        vm.deal(creator, 10 ether);
        vm.prank(creator);
        (coin,) = launcher.launch{value: fee}(tp, configId, TESTNAME);

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 25 hours);
    }

    function _policy() internal view returns (FeePolicy memory p) {
        (bool ok, bytes memory out) = FACTORY.staticcall(abi.encodeWithSignature("defaultPolicy()"));
        require(ok, "defaultPolicy");
        (
            address recipient, uint16 creatorShareBps, uint16 clubShareBps, uint16 protocolShareBps,
            uint16 buybackBurnBps, address club, uint16 hookFeeBps, uint16 maxImpact
        ) = abi.decode(out, (address, uint16, uint16, uint16, uint16, address, uint16, uint16));
        p = FeePolicy(recipient, creatorShareBps, clubShareBps, protocolShareBps, buybackBurnBps, club, hookFeeBps, maxImpact);
    }

    function router() internal returns (MarketZapRouter r) {
        QuoteRegistry reg = new QuoteRegistry(ITickerLauncherLike(LIVE_TICKER_LAUNCHER), MarketTickerDeployer(MARKET_DEPLOYER), USDG);
        reg.record(TESTNAME);
        r = new MarketZapRouter(IFactory(FACTORY), ISeederLike(SEEDER).poolManager(), IWETH9(WETH), reg);
    }

    function buyPath() internal view returns (MarketZapRouter.Hop[] memory p) {
        p = new MarketZapRouter.Hop[](3);
        p[0] = MarketZapRouter.Hop({kind: 0, key: PoolKey(Currency.wrap(address(0)), Currency.wrap(USDG), 100, 1, IHooks(address(0))), pool: address(0)});
        p[1] = MarketZapRouter.Hop({kind: 0, key: MarketTickerDeployer(MARKET_DEPLOYER).keyFor(TESTNAME), pool: address(0)});
        p[2] = MarketZapRouter.Hop({kind: 0, key: IFactory(FACTORY).poolKeyOf(coin), pool: address(0)});
    }

    function buy(MarketZapRouter r, uint256 value) internal returns (uint256 out) {
        vm.deal(trader, trader.balance + value);
        vm.prank(trader);
        out = r.zapBuy{value: value}(
            MarketZapRouter.ZapParams({
                token: coin, tokenIn: address(0), amountIn: 0, path: buyPath(),
                minTokensOut: 1, recipient: trader, deadline: block.timestamp + 300
            })
        );
    }

    function sell(MarketZapRouter r, uint256 amount) internal returns (uint256 out) {
        MarketZapRouter.Hop[] memory p = buyPath();
        MarketZapRouter.Hop[] memory back = new MarketZapRouter.Hop[](3);
        back[0] = p[2];
        back[1] = p[1];
        back[2] = p[0];
        vm.startPrank(trader);
        IERC20(coin).approve(address(r), amount);
        out = r.zapSell(
            MarketZapRouter.ZapSellParams({
                token: coin, amountIn: amount, path: back, tokenOut: address(0),
                minOut: 1, recipient: trader, deadline: block.timestamp + 300
            })
        );
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- the settings

    /// @notice The launch really carries 82 basis points and no creator surcharge, and the pool the factory
    /// opened charges exactly that.
    function test_fork_theCoinCarriesTheProposedFee() public view {
        if (!forked) return;
        PoolKey memory k = IFactory(FACTORY).poolKeyOf(coin);
        assertEq(k.fee, uint24(BASE_FEE_BPS) * 100, "8,200 pips, which is what the factory can express");
        assertEq(IFactory(FACTORY).getLaunchedToken(coin).creatorTaxBps, 0, "and nothing added on top of it");
        assertEq(IFactory(FACTORY).getLaunchFeePolicy(coin).hookFeeBps, BASE_FEE_BPS);
    }

    // ---------------------------------------------------------------- trading, then the split

    /// @notice Buys, repeated buys and a sell, then the fees those trades left are collected and divided. Every
    /// figure asserted is read from the chain: what the escrow credited, against what the locker collected.
    function test_fork_collectedFeesAreDividedFortyThirtyThirty() public {
        if (!forked) return;
        MarketZapRouter r = router();

        uint256 bought = buy(r, 0.01 ether);
        assertGt(bought, 0, "the first buy filled");
        uint256 more = buy(r, 0.01 ether) + buy(r, 0.01 ether);
        assertGt(more, 0, "and repeated buying keeps filling");
        uint256 back = sell(r, (bought + more) / 4);
        assertGt(back, 0, "and a sell leaves with something");

        address creatorRecipient = IFactory(FACTORY).creatorFeeRecipientOf(coin);
        uint256 creatorBefore = IFeeEscrow(ESCROW).balanceOfToken(creatorRecipient, TESTNAME);
        uint256 treasuryBefore = IFeeEscrow(ESCROW).balanceOfToken(treasury, TESTNAME);

        (uint256 quoteOut,) = ILockerLike(LOCKER).collectFees(coin);
        assertGt(quoteOut, 0, "the trading left fees to collect");

        uint256 creatorGot = IFeeEscrow(ESCROW).balanceOfToken(creatorRecipient, TESTNAME) - creatorBefore;
        uint256 treasuryGot = IFeeEscrow(ESCROW).balanceOfToken(treasury, TESTNAME) - treasuryBefore;

        console.log("collected | creator | treasury");
        console.log(quoteOut);
        console.log(creatorGot);
        console.log(treasuryGot);

        // every unit collected is credited to somebody: no fee goes missing between the locker and the escrow
        assertEq(creatorGot + treasuryGot, quoteOut, "the whole collection is accounted for");

        // and the division is the proposed one, applied to what was actually collected
        uint256 expectedTreasury = (quoteOut * PROTOCOL_SHARE) / BPS;
        assertEq(treasuryGot, expectedTreasury, "the protocol's sixty percent");
        assertEq(creatorGot, quoteOut - expectedTreasury, "and the creator has the rest, rounding included");

        // rounding, said out loud rather than left implicit: the creator carries it, and it is at most one unit
        uint256 idealCreator = (quoteOut * CREATOR_SHARE) / BPS;
        assertLe(creatorGot - idealCreator, 1, "the creator's share is its exact fortieth or one unit above it");
        console.log("rounding to the creator, in the quote's smallest unit");
        console.log(creatorGot - idealCreator);
    }

    /// @dev The floor the acceptance cases use: a name's market opens at parity and never sells a name below a
    /// dollar, so a conversion in a normal market should return close to par. 99% leaves room for the pool's own
    /// fee and a tick of movement and nothing else.
    uint256 constant NEAR_PAR_X96 = FeeSettings.MIN_RATE_NAME_TO_COUNTER_X96;
    /// @dev Deliberately loose, and used only where the point is that a conversion happened at all rather than
    /// what it fetched. It is not the floor a live policy should carry.
    uint256 constant LOOSE_X96 = (uint256(1 << 96) * 50) / 100;

    function terms1(uint256 floorX96) internal view returns (QuoteConverter.Terms[] memory t) {
        t = new QuoteConverter.Terms[](1);
        t[0] = QuoteConverter.Terms({minOutPerInX96: floorX96, deadline: block.timestamp + 60});
    }

    function nothing() internal pure returns (address[] memory a) {
        a = new address[](0);
    }

    function onlyName() internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = TESTNAME;
    }

    // ---------------------------------------------------------------- the two revenue sources, apart

    /// @notice The launch fee, on its own. It is paid in ether and reaches the treasury as ether, so what the
    /// treasury converts here has nothing to do with trading and must not be counted as trading revenue.
    function test_fork_theLaunchFeeIsItsOwnRevenue() public {
        if (!forked) return;
        // no trading at all: whatever the treasury collects now is the launch fee and nothing else
        assertEq(IFeeEscrow(ESCROW).balanceOfToken(address(vault), TESTNAME), 0, "no trading fee has accrued");
        uint256 owedEth = IFeeEscrow(ESCROW).balanceOf(address(vault));
        assertGt(owedEth, 0, "the launch fee is owed in ether");

        uint256 teamBefore = IERC20(USDG).balanceOf(team);
        uint256 earmarkBefore = vault.earmarkedUsdg();
        (uint256 total, uint256 toTeam, uint256 earmarked) = vault.collect(nothing(), new QuoteConverter.Terms[](0));

        console.log("launch fee owed, in wei | dollars it became | to team | to buyback");
        console.log(owedEth);
        console.log(total);
        console.log(toTeam);
        console.log(earmarked);

        assertGt(total, 0, "the ether became dollars");
        assertEq(IERC20(TESTNAME).balanceOf(address(vault)), 0, "and no name was involved");
        assertEq(IERC20(USDG).balanceOf(team) - teamBefore, toTeam);
        assertEq(vault.earmarkedUsdg() - earmarkBefore, earmarked);
        assertEq(toTeam + earmarked, total, "every dollar of it is accounted for");
    }

    /// @notice The trading fee, on its own. The launch fee is drained first, so the dollars measured here can
    /// only have come from selling the name, and they are checked against the name actually consumed.
    function test_fork_theNameConversionIsMeasuredOnItsOwn() public {
        if (!forked) return;
        vault.collect(nothing(), new QuoteConverter.Terms[](0)); // the launch fee, out of the way
        assertEq(IFeeEscrow(ESCROW).balanceOf(address(vault)), 0, "no ether left owed");

        MarketZapRouter r = router();
        buy(r, 0.01 ether);
        buy(r, 0.01 ether);
        sell(r, IERC20(coin).balanceOf(trader) / 4);
        ILockerLike(LOCKER).collectFees(coin);

        uint256 owed = IFeeEscrow(ESCROW).balanceOfToken(address(vault), TESTNAME);
        assertGt(owed, 0, "the trading left the protocol a share, in the name");

        // measured across the conversion itself, not taken from what collect reported
        uint256 dollarsBefore = IERC20(USDG).balanceOf(address(vault));
        uint256 teamBefore = IERC20(USDG).balanceOf(team);
        uint256 earmarkBefore = vault.earmarkedUsdg();
        (uint256 total, uint256 toTeam, uint256 earmarked) = vault.collect(onlyName(), terms1(NEAR_PAR_X96));

        uint256 nameSpent = owed - IERC20(TESTNAME).balanceOf(address(vault));
        // the earmark is not paid out, it stays here, so it is already inside the balance change. Only the
        // team's payment left the treasury and has to be added back
        uint256 dollarsFromName = (IERC20(USDG).balanceOf(address(vault)) - dollarsBefore) + toTeam;

        console.log("name owed | name spent | dollars from the conversion | per name, in hundredths");
        console.log(owed);
        console.log(nameSpent);
        console.log(dollarsFromName);
        console.log((dollarsFromName * 100) / nameSpent);

        assertEq(nameSpent, owed, "the whole holding converted");
        assertEq(dollarsFromName, total, "and the dollars collect reported are the dollars the conversion made");
        // a name is worth about a dollar: the market opens at parity and never sells one below it
        assertGe((dollarsFromName * (1 << 96)) / nameSpent, NEAR_PAR_X96, "at or above the owner's near-par floor");
        assertLe(dollarsFromName, nameSpent, "and never above par, which the market cannot do");

        assertEq(IERC20(USDG).balanceOf(team) - teamBefore, toTeam, "the team wallet moved by what was reported");
        assertEq(vault.earmarkedUsdg() - earmarkBefore, earmarked);
        assertEq(toTeam + earmarked, total, "every dollar accounted for");
    }

    /// @notice And the two together. Collected in one call, the team wallet and the earmark end up holding
    /// exactly the sum of what each source produced on its own.
    function test_fork_bothRevenueSourcesReconcileAgainstTheBalances() public {
        if (!forked) return;
        MarketZapRouter r = router();
        buy(r, 0.01 ether);
        buy(r, 0.01 ether);
        sell(r, IERC20(coin).balanceOf(trader) / 4);
        ILockerLike(LOCKER).collectFees(coin);

        uint256 owedEth = IFeeEscrow(ESCROW).balanceOf(address(vault));
        uint256 owedName = IFeeEscrow(ESCROW).balanceOfToken(address(vault), TESTNAME);
        assertGt(owedEth, 0, "there is a launch fee");
        assertGt(owedName, 0, "and a trading fee");

        // each source is measured on its own first, in dollars, on branches that are thrown away. Subtracting a
        // name amount from a dollar amount would be comparing two different units, and would only ever give a
        // bound rather than an attribution
        uint256 snap = vm.snapshotState();
        (uint256 fromEther,,) = vault.collect(nothing(), new QuoteConverter.Terms[](0));
        vm.revertToState(snap);

        snap = vm.snapshotState();
        vault.collect(nothing(), new QuoteConverter.Terms[](0)); // the ether out of the way
        (uint256 fromName,,) = vault.collect(onlyName(), terms1(NEAR_PAR_X96));
        vm.revertToState(snap);

        uint256 teamBefore = IERC20(USDG).balanceOf(team);
        uint256 earmarkBefore = vault.earmarkedUsdg();
        (uint256 total, uint256 toTeam, uint256 earmarked) = vault.collect(onlyName(), terms1(NEAR_PAR_X96));

        uint256 teamGot = IERC20(USDG).balanceOf(team) - teamBefore;
        uint256 earmarkGot = vault.earmarkedUsdg() - earmarkBefore;
        uint256 nameSpent = owedName - IERC20(TESTNAME).balanceOf(address(vault));

        console.log("ether owed, wei | name owed and spent | dollars from ether | dollars from name | dollars total");
        console.log(owedEth);
        console.log(nameSpent);
        console.log(fromEther);
        console.log(fromName);
        console.log(total);
        console.log("to team | to buyback");
        console.log(teamGot);
        console.log(earmarkGot);

        // the balances hold exactly what was reported
        assertEq(teamGot, toTeam, "the team wallet");
        assertEq(earmarkGot, earmarked, "and the earmark");
        assertEq(teamGot + earmarkGot, total, "together, the whole collection");
        assertEq(nameSpent, owedName, "with the name fully converted");

        // the attribution, in one unit: the collection is exactly the two sources, each measured on its own
        assertEq(fromEther + fromName, total, "the two sources together are the whole collection, in dollars");
        assertGt(fromEther, 0, "the launch fee produced dollars");
        assertGt(fromName, 0, "and so did the trading fee");
        // and the trading part is the one bounded by par, in the name's own unit
        assertLe(fromName, nameSpent, "a name never fetches more than a dollar");

        uint16 share = vault.buybackShareBps();
        assertEq(share, 5_000, "half each, which makes the whole allocation 40/30/30");
        assertEq(toTeam, (total * (BPS - share)) / BPS, "the team's half, floored");
        assertLe(earmarked - (total * share) / BPS, 1, "and at most one unit of rounding, to the buyback");
        console.log("rounding to the buyback, in dollars' smallest unit");
        console.log(earmarked - (total * share) / BPS);
    }

    // ---------------------------------------------------------------- the owner's floor

    /// @notice The floor is the owner's, not the caller's. Anyone may call `collect`, so a caller that offers
    /// weaker terms than the owner set must not be able to sell the protocol's revenue cheaply. The offer is
    /// refused, the name stays where it is, and nobody is paid out of a conversion that did not happen.
    function test_fork_aCallerCannotOfferWeakerTermsThanTheOwnerSet() public {
        if (!forked) return;
        vault.collect(nothing(), new QuoteConverter.Terms[](0)); // the launch fee out of the way

        MarketZapRouter r = router();
        buy(r, 0.01 ether);
        sell(r, IERC20(coin).balanceOf(trader) / 4);
        ILockerLike(LOCKER).collectFees(coin);
        uint256 owed = IFeeEscrow(ESCROW).balanceOfToken(address(vault), TESTNAME);
        assertGt(owed, 0);

        // the floor is already the deployment's; nothing is raised for this test
        assertEq(vault.minRateToCounterX96(TESTNAME), FeeSettings.MIN_RATE_NAME_TO_COUNTER_X96, "the live floor");

        // the offer is checked against it, and a weaker one is named as weaker rather than quietly accepted
        vm.expectPartialRevert(BuybackTreasuryV2.TermsWeakerThanPolicy.selector);
        vault.checkTerms(TESTNAME, true, terms1(LOOSE_X96)[0]);

        uint256 teamBefore = IERC20(USDG).balanceOf(team);
        uint256 earmarkBefore = vault.earmarkedUsdg();

        // and a collection carrying that weaker offer converts nothing: the name is kept, not sold cheaply
        (uint256 total, uint256 toTeam, uint256 earmarked) = vault.collect(onlyName(), terms1(LOOSE_X96));
        console.log("with an offer under the owner's floor: dollars | to team | to buyback | name still held");
        console.log(total);
        console.log(toTeam);
        console.log(earmarked);
        console.log(IERC20(TESTNAME).balanceOf(address(vault)));

        assertEq(total, 0, "nothing was converted");
        assertEq(toTeam, 0, "so nobody was paid");
        assertEq(earmarked, 0);
        assertEq(IERC20(USDG).balanceOf(team), teamBefore, "and the team wallet did not move");
        assertEq(vault.earmarkedUsdg(), earmarkBefore);
        assertEq(IERC20(TESTNAME).balanceOf(address(vault)), owed, "the whole holding is still here");

        // the same call at the owner's own floor goes through, so what was refused was the offer and not the trade
        (uint256 ok,,) = vault.collect(onlyName(), terms1(NEAR_PAR_X96));
        assertGt(ok, 0, "at the owner's floor it converts");
        assertEq(IERC20(TESTNAME).balanceOf(address(vault)), 0, "and the holding is gone");
    }

    // ---------------------------------------------------------------- the coin side

    /// @notice The coin side is not the quote side, and is asserted as its own thing. There is no buyback slice
    /// and no team slice in the coin: what the protocol would have taken is burned. Under this policy that is
    /// 40% of the coin fee to the creator and 60% destroyed.
    function test_fork_theCoinSideBurnsTheProtocolsShareInsteadOfPayingIt() public {
        if (!forked) return;
        MarketZapRouter r = router();
        buy(r, 0.02 ether);
        // a sell is what leaves a fee denominated in the coin
        sell(r, IERC20(coin).balanceOf(trader) / 2);

        address creatorRecipient = IFactory(FACTORY).creatorFeeRecipientOf(coin);
        uint256 burnBefore = IERC20(coin).balanceOf(address(0xdEaD));
        uint256 creatorBefore = IFeeEscrow(ESCROW).balanceOfToken(creatorRecipient, coin);

        (, uint256 coinOut) = ILockerLike(LOCKER).collectFees(coin);
        assertGt(coinOut, 0, "the sell left a fee in the coin");

        uint256 burned = IERC20(coin).balanceOf(address(0xdEaD)) - burnBefore;
        uint256 creatorGot = IFeeEscrow(ESCROW).balanceOfToken(creatorRecipient, coin) - creatorBefore;

        console.log("coin fee collected | burned | to the creator");
        console.log(coinOut);
        console.log(burned);
        console.log(creatorGot);

        assertEq(burned + creatorGot, coinOut, "every coin collected is either burned or credited");
        assertEq(burned, (coinOut * PROTOCOL_SHARE) / BPS, "the protocol's share, destroyed rather than paid");
        assertEq(creatorGot, coinOut - burned, "and the creator has the rest, rounding included");
        assertEq(IERC20(coin).balanceOf(address(vault)), 0, "the treasury is paid nothing in the coin");
    }

    // ---------------------------------------------------------------- legacy

    /// @notice A coin launched on the original configuration keeps the original split. Changing the default
    /// policy does not reach a launch that was already frozen with its own.
    function test_fork_legacyAccountingIsUnchanged() public {
        if (!forked) return;
        address legacy = IFactory(FACTORY).launchAt(0);
        FeePolicy memory lp = IFactory(FACTORY).getLaunchFeePolicy(legacy);
        console.log("a coin launched before this change: creator | protocol | hook fee bps");
        console.log(lp.creatorShareBps);
        console.log(lp.protocolShareBps);
        console.log(lp.hookFeeBps);
        assertEq(uint256(lp.creatorShareBps) + lp.clubShareBps + lp.protocolShareBps, BPS, "still adds up");
        assertTrue(lp.creatorShareBps != CREATOR_SHARE || lp.hookFeeBps != BASE_FEE_BPS, "and is not this proposal's");
    }

    // ---------------------------------------------------------------- partial fills and repeat collection

    /// @notice A hop that can only be filled part way is refused, with the error that means exactly that, and
    /// everything rolls back.
    ///
    /// The pool is shallow on purpose: two hundred units of inventory against a sale worth far more. The minimum
    /// is one unit, so nothing here is refused for slippage; the only thing that can stop it is the router's
    /// rule against a partial hop, and the assertion names that rule rather than accepting any revert.
    function test_fork_aPartialFillIsRefusedAsSuchAndRollsBack() public {
        if (!forked) return;
        MarketZapRouter r = router();
        buy(r, 0.02 ether);
        // a sale far larger than two hundred units of inventory can answer, so the second hop must stop short
        deal(coin, trader, IERC20(coin).balanceOf(trader) + 200_000_000e18);
        uint256 held = IERC20(coin).balanceOf(trader);
        assertGt(held, 0);

        MarketTickerDeployer live = MarketTickerDeployer(MARKET_DEPLOYER);
        MarketTickerDeployer small = new MarketTickerDeployer(
            address(this), IERC20(TESTNAME), ISeederLike(SEEDER).poolManager(), live.posm(), live.permit2(),
            200e6, live.fee(), live.spacing(), live.width()
        );
        (address shallow,) = small.create(keccak256("SHALLOWALLOC"), "SHALLOWALLOC", 6);

        address creatorRecipient = IFactory(FACTORY).creatorFeeRecipientOf(coin);
        uint256 creatorBefore = IFeeEscrow(ESCROW).balanceOfToken(creatorRecipient, TESTNAME);
        uint256 vaultBefore = IFeeEscrow(ESCROW).balanceOfToken(address(vault), TESTNAME);
        uint256 burnBefore = IERC20(coin).balanceOf(address(0xdEaD));
        uint256 poolCoinBefore = IERC20(coin).balanceOf(address(ISeederLike(SEEDER).poolManager()));

        MarketZapRouter.Hop[] memory path = new MarketZapRouter.Hop[](2);
        path[0] = MarketZapRouter.Hop({kind: 0, key: IFactory(FACTORY).poolKeyOf(coin), pool: address(0)});
        path[1] = MarketZapRouter.Hop({kind: 0, key: small.keyFor(shallow), pool: address(0)});
        MarketZapRouter.ZapSellParams memory p2 = MarketZapRouter.ZapSellParams({
            token: coin, amountIn: held, path: path, tokenOut: shallow,
            minOut: 1, recipient: trader, deadline: block.timestamp + 300
        });

        vm.startPrank(trader);
        IERC20(coin).approve(address(r), held);
        vm.expectRevert(MarketZapRouter.InsufficientLiquidity.selector);
        r.zapSell(p2);
        vm.stopPrank();

        // the trade did not happen, and nothing about it half happened
        assertEq(IERC20(coin).balanceOf(trader), held, "the seller still has every coin");
        assertEq(IERC20(shallow).balanceOf(trader), 0, "and received nothing");
        assertEq(IERC20(coin).balanceOf(address(r)), 0, "nothing sits in the router");
        assertEq(IERC20(TESTNAME).balanceOf(address(r)), 0);
        assertEq(IERC20(coin).balanceOf(address(ISeederLike(SEEDER).poolManager())), poolCoinBefore, "the pool is where it was");
        assertEq(IFeeEscrow(ESCROW).balanceOfToken(creatorRecipient, TESTNAME), creatorBefore, "no fee was credited");
        assertEq(IFeeEscrow(ESCROW).balanceOfToken(address(vault), TESTNAME), vaultBefore);
        assertEq(IERC20(coin).balanceOf(address(0xdEaD)), burnBefore, "and nothing was burned");
    }

    /// @notice Collecting twice does not pay twice. The second collection carries only what was traded after the
    /// first, and both are divided the same way.
    function test_fork_collectingTwiceAccountsForEachTradeOnce() public {
        if (!forked) return;
        MarketZapRouter r = router();
        address creatorRecipient = IFactory(FACTORY).creatorFeeRecipientOf(coin);

        buy(r, 0.01 ether);
        uint256 c0 = IFeeEscrow(ESCROW).balanceOfToken(creatorRecipient, TESTNAME);
        uint256 t0 = IFeeEscrow(ESCROW).balanceOfToken(treasury, TESTNAME);
        (uint256 first,) = ILockerLike(LOCKER).collectFees(coin);
        uint256 c1 = IFeeEscrow(ESCROW).balanceOfToken(creatorRecipient, TESTNAME);
        uint256 t1 = IFeeEscrow(ESCROW).balanceOfToken(treasury, TESTNAME);
        assertEq((c1 - c0) + (t1 - t0), first, "the first collection is fully accounted for");

        // nothing traded in between: a second collection has nothing to give anybody
        (uint256 empty,) = ILockerLike(LOCKER).collectFees(coin);
        assertEq(empty, 0, "no fees appear out of nowhere");
        assertEq(IFeeEscrow(ESCROW).balanceOfToken(creatorRecipient, TESTNAME), c1, "and nobody is paid twice");
        assertEq(IFeeEscrow(ESCROW).balanceOfToken(treasury, TESTNAME), t1);

        // trade again, and the next collection carries that trade and only that trade
        buy(r, 0.02 ether);
        (uint256 second,) = ILockerLike(LOCKER).collectFees(coin);
        uint256 c2 = IFeeEscrow(ESCROW).balanceOfToken(creatorRecipient, TESTNAME);
        uint256 t2 = IFeeEscrow(ESCROW).balanceOfToken(treasury, TESTNAME);
        assertGt(second, 0, "the later trading left its own fees");
        assertEq((c2 - c1) + (t2 - t1), second, "the second collection is fully accounted for too");
        assertEq(t2 - t1, (second * PROTOCOL_SHARE) / BPS, "and divided the same way");

        console.log("first collection | second | creator total | treasury total");
        console.log(first);
        console.log(second);
        console.log(c2 - c0);
        console.log(t2 - t0);
        assertEq((c2 - c0) + (t2 - t0), first + second, "and the two collections together account for everything");
    }
}
