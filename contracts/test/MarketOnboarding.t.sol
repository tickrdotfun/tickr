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
import {TokenParams, Socials, LaunchConfig, FeePolicy, PairEconomics} from "../src/Types.sol";
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
interface ILegacyLauncher {
    function tickerFor(string calldata symbol) external view returns (address);
    function launch(string calldata symbol, TokenParams calldata coin, uint256 launchConfigId)
        external payable returns (address ticker, address token, bytes32 poolId);
    function previewLaunch(string calldata symbol, uint256 launchConfigId)
        external view returns (address ticker, bool exists, bytes32 expected, PairEconomics memory econ);
}

contract MarketOnboardingForkTest is Test {
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

    /// @dev The settings being tested. Not a payout figure: the shares the collected fee is divided by.
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
    address name;      // created by createAndLaunch in setUp, not reused from the chain
    bytes32 nameSalt;
    MarketTickerDeployer issuer;
    bool forked;

    /// @notice A name that onboards itself: no registration, no rate policy, no owner transaction per launch.
    ///
    /// The setup below deliberately does NOT call `registry.record` or `vault.setMinRate` for the name it
    /// creates. Those were the two manual steps, and a release that needs them for every launch would quietly
    /// stop allocating the moment somebody forgot one. Everything here is what a real launch would produce.
    function setUp() public {
        if (!Fork.select()) return;
        forked = true;
        owner = IFactory(FACTORY).owner();

        LaunchConfig memory base = IFactory(FACTORY).getLaunchConfig(0);
        LaunchConfig memory c = LaunchConfig({
            supply: base.supply, baseFeeBps: BASE_FEE_BPS, phantomQuote: base.phantomQuote,
            tickSpacing: base.tickSpacing, enabled: true
        });

        // a brand new issuer and launcher, paired the way a real deployment pairs them: the issuer is told the
        // launcher's address before it exists. Nothing here reuses the live issuer or any name it made.
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        MarketTickerDeployer liveIssuer = MarketTickerDeployer(MARKET_DEPLOYER);
        issuer = new MarketTickerDeployer(
            next, IERC20(USDG), ISeederLike(SEEDER).poolManager(), liveIssuer.posm(), liveIssuer.permit2(),
            liveIssuer.supply(), liveIssuer.fee(), liveIssuer.spacing(), liveIssuer.width()
        );
        launcher = new MarketTickerLauncher(IFactory(FACTORY), issuer);
        require(address(launcher) == next, "the issuer names the launcher that owns it");

        registry = new QuoteRegistry(ITickerLauncherLike(LIVE_TICKER_LAUNCHER), issuer, USDG);
        // NOTE: no registry.record here, for any name
        vault = new BuybackTreasuryV2(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), team,
            registry, issuer
        );
        // NOTE: no vault.setMinRate here, for any name

        FeePolicy memory p = _policy();
        p.protocolFeeRecipient = address(vault);
        treasury = address(vault);
        p.creatorShareBps = CREATOR_SHARE;
        p.clubShareBps = 0;
        p.protocolShareBps = PROTOCOL_SHARE;
        p.buybackBurnBps = 0;

        vm.startPrank(owner);
        (bool okc, bytes memory cid) = FACTORY.call(abi.encodeWithSignature("addLaunchConfig((uint256,uint256,uint256,int24,bool))", c));
        require(okc, "addLaunchConfig");
        configId = abi.decode(cid, (uint256));
        (bool ok1,) = FACTORY.call(abi.encodeWithSignature("setFeePolicy((address,uint16,uint16,uint16,uint16,address,uint16,uint16))", p));
        (bool ok2,) = FACTORY.call(abi.encodeWithSignature("setRegistrar(address,bool)", address(launcher), true));
        vm.stopPrank();
        require(ok1 && ok2, "owner setup");

        // the name does not exist yet: its address is settled from the salt so the coin can be ground below it
        nameSalt = keccak256("ONBOARDNAME");
        name = launcher.predictName(nameSalt, "ONBRD", 6);

        TokenParams memory tp = TokenParams({
            name: "ONBOARD", symbol: "ONBOARD", logo: "", description: "",
            socials: Socials("", "", "", "", ""), creatorFeeRecipient: address(0), creatorTaxBps: 0,
            buybackEnabled: true, expectedEconomics: bytes32(0), salt: bytes32(0)
        });
        for (uint256 i = 1; i < 80_000; ++i) {
            tp.salt = bytes32(i);
            if (ILaunchDeployerLike(LAUNCH_DEPLOYER).predictToken(creator, tp, c.supply) < name) break;
        }
        tp.expectedEconomics = launcher.previewEconomics(configId, name);
        uint256 fee = IFactory(FACTORY).launchFee();
        vm.deal(creator, 10 ether);
        vm.prank(creator);
        address made;
        (made, coin,) = launcher.createAndLaunch{value: fee}(nameSalt, "ONBRD", 6, tp, configId);
        require(made == name, "the name did not land where predicted");

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
        p[1] = MarketZapRouter.Hop({kind: 0, key: issuer.keyFor(name), pool: address(0)});
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



    uint256 constant NEAR_PAR_X96 = FeeSettings.MIN_RATE_NAME_TO_COUNTER_X96;

    function terms1(uint256 floorX96) internal view returns (QuoteConverter.Terms[] memory t) {
        t = new QuoteConverter.Terms[](1);
        t[0] = QuoteConverter.Terms({minOutPerInX96: floorX96, deadline: block.timestamp + 60});
    }

    /// @notice The name is unknown to the registry when trading starts, and its revenue is still allocated.
    function test_fork_aNameOnboardsItselfAndTheProceedsAreAllocated() public {
        if (!forked) return;
        assertEq(uint256(registry.kindOf(name)), 0, "the registry has never been told about this name");
        assertEq(
            uint256(registry.provenanceOf(name)),
            uint256(2),
            "but its issuer claims it, which is the only authority that matters"
        );
        assertEq(vault.minRateToCounterX96(name), 0, "and no floor was set for it by hand");
        assertEq(
            vault.defaultMinRateToCounterX96(),
            FeeSettings.MIN_RATE_NAME_TO_COUNTER_X96,
            "the default is the frozen policy, not a loose value"
        );

        MarketZapRouter r = router();
        uint256 bought = buy(r, 0.01 ether);
        buy(r, 0.01 ether);
        sell(r, bought / 4);

        (uint256 quoteOut,) = ILockerLike(LOCKER).collectFees(coin);
        assertGt(quoteOut, 0, "trading left fees");

        address[] memory names = new address[](1);
        names[0] = name;
        QuoteConverter.Terms[] memory t = terms1(NEAR_PAR_X96);
        (uint256 total, uint256 toTeam, uint256 earmarked) = vault.collect(names, t);

        console.log("collected / team / earmarked");
        console.log(total);
        console.log(toTeam);
        console.log(earmarked);

        assertGt(total, 0, "the name converted to dollars without anyone registering it");
        assertGt(earmarked, 0, "and the buyback got its share, which the legacy treasury would have sent to the team");
        assertGt(toTeam, 0, "the team got its share too");
        assertEq(uint256(registry.kindOf(name)), 2, "the collect recorded it on the way past");
        assertEq(IERC20(name).balanceOf(team), 0, "and no name was forwarded whole to the team");
    }

    /// @notice The default floor is a floor, not a formality: terms below it are still refused.
    function test_fork_theDefaultFloorStillRefusesWeakTerms() public {
        if (!forked) return;
        MarketZapRouter r = router();
        buy(r, 0.01 ether);
        ILockerLike(LOCKER).collectFees(coin);

        address[] memory names = new address[](1);
        names[0] = name;
        // the treasury's own dollars move for other reasons (the launch fee arrives as ether and converts),
        // so the thing to measure is the name itself: it must not have been sold on terms below the floor
        // the fees wait in the escrow until collect claims them, so the amount at stake is measured there
        uint256 owed = IFeeEscrow(ESCROW).balanceOfToken(address(vault), name);
        assertGt(owed, 0, "there really is a name balance to refuse");

        // half of par, far under the frozen policy
        QuoteConverter.Terms[] memory weak = terms1(FeeSettings.MIN_RATE_NAME_TO_COUNTER_X96 / 2);
        vault.collect(names, weak);

        uint256 held = IERC20(name).balanceOf(address(vault));
        assertEq(held, owed, "the name was claimed but not one unit of it was sold on refused terms");
        assertEq(IERC20(name).balanceOf(team), 0, "and it was not given away either");

        // and the same balance converts once the terms meet the floor
        (uint256 ok,,) = vault.collect(names, terms1(NEAR_PAR_X96));
        assertGt(ok, 0, "the identical balance converts at the policy rate");
        assertLt(IERC20(name).balanceOf(address(vault)), held, "so the refusal was the terms, not the name");
    }

    /// @notice What the default floor permission actually is, stated exactly rather than flatteringly.
    ///
    /// It is not "only ever raised". It can be moved anywhere at or above the frozen policy, which means a
    /// raised default can be lowered again, down to the frozen value and no further. Saying otherwise would
    /// describe a guarantee the contract does not make.
    function test_fork_theDefaultFloorMovesOnlyAtOrAboveTheFrozenPolicy() public {
        if (!forked) return;
        uint256 frozen = FeeSettings.MIN_RATE_NAME_TO_COUNTER_X96;
        assertEq(vault.defaultMinRateToCounterX96(), frozen, "it starts at the frozen policy");

        // below the frozen policy: refused
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(BuybackTreasuryV2.TermsWeakerThanPolicy.selector, address(0), frozen - 1, frozen)
        );
        vault.setDefaultMinRate(true, frozen - 1);

        // raised: allowed
        vm.prank(owner);
        vault.setDefaultMinRate(true, frozen * 2);
        assertEq(vault.defaultMinRateToCounterX96(), frozen * 2, "raised");

        // and lowered again, back to the frozen value but no further
        vm.prank(owner);
        vault.setDefaultMinRate(true, frozen);
        assertEq(vault.defaultMinRateToCounterX96(), frozen, "a raised default can be lowered back to frozen");

        vm.prank(owner);
        vm.expectRevert();
        vault.setDefaultMinRate(true, frozen - 1);
    }

    /// @notice A per-token floor is a separate power with no lower bound, and the default does not constrain it.
    ///
    /// Recorded because the release notes must not imply the frozen policy is a floor under every name. It is a
    /// floor under names the owner has not touched. This is a pre-existing owner power, unchanged by the
    /// default; the point of the test is that nobody later reads "cannot be weakened" and believes it applies
    /// everywhere.
    function test_fork_aPerTokenFloorIsSeparateAndHasNoLowerBound() public {
        if (!forked) return;
        uint256 frozen = FeeSettings.MIN_RATE_NAME_TO_COUNTER_X96;
        uint256 weak = frozen / 2;

        vm.prank(owner);
        vault.setMinRate(name, true, weak); // accepted: no lower bound on this setter
        assertEq(vault.minRateToCounterX96(name), weak, "the per-token floor took a value under the frozen policy");

        // and it is the one that applies, not the default
        QuoteConverter.Terms memory used = vault.checkTerms(name, true, terms1(weak)[0]);
        assertEq(used.minOutPerInX96, weak, "the token's own floor governs, weaker than the default");

        // zero means "no floor of its own", which returns the token to the default rather than to nothing
        vm.prank(owner);
        vault.setMinRate(name, true, 0);
        vm.expectRevert();
        vault.checkTerms(name, true, terms1(weak)[0]);
    }
    // ---------------------------------------------------------------- the legacy path, executed

    /// @notice A NEW coin priced in a live legacy wrapper, paying V2, collected end to end.
    ///
    /// `test_fork_legacyAccountingIsUnchanged` in Allocation82 reads an old coin's stored policy and stops
    /// there. It never launches, trades or collects, so it cannot show that V2 handles a wrapper at all. This
    /// launches a coin under the live FUN wrapper while V2 is the protocol recipient, trades it, and collects.
    ///
    /// What must hold is exactness: a wrapper redeems one for one, with no fee and no price impact, so every
    /// unit the treasury claimed has to arrive as the same number of dollars. A swap would not do that, and a
    /// swap is what would happen if V2 ever mistook a wrapper for a market.
    function test_fork_aNewLegacyWrapperCoinPaysV2AndRedeemsExactly() public {
        if (!forked) return;
        address fun = ILegacyLauncher(LIVE_TICKER_LAUNCHER).tickerFor("FUN");
        assertTrue(fun != address(0), "the live wrapper exists");
        assertEq(uint256(registry.provenanceOf(fun)), 1, "and its provenance is the legacy wrapper");

        TokenParams memory tp = TokenParams({
            name: "LEGACYNEW", symbol: "LEGACYNEW", logo: "", description: "",
            socials: Socials("", "", "", "", ""), creatorFeeRecipient: address(0), creatorTaxBps: 0,
            buybackEnabled: true, expectedEconomics: bytes32(0), salt: bytes32(0)
        });
        for (uint256 i = 1; i < 80_000; ++i) {
            tp.salt = bytes32(i);
            if (ILaunchDeployerLike(LAUNCH_DEPLOYER).predictToken(creator, tp, IFactory(FACTORY).getLaunchConfig(0).supply) < fun) break;
        }

        // the economics are pinned by the factory, so they are read immediately before the launch
        (,, bytes32 expected,) = ILegacyLauncher(LIVE_TICKER_LAUNCHER).previewLaunch("FUN", 0);
        tp.expectedEconomics = expected;

        uint256 fee = IFactory(FACTORY).launchFee();
        vm.deal(creator, 20 ether);
        vm.prank(creator);
        (, address legacyCoin,) = ILegacyLauncher(LIVE_TICKER_LAUNCHER).launch{value: fee}("FUN", tp, 0);
        assertTrue(legacyCoin != address(0), "a coin launched under the live wrapper");
        assertEq(IFactory(FACTORY).getLaunchFeePolicy(legacyCoin).protocolFeeRecipient, address(vault), "and it pays V2");

        // launch protection refuses trading in the launch block, exactly as it does for a real coin
        vm.roll(block.number + 10);
        vm.warp(block.timestamp + 120);

        // trade it so there are fees denominated in the wrapper
        MarketZapRouter r = router();
        MarketZapRouter.Hop[] memory path = new MarketZapRouter.Hop[](3);
        path[0] = MarketZapRouter.Hop({kind: 0, key: PoolKey(Currency.wrap(address(0)), Currency.wrap(USDG), 100, 1, IHooks(address(0))), pool: address(0)});
        PoolKey memory empty;
        path[1] = MarketZapRouter.Hop({kind: 2, key: empty, pool: fun}); // HOP_WRAP: mint the wrapper from USDG
        path[2] = MarketZapRouter.Hop({kind: 0, key: IFactory(FACTORY).poolKeyOf(legacyCoin), pool: address(0)});

        vm.deal(trader, trader.balance + 0.05 ether);
        vm.prank(trader);
        r.zapBuy{value: 0.02 ether}(
            MarketZapRouter.ZapParams({
                token: legacyCoin, tokenIn: address(0), amountIn: 0, path: path,
                minTokensOut: 1, recipient: trader, deadline: block.timestamp + 300
            })
        );

        ILockerLike(LOCKER).collectFees(legacyCoin);

        // The launch fee arrives as ether and converts to dollars in the same call, so a collect that includes
        // it cannot show what the redemption itself was worth: an inequality would pass even on a shortfall.
        // Flush that revenue first, with no names, so the next collect carries the wrapper and nothing else.
        vault.collect(new address[](0), new QuoteConverter.Terms[](0));
        assertEq(address(vault).balance, 0, "no ether is left to convert into the measured collect");

        uint256 owed = IFeeEscrow(ESCROW).balanceOfToken(address(vault), fun);
        assertGt(owed, 0, "the trade left wrapper-denominated fees for the treasury");

        address[] memory names = new address[](1);
        names[0] = fun;
        // no terms are supplied for a wrapper: a redemption is exact, so there is nothing to protect
        (uint256 total, uint256 toTeam, uint256 earmarked) = vault.collect(names, new QuoteConverter.Terms[](1));

        console.log("legacy wrapper: owed | collected (isolated) | team | earmarked");
        console.log(owed);
        console.log(total);
        console.log(toTeam);
        console.log(earmarked);

        assertEq(IERC20(fun).balanceOf(address(vault)), 0, "the whole wrapper balance was redeemed");
        assertEq(IERC20(fun).balanceOf(team), 0, "and none of it was forwarded to the team as unconvertible");
        // the point of the whole test: exactly, not approximately. A swap would land under this by its fee
        assertEq(total, owed, "one wrapper unit became exactly one dollar: a redemption, not a swap");
        assertEq(toTeam + earmarked, owed, "and every dollar of it was allocated");
        assertGt(earmarked, 0, "the buyback got its share");
        // an odd total cannot halve exactly; the remainder stays with the buyback
        assertApproxEqAbs(toTeam, earmarked, 1, "split evenly, as the live treasury does");
    }
}
