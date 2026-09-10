// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fork} from "./Fork.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {MarketTickerLauncher} from "../src/market/MarketTickerLauncher.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {QuoteRegistry, ITickerLauncherLike} from "../src/market/QuoteRegistry.sol";
import {IQuoteKind} from "../src/market/IQuoteKind.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {ISeederLike} from "../src/market/QuoteConverter.sol";
import {TokenParams, Socials, PairEconomics, LaunchedToken, LaunchConfig} from "../src/Types.sol";
import {MarketZapRouter} from "../src/market/MarketZapRouter.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IWETH9} from "v4-periphery/src/interfaces/external/IWETH9.sol";

interface ILaunchDeployerLike {
    function predictToken(address initiator, TokenParams calldata params, uint256 supply) external view returns (address);
}

/// @dev The reusable launcher, against the live factory: a coin under a name that already exists, a coin under a
/// name made in the same transaction, and the three things it refuses.
contract MarketTickerLauncherForkTest is Test {
    address constant FACTORY = 0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f;
    address constant SEEDER = 0x3733576410312D34B53F90cFE513B0D0995aB6Ca;
    address constant LAUNCH_DEPLOYER = 0xD86C1Cc523256519Dbd608318395e0C97e0368d6;
    address constant LIVE_TICKER_LAUNCHER = 0x7f6c8bA781b5bDC499F2BA7501A2178508877649;
    address constant MARKET_DEPLOYER = 0x0F72C545Bd455DB7184F5B0eA4725f5AA8494418;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant TESTNAME = 0x4Dd89f107d9b8395237719FA9d621a7A5BC00c52;
    uint256 supply; // the launch config's own, read from the factory

    MarketTickerLauncher launcher;
    /// @dev A second launcher, over an issuer that answers to it. Making a name needs that: the live issuer
    /// answers to the wallet that deployed it, so nothing else can mint a name through it.
    MarketTickerLauncher selfLauncher;
    MarketTickerDeployer issuer;
    MarketTickerDeployer ownIssuer;
    address creator = address(0xC0FFEE);
    address owner;
    uint256 CFG; // an enabled 82 bps configuration: the only fee this launcher will accept
    bool forked;

    function setUp() public {
        if (!Fork.select()) return;
        forked = true;
        owner = IFactory(FACTORY).owner();
        issuer = MarketTickerDeployer(MARKET_DEPLOYER);
        supply = IFactory(FACTORY).getLaunchConfig(0).supply;
        launcher = new MarketTickerLauncher(IFactory(FACTORY), issuer);

        // the issuer is built naming the launcher that will own it, which is the next address this test creates
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        ownIssuer = new MarketTickerDeployer(
            next, IERC20(USDG), ISeederLike(SEEDER).poolManager(), issuer.posm(), issuer.permit2(),
            issuer.supply(), issuer.fee(), issuer.spacing(), issuer.width()
        );
        selfLauncher = new MarketTickerLauncher(IFactory(FACTORY), ownIssuer);
        assertEq(address(selfLauncher), next, "the issuer names the launcher that owns it");

        LaunchConfig memory base = IFactory(FACTORY).getLaunchConfig(0);
        CFG = IFactory(FACTORY).launchConfigCount();
        vm.startPrank(owner);
        (bool ok,) = FACTORY.call(abi.encodeWithSignature("setRegistrar(address,bool)", address(launcher), true));
        (bool ok2,) = FACTORY.call(abi.encodeWithSignature("setRegistrar(address,bool)", address(selfLauncher), true));
        (bool ok3,) = FACTORY.call(
            abi.encodeWithSignature(
                "addLaunchConfig((uint256,uint256,uint256,int24,bool))",
                LaunchConfig({supply: base.supply, baseFeeBps: 82, phantomQuote: base.phantomQuote, tickSpacing: base.tickSpacing, enabled: true})
            )
        );
        require(ok3, "addLaunchConfig");
        vm.stopPrank();
        require(ok && ok2, "setRegistrar");
        vm.deal(creator, 10 ether);
    }

    function params(string memory symbol) internal view returns (TokenParams memory p) {
        p = TokenParams({
            name: symbol, symbol: symbol, logo: "", description: "",
            socials: Socials("", "", "", "", ""), creatorFeeRecipient: address(0), creatorTaxBps: 0,
            buybackEnabled: false, expectedEconomics: bytes32(0), salt: bytes32(0)
        });
        p.expectedEconomics = launcher.previewEconomics(CFG, address(0)); // filled per name below
    }

    /// @dev The first salt whose coin address sorts below the name, which is what the front end must grind for.
    function saltBelow(TokenParams memory p, address name) internal view returns (bytes32) {
        for (uint256 i = 1; i < 80_000; ++i) {
            p.salt = bytes32(i);
            if (ILaunchDeployerLike(LAUNCH_DEPLOYER).predictToken(creator, p, supply) < name) return bytes32(i);
        }
        revert("no salt sorts below the name");
    }

    function fee() internal view returns (uint256) {
        return IFactory(FACTORY).launchFee();
    }

    // ---------------------------------------------------------------- an existing name

    /// @notice A coin under a name that already exists, opened on the dollar's own economics and sorted first in
    /// its own pool.
    function test_fork_launchesUnderAnExistingName() public {
        if (!forked) return;
        TokenParams memory p = params("UNDEREXISTING");
        p.expectedEconomics = launcher.previewEconomics(CFG, TESTNAME);
        p.salt = saltBelow(p, TESTNAME);

        // the fee is read first: a call inside the argument list would spend the prank before the launch
        uint256 f = fee();
        vm.prank(creator);
        (address token,) = launcher.launch{value: f}(p, CFG, TESTNAME);

        LaunchedToken memory l = IFactory(FACTORY).getLaunchedToken(token);
        console.log("coin / name / phantom quote");
        console.log(token);
        console.log(TESTNAME);
        console.log(l.phantomQuote);
        assertTrue(l.exists, "the factory recorded it");
        assertEq(l.pairToken, TESTNAME, "priced in the name");
        assertTrue(token < TESTNAME, "and sorted first in its own pool");
        assertEq(l.phantomQuote, launcher.economics().phantomQuote, "on the economics the launcher published");
        assertEq(IERC20(token).balanceOf(creator), 0, "a launch alone buys nothing");
    }

    // ---------------------------------------------------------------- a name made on the way

    /// @notice A name and its first coin in one transaction. Both addresses are known before either exists, so
    /// the ordering can be ground for in advance.
    function test_fork_makesANameAndLaunchesUnderItAtOnce() public {
        if (!forked) return;
        bytes32 nameSalt = keccak256("FRESHNAME");
        address predictedName = selfLauncher.predictName(nameSalt, "FRESHNAME", 6);

        TokenParams memory p = params("UNDERFRESH");
        p.expectedEconomics = selfLauncher.previewEconomics(CFG, predictedName);
        p.salt = saltBelow(p, predictedName);

        uint256 f = fee();
        vm.prank(creator);
        (address name, address token,) = selfLauncher.createAndLaunch{value: f}(nameSalt, "FRESHNAME", 6, p, CFG);

        assertEq(name, predictedName, "the name landed where it was predicted");
        assertEq(ownIssuer.market(name).token, name, "and the issuer made it");
        assertTrue(token < name, "the coin sorts first");
        assertEq(IFactory(FACTORY).getLaunchedToken(token).pairToken, name);

        // and the registry can classify it straight away, with nothing recorded
        QuoteRegistry reg = new QuoteRegistry(ITickerLauncherLike(LIVE_TICKER_LAUNCHER), ownIssuer, USDG);
        assertEq(uint256(reg.provenanceOf(name)), uint256(IQuoteKind.Kind.FIXED_INVENTORY_MARKET));
        console.log("name and coin, one transaction");
        console.log(name);
        console.log(token);
    }

    // ---------------------------------------------------------------- what it refuses

    /// @notice A coin that sorts above its name is refused, exactly as the managed launcher refuses one.
    function test_fork_refusesACoinThatSortsAboveTheName() public {
        if (!forked) return;
        TokenParams memory p = params("SORTSABOVE");
        p.expectedEconomics = launcher.previewEconomics(CFG, TESTNAME);
        address bad;
        for (uint256 i = 1; i < 80_000; ++i) {
            p.salt = bytes32(i);
            address a = ILaunchDeployerLike(LAUNCH_DEPLOYER).predictToken(creator, p, supply);
            if (a > TESTNAME) { bad = a; break; }
        }
        require(bad != address(0), "no inverted salt found");

        uint256 f = fee();
        vm.startPrank(creator);
        vm.expectRevert(abi.encodeWithSelector(MarketTickerLauncher.CoinNotFirst.selector, bad, TESTNAME));
        launcher.launch{value: f}(p, CFG, TESTNAME);
        vm.stopPrank();
    }

    /// @notice A token the market issuer did not make is refused, so registrar powers cannot be borrowed to open
    /// a pool against something arbitrary.
    function test_fork_refusesANameItsIssuerNeverMade() public {
        if (!forked) return;
        TokenParams memory p = params("NOTANAME");
        uint256 f = fee();
        vm.startPrank(creator);
        vm.expectRevert(abi.encodeWithSelector(MarketTickerLauncher.UnknownMarket.selector, USDG));
        launcher.launch{value: f}(p, CFG, USDG);
        vm.stopPrank();
    }

    /// @notice The economics are the launcher's, read from the factory, not something a caller can hand it.
    function test_fork_theEconomicsAreNotACallersToChoose() public {
        if (!forked) return;
        (uint256 phantom, uint8 decimals) = IFactory(FACTORY).pairTokenEconomics(USDG);
        PairEconomics memory e = launcher.economics();
        assertEq(e.phantomQuote, phantom, "the dollar's own opening size");
        assertEq(e.decimals, decimals);

        // a launch whose expected economics say anything else does not go through
        TokenParams memory p = params("WRONGECON");
        p.expectedEconomics = bytes32(uint256(1));
        p.salt = saltBelow(p, TESTNAME);
        uint256 f = fee();
        vm.startPrank(creator);
        vm.expectRevert();
        launcher.launch{value: f}(p, CFG, TESTNAME);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- the whole journey

    /// @notice A name and a coin made together, classified from the chain, then bought and sold with ether by
    /// somebody who had nothing to do with the launch. This is the journey end to end, on live pools, in one
    /// test, so a break anywhere along it shows up here.
    function test_fork_createThenClassifyThenBuyThenSell() public {
        if (!forked) return;
        bytes32 nameSalt = keccak256("JOURNEY");
        address predictedName = selfLauncher.predictName(nameSalt, "JOURNEY", 6);
        TokenParams memory p = params("JOURNEYCOIN");
        p.expectedEconomics = selfLauncher.previewEconomics(CFG, predictedName);
        p.salt = saltBelow(p, predictedName);

        uint256 f = fee();
        vm.prank(creator);
        (address name, address coin,) = selfLauncher.createAndLaunch{value: f}(nameSalt, "JOURNEY", 6, p, CFG);

        // 1. anyone can tell what the name is, from the issuers alone, with nothing recorded anywhere
        QuoteRegistry reg = new QuoteRegistry(ITickerLauncherLike(LIVE_TICKER_LAUNCHER), ownIssuer, USDG);
        assertEq(uint256(reg.provenanceOf(name)), uint256(IQuoteKind.Kind.FIXED_INVENTORY_MARKET), "a market");
        reg.record(name);

        // the launch window's caps and snipe tax are a separate mechanism with its own tests; this journey is
        // about the name, so it runs after that window has closed
        vm.roll(block.number + 1); // a coin refuses to move in its own launch block
        vm.warp(block.timestamp + 25 hours);

        // 2. a stranger buys the coin with ether, through the name's market and the coin's own pool
        MarketZapRouter router = new MarketZapRouter(
            IFactory(FACTORY), ISeederLike(SEEDER).poolManager(), IWETH9(WETH), reg
        );
        address buyer = address(0xB0B);
        vm.deal(buyer, 5 ether);
        MarketZapRouter.Hop[] memory path = new MarketZapRouter.Hop[](3);
        path[0] = MarketZapRouter.Hop({kind: 0, key: PoolKey(Currency.wrap(address(0)), Currency.wrap(USDG), 100, 1, IHooks(address(0))), pool: address(0)});
        path[1] = MarketZapRouter.Hop({kind: 0, key: ownIssuer.keyFor(name), pool: address(0)});
        path[2] = MarketZapRouter.Hop({kind: 0, key: IFactory(FACTORY).poolKeyOf(coin), pool: address(0)});

        vm.prank(buyer);
        uint256 bought = router.zapBuy{value: 0.01 ether}(
            MarketZapRouter.ZapParams({
                token: coin, tokenIn: address(0), amountIn: 0, path: path,
                minTokensOut: 1, recipient: buyer, deadline: block.timestamp + 300
            })
        );
        assertGt(bought, 0, "the coin arrived");
        assertEq(IERC20(coin).balanceOf(buyer), bought, "in the buyer's own wallet");

        // 3. and sells it back the same way
        MarketZapRouter.Hop[] memory back = new MarketZapRouter.Hop[](3);
        back[0] = path[2];
        back[1] = path[1];
        back[2] = path[0];
        uint256 ethBefore = buyer.balance;
        vm.startPrank(buyer);
        IERC20(coin).approve(address(router), bought);
        uint256 got = router.zapSell(
            MarketZapRouter.ZapSellParams({
                token: coin, amountIn: bought, path: back, tokenOut: address(0),
                minOut: 1, recipient: buyer, deadline: block.timestamp + 300
            })
        );
        vm.stopPrank();

        console.log("name / coin / bought / ether back");
        console.log(name);
        console.log(coin);
        console.log(bought);
        console.log(got);
        assertGt(got, 0, "ether came back");
        assertEq(buyer.balance, ethBefore + got);
        assertEq(IERC20(coin).balanceOf(address(router)), 0, "nothing stranded in the router");
        assertEq(IERC20(name).balanceOf(address(router)), 0);
    }

    // ---------------------------------------------------------------- decimals

    /// @notice A name must carry the counter's decimals. The market opens at parity in raw units and the
    /// economics are the counter's, so a name with different decimals is worth a power of ten more or less than
    /// the price those two agree on. It is refused at creation, at prediction, and at launch against one that
    /// already exists.
    function test_fork_aNameMustCarryTheCountersDecimals() public {
        if (!forked) return;
        uint8 want = launcher.requiredDecimals();
        assertEq(want, IERC20Metadata(USDG).decimals(), "the counter's own");

        TokenParams memory p = params("WRONGDEC");
        uint256 f = fee();
        for (uint8 d = 0; d < 19; d++) {
            if (d == want) continue;
            vm.expectRevert(abi.encodeWithSelector(MarketTickerLauncher.DecimalsMismatch.selector, address(0), d, want));
            selfLauncher.predictName(keccak256(abi.encodePacked("WRONG", d)), "WRONG", d);

            vm.prank(creator);
            vm.expectRevert(abi.encodeWithSelector(MarketTickerLauncher.DecimalsMismatch.selector, address(0), d, want));
            selfLauncher.createAndLaunch{value: f}(keccak256(abi.encodePacked("WRONG", d)), "WRONG", d, p, CFG);
        }
    }

    /// @notice And a market that already exists with the wrong decimals cannot be launched against, however it
    /// came to be. The check is on the name itself, not on how it was made.
    function test_fork_anExistingNameWithWrongDecimalsIsRefused() public {
        if (!forked) return;
        // an issuer of three-decimal names, which this launcher will not accept
        MarketTickerDeployer odd = new MarketTickerDeployer(
            address(this), IERC20(USDG), ISeederLike(SEEDER).poolManager(), issuer.posm(), issuer.permit2(),
            issuer.supply(), issuer.fee(), issuer.spacing(), issuer.width()
        );
        (address oddName,) = odd.create(keccak256("ODDDEC"), "ODDDEC", 3);
        MarketTickerLauncher over = new MarketTickerLauncher(IFactory(FACTORY), odd);
        vm.prank(owner);
        (bool ok,) = FACTORY.call(abi.encodeWithSignature("setRegistrar(address,bool)", address(over), true));
        require(ok, "setRegistrar");

        assertEq(odd.market(oddName).token, oddName, "the issuer really made it, so provenance is not the objection");
        TokenParams memory p = params("UNDERODD");
        uint256 f = fee();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MarketTickerLauncher.DecimalsMismatch.selector, oddName, uint8(3), uint8(6)));
        over.launch{value: f}(p, CFG, oddName);
    }
    // ---------------------------------------------------------------- the fee is not a caller's to choose

    /// @notice The 82 bps promise is enforced by the contract, not by which configuration the owner enabled.
    ///
    /// The factory authorises a registrar, not a configuration. An authorised launcher may name any enabled
    /// configuration id, so without this check a coin could be launched through the new path at the older
    /// 100 bps, and the path's advertised fee would simply be untrue. Configuration 0 is enabled on the live
    /// factory and charges 100 bps, so it is the exact case that matters.
    function test_fork_refusesAConfigurationThatIsNotTheFrozenFee() public {
        if (!forked) return;
        LaunchConfig memory zero = IFactory(FACTORY).getLaunchConfig(0);
        assertEq(zero.baseFeeBps, 100, "config 0 is the older fee");
        assertTrue(zero.enabled, "and it is enabled, which is what makes this reachable");

        TokenParams memory p = params("WRONGFEE");
        p.expectedEconomics = launcher.previewEconomics(0, TESTNAME);
        p.salt = saltBelow(p, TESTNAME);
        uint256 f = fee();

        vm.startPrank(creator);
        vm.expectRevert(abi.encodeWithSelector(MarketTickerLauncher.NotTheFrozenFee.selector, uint256(100), uint16(0)));
        launcher.launch{value: f}(p, 0, TESTNAME);
        vm.stopPrank();
    }

    /// @notice And a creator surcharge is refused too: 82 bps plus a tax is not 82 bps.
    function test_fork_refusesACreatorSurchargeOnTopOfTheFrozenFee() public {
        if (!forked) return;
        TokenParams memory p = params("SURCHARGE");
        p.creatorTaxBps = 200;
        p.expectedEconomics = launcher.previewEconomics(CFG, TESTNAME);
        p.salt = saltBelow(p, TESTNAME);
        uint256 f = fee();

        vm.startPrank(creator);
        vm.expectRevert(abi.encodeWithSelector(MarketTickerLauncher.NotTheFrozenFee.selector, uint256(82), uint16(200)));
        launcher.launch{value: f}(p, CFG, TESTNAME);
        vm.stopPrank();
    }

}
