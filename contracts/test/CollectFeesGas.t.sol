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

contract CollectFeesGasForkTest is Test {
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
    /// @notice The allocation this release actually produces, with the live policy and only the recipient changed.
    ///
    /// `setFeePolicy` is global: there is no per-configuration policy, so changing the shares would change them
    /// for every future launch including legacy ones. This release therefore changes only
    /// `protocolFeeRecipient`. Every allocation setting is left exactly as it is today, and the numbers below
    /// are what follows from that, not from the 40/30/30 that was frozen for the fee proposal.
    function setUp() public {
        if (!Fork.select()) return;
        forked = true;
        owner = IFactory(FACTORY).owner();

        LaunchConfig memory base = IFactory(FACTORY).getLaunchConfig(0);
        LaunchConfig memory c = LaunchConfig({
            supply: base.supply, baseFeeBps: BASE_FEE_BPS, phantomQuote: base.phantomQuote,
            tickSpacing: base.tickSpacing, enabled: true
        });

        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        MarketTickerDeployer liveIssuer = MarketTickerDeployer(MARKET_DEPLOYER);
        issuer = new MarketTickerDeployer(
            next, IERC20(USDG), ISeederLike(SEEDER).poolManager(), liveIssuer.posm(), liveIssuer.permit2(),
            liveIssuer.supply(), liveIssuer.fee(), liveIssuer.spacing(), liveIssuer.width()
        );
        launcher = new MarketTickerLauncher(IFactory(FACTORY), issuer);
        registry = new QuoteRegistry(ITickerLauncherLike(LIVE_TICKER_LAUNCHER), issuer, USDG);
        vault = new BuybackTreasuryV2(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), team,
            registry, issuer
        );
        treasury = address(vault);

        // OPTION A: the live default policy, with the recipient and nothing else changed
        FeePolicy memory p = _policy();
        assertEq(p.creatorShareBps, 5000, "the live policy pays creators half");
        assertEq(p.clubShareBps, 1000, "and the club a tenth");
        assertEq(p.protocolShareBps, 4000, "and the protocol the rest");
        p.protocolFeeRecipient = address(vault);

        vm.startPrank(owner);
        (bool okc, bytes memory cid) = FACTORY.call(abi.encodeWithSignature("addLaunchConfig((uint256,uint256,uint256,int24,bool))", c));
        require(okc, "addLaunchConfig");
        configId = abi.decode(cid, (uint256));
        (bool ok1,) = FACTORY.call(abi.encodeWithSignature("setFeePolicy((address,uint16,uint16,uint16,uint16,address,uint16,uint16))", p));
        (bool ok2,) = FACTORY.call(abi.encodeWithSignature("setRegistrar(address,bool)", address(launcher), true));
        vm.stopPrank();
        require(ok1 && ok2, "owner setup");

        nameSalt = keccak256("OPTIONANAME");
        name = launcher.predictName(nameSalt, "OPTA", 6);
        TokenParams memory tp = TokenParams({
            name: "OPTACOIN", symbol: "OPTACOIN", logo: "", description: "",
            socials: Socials("", "", "", "", ""), creatorFeeRecipient: address(0), creatorTaxBps: 0,
            buybackEnabled: true, expectedEconomics: bytes32(0), salt: bytes32(0)
        });
        for (uint256 i = 1; i < 80_000; ++i) {
            tp.salt = bytes32(i);
            if (ILaunchDeployerLike(LAUNCH_DEPLOYER).predictToken(creator, tp, c.supply) < name) break;
        }
        tp.expectedEconomics = launcher.previewEconomics(configId, name);
        vm.deal(creator, 20 ether);
        vm.prank(creator);
        address made;
        (made, coin,) = launcher.createAndLaunch{value: IFactory(FACTORY).launchFee()}(nameSalt, "OPTA", 6, tp, configId);
        require(made == name, "the name did not land where predicted");

        vm.roll(block.number + 10);
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

    /// @notice What a trade landing between the estimate and the send actually costs, in gas.
    ///
    /// `collectFees` does different work depending on what has traded. With only buys, the fees are all on the
    /// quote side and nothing is burned. A sell adds coin-denominated fees, and the protocol's and club's share
    /// of those is burned, which is a transfer to the dead address the earlier estimate never accounted for.
    ///
    /// The keeper estimates immediately before sending, but an estimate is a measurement of the chain as it is,
    /// and a sell can land in between. This measures both shapes so the headroom the keeper applies is a number
    /// taken from the chain rather than a guess.
    function test_fork_theBurnLegIsWithinTheKeepersGasHeadroom() public {
        if (!forked) return;
        MarketZapRouter r = router();

        // buys only: fees on the quote side, nothing burned
        uint256 bought = buy(r, 0.01 ether);
        uint256 snap = vm.snapshotState();

        uint256 g0 = gasleft();
        ILockerLike(LOCKER).collectFees(coin);
        uint256 buysOnly = g0 - gasleft();

        // the same collection, but a sell landed first: now there is a coin side to burn
        vm.revertToState(snap);
        sell(r, bought / 3);
        uint256 g1 = gasleft();
        ILockerLike(LOCKER).collectFees(coin);
        uint256 withBurn = g1 - gasleft();

        console.log("collectFees gas, buys only:");
        console.log(buysOnly);
        console.log("collectFees gas, after a sell (burn leg):");
        console.log(withBurn);
        assertGt(withBurn, buysOnly, "the burn leg really does cost more, which is the whole hazard");

        // the keeper multiplies its estimate by 2. that must cover the growth, with room to spare.
        uint256 neededNum = (withBurn * 100) / buysOnly; // per cent of the smaller estimate
        console.log("the larger shape costs this per cent of the smaller:");
        console.log(neededNum);
        assertLt(neededNum, 200, "2x headroom must cover a sell landing between the estimate and the send");
        assertLt(neededNum, 175, "and with margin: at 175% the headroom would be too close to the edge to trust");
    }

    /// @notice And the headroom is bounded: it can never ask for more gas than the keeper's ceiling.
    function test_fork_theHeadroomStaysUnderTheKeepersCeiling() public {
        if (!forked) return;
        MarketZapRouter r = router();
        uint256 bought = buy(r, 0.01 ether);
        sell(r, bought / 3);
        uint256 g = gasleft();
        ILockerLike(LOCKER).collectFees(coin);
        uint256 used = g - gasleft();
        // 3,000,000 is the keeper's absolute cap; a real collection must sit far below it or the cap is wrong
        assertLt(used * 2, 3_000_000, "the padded limit stays inside the keeper's ceiling");
        console.log("padded limit for a real collection:");
        console.log(used * 2);
    }
}
