// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fork} from "./Fork.sol";
import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {UniversalRouterBuy, IUniversalRouter} from "../script/lib/UniversalRouterBuy.sol";
import {MarketTickerRegistrar} from "../src/market/MarketTickerRegistrar.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {TokenParams, Socials, PairEconomics} from "../src/Types.sol";
import {PathKey} from "v4-periphery/src/libraries/PathKey.sol";
import {IV4Router} from "v4-periphery/src/interfaces/IV4Router.sol";
import {IV4Quoter} from "v4-periphery/src/interfaces/IV4Quoter.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";

/// @dev The prototype against the chain's own contracts: the real PoolManager, PositionManager, Permit2, USDG
/// and Universal Router. Nothing is deployed to the chain; the fork is local and discarded.
///
/// This answers one question only: can the canonical router execute a buy through a fixed-inventory name, using
/// the same calldata shape the site builds. It says nothing about whether an outside app would *discover* the
/// route, which is the separate question a live test has to settle.
interface ILaunchDeployerLike {
    function predictToken(address initiator, TokenParams calldata params, uint256 supply) external view returns (address);
}

contract MarketForkTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant POSM = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant V4_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address constant LAUNCH_DEPLOYER = 0xD86C1Cc523256519Dbd608318395e0C97e0368d6;

    uint256 constant SUPPLY = 500_000_000e6;
    uint24 constant FEE = 500;
    int24 constant SPACING = 10;
    int24 constant WIDTH = 30;

    /// @dev The report's numbers were taken at block 58,004,346 (9 September 2026). Nothing asserted here depends on
    /// that block, so the suite forks wherever every other fork suite does (the head, or `FORK_BLOCK`); to reproduce
    /// the report's figures exactly, run with FORK_BLOCK=58004346 against an endpoint that still serves that state.
    address constant FACTORY = 0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f;
    address constant REGISTRY = 0x7927cB22b4C5AA0DBdd851805d3149AAC07e2BC1;
    /// @dev Who owns the live factory and registry: the hardware wallet. Pranked here, never used for real.
    /// @dev Read from the factory rather than written down. The owner is a real wallet, and a test does not
    /// need to name it to prank it.
    function liveOwner() internal view returns (address) {
        return IFactory(FACTORY).owner();
    }

    MarketTickerDeployer deployer;
    address wallet = address(0xBEEF);
    bool forked;

    function setUp() public {
        if (!Fork.select()) return;
        forked = true;
        deployer = new MarketTickerDeployer(
            address(this), IERC20(USDG), IPoolManager(POOL_MANAGER), IPositionManager(POSM),
            IAllowanceTransfer(PERMIT2), SUPPLY, FEE, SPACING, WIDTH
        );
    }

    /// @notice A buy through the chain's own Universal Router, asserted rather than reported. The router call
    /// must succeed, the wallet must receive at least the minimum, and the dollars actually taken must be the
    /// dollars asked for.
    function test_fork_canonicalRouterBuysThroughAFixedInventoryName() public {
        if (!forked) return;
        console.log("fork block");
        console.log(block.number);
        (address name_,) = deployer.create(keccak256("FORKNAME"), "FORKNAME", 6);
        assertEq(IERC20(name_).balanceOf(POOL_MANAGER), SUPPLY, "the whole issuance must sit in the pool");

        uint256 spend = 10_000e6;
        // a minimum that means something: the pool fee is 5 bps, so anything under 25 bps of loss is a real floor
        uint256 minOut = (spend * 9_975) / 10_000;
        deal(USDG, wallet, spend);

        PoolKey[] memory pools = new PoolKey[](1);
        pools[0] = deployer.keyFor(name_);

        vm.startPrank(wallet);
        IERC20(USDG).approve(PERMIT2, spend);
        IAllowanceTransfer(PERMIT2).approve(USDG, UNIVERSAL_ROUTER, uint160(spend), uint48(block.timestamp + 300));

        uint256 nameBefore = IERC20(name_).balanceOf(wallet);
        uint256 usdgBefore = IERC20(USDG).balanceOf(wallet);
        (bool ok, bytes memory ret) = UNIVERSAL_ROUTER.call(_usdgInCalldata(wallet, pools, spend, minOut, block.timestamp + 300));
        vm.stopPrank();

        if (!ok) console.logBytes(ret);
        assertTrue(ok, "the canonical router must execute the buy");

        uint256 delivered = IERC20(name_).balanceOf(wallet) - nameBefore;
        uint256 taken = usdgBefore - IERC20(USDG).balanceOf(wallet);
        console.log("name delivered / dollars taken");
        console.log(delivered);
        console.log(taken);
        assertGe(delivered, minOut, "delivered below the minimum the call demanded");
        assertLe(delivered, spend, "a name must never be sold below par");
        assertEq(taken, spend, "the router must take exactly the dollars the call authorised");
    }

    /// @notice And back out again: the same router selling the name for dollars.
    function test_fork_canonicalRouterSellsBack() public {
        if (!forked) return;
        (address name_,) = deployer.create(keccak256("FORKSELL"), "FORKSELL", 6);
        uint256 spend = 10_000e6;
        deal(USDG, wallet, spend);
        PoolKey[] memory pools = new PoolKey[](1);
        pools[0] = deployer.keyFor(name_);

        vm.startPrank(wallet);
        IERC20(USDG).approve(PERMIT2, type(uint256).max);
        IAllowanceTransfer(PERMIT2).approve(USDG, UNIVERSAL_ROUTER, type(uint160).max, uint48(block.timestamp + 300));
        (bool bought,) = UNIVERSAL_ROUTER.call(_usdgInCalldata(wallet, pools, spend, 1, block.timestamp + 300));
        assertTrue(bought, "setup buy must succeed");

        uint256 hold = IERC20(name_).balanceOf(wallet);
        assertGt(hold, 0, "setup buy delivered nothing");
        IERC20(name_).approve(PERMIT2, hold);
        IAllowanceTransfer(PERMIT2).approve(name_, UNIVERSAL_ROUTER, uint160(hold), uint48(block.timestamp + 300));

        uint256 usdgBefore = IERC20(USDG).balanceOf(wallet);
        uint256 minBack = (hold * 9_950) / 10_000; // two fees, so a floor of 50 bps
        (bool sold, bytes memory ret) = UNIVERSAL_ROUTER.call(_inCalldata(Currency.wrap(name_), wallet, pools, hold, minBack, block.timestamp + 300));
        vm.stopPrank();

        if (!sold) console.logBytes(ret);
        assertTrue(sold, "the canonical router must execute the sell");
        uint256 back = IERC20(USDG).balanceOf(wallet) - usdgBefore;
        console.log("name sold / dollars back");
        console.log(hold);
        console.log(back);
        assertGe(back, minBack, "sold below the minimum the call demanded");
        assertEq(IERC20(name_).balanceOf(wallet), 0, "the whole holding should have been sold");
    }

    /// @notice The whole route a buyer takes and then reverses: ETH to USDG to name to coin, and back out to
    /// ETH, through the chain's own Universal Router. This is the path a customer's app would build.
    ///
    /// It also fixes a mistake in the first draft of the proposal. A name is not an anchor: the registry's kinds
    /// are native, stable and official stock, and a creator-issued name is none of them. FUN is not in the live
    /// registry at all. The correct route is the factory's registrar path, which approves the pair for one
    /// launch, so the only owner call a live test needs is `setRegistrar`.
    function test_fork_ethToCoinAndBack() public {
        if (!forked) return;
        (address name_,) = deployer.create(keccak256("FORKPATH"), "FORKPATH", 6);

        MarketTickerRegistrar registrar = new MarketTickerRegistrar(IFactory(FACTORY), deployer, wallet, name_, 3_236e6);
        vm.prank(liveOwner());
        (bool authorised,) = FACTORY.call(abi.encodeWithSignature("setRegistrar(address,bool)", address(registrar), true));
        assertTrue(authorised, "the one owner call a live test needs must succeed");

        TokenParams memory p = TokenParams({
            name: "forkpath coin", symbol: "FPCOIN", logo: "", description: "",
            socials: Socials("", "", "", "", ""), creatorFeeRecipient: address(0), creatorTaxBps: 0,
            buybackEnabled: false, expectedEconomics: bytes32(0), salt: bytes32(0)
        });
        // the launch pins its own terms: the registrar path has its own preview, because the economics come from
        // the registrar rather than from a globally approved pair
        p.expectedEconomics = IFactory(FACTORY).previewLaunchEconomicsWithPair(
            0, name_, PairEconomics({phantomQuote: 3_236e6, decimals: 6})
        );
        vm.deal(wallet, 1 ether);
        vm.prank(wallet);
        (address coin,) = registrar.launch{value: 0.0005 ether}(p, 0, name_);
        console.log("coin launched against a fixed-inventory name");
        console.log(coin);

        // ETH -> USDG -> name -> coin, one router call
        PoolKey[] memory buy = new PoolKey[](3);
        buy[0] = PoolKey({currency0: Currency.wrap(address(0)), currency1: Currency.wrap(USDG), fee: 100, tickSpacing: 1, hooks: IHooks(address(0))});
        buy[1] = deployer.keyFor(name_);
        buy[2] = _coinKey(coin);

        uint256 spend = 0.02 ether;
        // a minimum that means something, taken from the chain's own quoter and cut by the site's 3% tolerance.
        // this is the shape the live transactions must use; a minimum of one unit proves execution and nothing
        // about the quality of it.
        uint256 quotedCoin = UniversalRouterBuy.quote(IV4Quoter(V4_QUOTER), buy, spend);
        uint256 minCoin = (quotedCoin * 9_700) / 10_000;
        assertGt(minCoin, 0, "a live buy must never be sent with a zero minimum");

        vm.startPrank(wallet);
        uint256 coinBefore = IERC20(coin).balanceOf(wallet);
        uint256 ethAtStart = wallet.balance;
        (bool bought, bytes memory br) = UNIVERSAL_ROUTER.call{value: spend}(_ethInCalldata(wallet, buy, spend, minCoin, block.timestamp + 300));
        if (!bought) console.logBytes(br);
        assertTrue(bought, "the canonical router must buy the coin with ETH");
        uint256 coinOut = IERC20(coin).balanceOf(wallet) - coinBefore;
        console.log("ETH in / quoted coin / minimum / coin out");
        console.log(spend);
        console.log(quotedCoin);
        console.log(minCoin);
        console.log(coinOut);
        assertGe(coinOut, minCoin, "the buy delivered less than the minimum it demanded");
        assertApproxEqRel(coinOut, quotedCoin, 0.005e18, "settled far from the quote");
        // the wallet paid exactly what it sent, with the unspent native swept back
        assertEq(ethAtStart - wallet.balance, spend, "the buy must consume exactly the ETH it was given");

        // and back: coin -> name -> USDG -> ETH
        PoolKey[] memory sell = new PoolKey[](3);
        sell[0] = buy[2];
        sell[1] = buy[1];
        sell[2] = buy[0];
        uint256 quotedEth = _quoteFrom(Currency.wrap(coin), sell, coinOut);
        uint256 minEth = (quotedEth * 9_700) / 10_000;
        assertGt(minEth, 0, "a live sell must never be sent with a zero minimum");

        IERC20(coin).approve(PERMIT2, coinOut);
        IAllowanceTransfer(PERMIT2).approve(coin, UNIVERSAL_ROUTER, uint160(coinOut), uint48(block.timestamp + 300));
        uint256 ethBefore = wallet.balance;
        (bool sold, bytes memory sr) = UNIVERSAL_ROUTER.call(_inCalldata(Currency.wrap(coin), wallet, sell, coinOut, minEth, block.timestamp + 300));
        vm.stopPrank();
        if (!sold) console.logBytes(sr);
        assertTrue(sold, "the canonical router must sell the coin back to ETH");
        uint256 ethBack = wallet.balance - ethBefore;
        console.log("coin in / quoted ETH / minimum / ETH back");
        console.log(coinOut);
        console.log(quotedEth);
        console.log(minEth);
        console.log(ethBack);
        assertGe(ethBack, minEth, "the sell returned less than the minimum it demanded");
        // the whole holding went in, and none of it came back
        assertEq(IERC20(coin).balanceOf(wallet), 0, "the sell must consume the entire coin input");
        // and the round trip costs what the fees say it should: two coin fees, two bridge fees, two ETH hops
        assertLt(ethBack, spend, "a round trip must cost something");
        uint256 costBps = ((spend - ethBack) * 10_000) / spend;
        console.log("round trip cost, bps, across every hop and fee");
        console.log(costBps);
        assertLt(costBps, 400, "a round trip costing more than 4% is not the fee profile we designed");
    }

    function _coinKey(address coin) internal view returns (PoolKey memory) {
        (bool ok, bytes memory ret) = FACTORY.staticcall(abi.encodeWithSignature("poolKeyOf(address)", coin));
        require(ok, "poolKeyOf");
        return abi.decode(ret, (PoolKey));
    }

    /// @dev Native ETH in, along a path, with the dust swept back.
    function _ethInCalldata(address to, PoolKey[] memory pools, uint256 amountIn, uint256 minOut, uint256 deadline)
        internal
        pure
        returns (bytes memory)
    {
        (bytes memory commands, bytes[] memory inputs) = UniversalRouterBuy.encode(to, pools, amountIn, minOut);
        return abi.encodeWithSelector(IUniversalRouter.execute.selector, commands, inputs, deadline);
    }

    /// @dev The same command and action shape the site builds, with USDG as the input instead of native ETH:
    /// V4_SWAP, then SWAP_EXACT_IN / SETTLE_ALL / TAKE_ALL. One dynamic ExactInputParams tuple, as the deployed
    /// router version decodes it, including `minHopPriceX36`.
    function _usdgInCalldata(address to, PoolKey[] memory pools, uint256 amountIn, uint256 minOut, uint256 deadline)
        internal
        pure
        returns (bytes memory)
    {
        return _inCalldata(Currency.wrap(USDG), to, pools, amountIn, minOut, deadline);
    }

    function _inCalldata(Currency currencyIn, address to, PoolKey[] memory pools, uint256 amountIn, uint256 minOut, uint256 deadline)
        internal
        pure
        returns (bytes memory)
    {
        PathKey[] memory keys = new PathKey[](pools.length);
        address input = Currency.unwrap(currencyIn);
        address output;
        for (uint256 i; i < pools.length; i++) {
            address c0 = Currency.unwrap(pools[i].currency0);
            address c1 = Currency.unwrap(pools[i].currency1);
            require(input == c0 || input == c1, "route: disconnected");
            output = input == c0 ? c1 : c0;
            keys[i] = PathKey({
                intermediateCurrency: Currency.wrap(output),
                fee: pools[i].fee,
                tickSpacing: pools[i].tickSpacing,
                hooks: pools[i].hooks,
                hookData: ""
            });
            input = output;
        }
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputParams({
                currencyIn: currencyIn,
                path: keys,
                minHopPriceX36: new uint256[](0),
                amountIn: uint128(amountIn),
                amountOutMinimum: uint128(minOut)
            })
        );
        params[1] = abi.encode(currencyIn, amountIn);
        params[2] = abi.encode(Currency.wrap(output), minOut);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"070c0f", params);
        return abi.encodeWithSelector(IUniversalRouter.execute.selector, hex"10", inputs, deadline);
    }

    /// @dev A quote along a path from a token input, using the chain's own quoter. The production helper quotes
    /// from native ETH only, and this test must not change production code to suit itself.
    function _quoteFrom(Currency currencyIn, PoolKey[] memory pools, uint256 amountIn) internal returns (uint256 out) {
        PathKey[] memory keys = new PathKey[](pools.length);
        address input = Currency.unwrap(currencyIn);
        for (uint256 i; i < pools.length; i++) {
            address c0 = Currency.unwrap(pools[i].currency0);
            address c1 = Currency.unwrap(pools[i].currency1);
            require(input == c0 || input == c1, "quote: disconnected");
            address output = input == c0 ? c1 : c0;
            keys[i] = PathKey({
                intermediateCurrency: Currency.wrap(output),
                fee: pools[i].fee,
                tickSpacing: pools[i].tickSpacing,
                hooks: pools[i].hooks,
                hookData: ""
            });
            input = output;
        }
        (out,) = IV4Quoter(V4_QUOTER).quoteExactInput(
            IV4Quoter.QuoteExactParams({exactCurrency: currencyIn, path: keys, exactAmount: uint128(amountIn)})
        );
        require(out > 0, "quote: zero");
    }

    /// @notice The registrar's limits, proven rather than described: only the test wallet, only the intended
    /// name, only once. This matters because a registrar is authorised on the live factory while the test runs,
    /// and its authorisation is revoked afterwards rather than during.
    function test_fork_registrarRefusesEverythingElse() public {
        if (!forked) return;
        (address name_,) = deployer.create(keccak256("RSTRICT"), "RSTRICT", 6);
        (address other,) = deployer.create(keccak256("RSTRICT2"), "RSTRICT2", 6);

        MarketTickerRegistrar registrar = new MarketTickerRegistrar(IFactory(FACTORY), deployer, wallet, name_, 3_236e6);
        vm.prank(liveOwner());
        (bool authorised,) = FACTORY.call(abi.encodeWithSignature("setRegistrar(address,bool)", address(registrar), true));
        assertTrue(authorised, "setRegistrar must succeed");

        TokenParams memory p = TokenParams({
            name: "restricted", symbol: "RSTC", logo: "", description: "",
            socials: Socials("", "", "", "", ""), creatorFeeRecipient: address(0), creatorTaxBps: 0,
            buybackEnabled: false, expectedEconomics: bytes32(0), salt: bytes32(0)
        });
        p.expectedEconomics = IFactory(FACTORY).previewLaunchEconomicsWithPair(0, name_, PairEconomics({phantomQuote: 3_236e6, decimals: 6}));
        // the salt is ground until the coin sorts below the name, which is what the site must do too
        p.salt = _saltBelow(p, name_);

        // anyone who is not the test wallet
        address stranger = address(0xDEAD);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(MarketTickerRegistrar.NotTheTestWallet.selector);
        registrar.launch{value: 0.0005 ether}(p, 0, name_);

        // the right wallet, the wrong name
        vm.deal(wallet, 1 ether);
        vm.prank(wallet);
        vm.expectRevert(MarketTickerRegistrar.NotTheName.selector);
        registrar.launch{value: 0.0005 ether}(p, 0, other);

        // the one permitted launch
        vm.prank(wallet);
        (address coin,) = registrar.launch{value: 0.0005 ether}(p, 0, name_);
        assertTrue(coin != address(0), "the one launch must work");
        assertTrue(registrar.spent(), "the registrar must close after its launch");

        // and never again, even for the right wallet and name
        TokenParams memory q = p;
        q.symbol = "RSTC2";
        q.name = "restricted two";
        vm.prank(wallet);
        vm.expectRevert(MarketTickerRegistrar.AlreadyUsed.selector);
        registrar.launch{value: 0.0005 ether}(q, 0, name_);

        console.log("registrar refused a stranger, the wrong name, and a second launch");
    }

    /// @notice Regression: a coin that would sort above its name must be refused on this path, the same way
    /// `TickerLauncher` refuses one on its own path. PROBE was launched before this check existed, which is why
    /// it landed inverted; nothing should be able to do that again.
    function test_fork_registrarRefusesACoinThatSortsAboveTheName() public {
        if (!forked) return;
        (address name_,) = deployer.create(keccak256("ORDGUARD"), "ORDGUARD", 6);

        MarketTickerRegistrar r = new MarketTickerRegistrar(IFactory(FACTORY), deployer, wallet, name_, 3_236e6);
        vm.prank(liveOwner());
        (bool ok,) = FACTORY.call(abi.encodeWithSignature("setRegistrar(address,bool)", address(r), true));
        assertTrue(ok, "setRegistrar");

        // a salt whose coin address sorts ABOVE the name: the case that must revert
        TokenParams memory p = TokenParams({
            name: "sorts above", symbol: "ABOVE", logo: "", description: "",
            socials: Socials("", "", "", "", ""), creatorFeeRecipient: address(0), creatorTaxBps: 0,
            buybackEnabled: false, expectedEconomics: bytes32(0), salt: bytes32(0)
        });
        p.expectedEconomics = IFactory(FACTORY).previewLaunchEconomicsWithPair(0, name_, PairEconomics({phantomQuote: 3_236e6, decimals: 6}));
        address bad;
        for (uint256 i = 1; i < 20_000; ++i) {
            p.salt = bytes32(i);
            address a = ILaunchDeployerLike(LAUNCH_DEPLOYER).predictToken(wallet, p, 1_000_000_000e18);
            if (a > name_) { bad = a; break; }
        }
        require(bad != address(0), "no inverted salt found");

        vm.deal(wallet, 1 ether);
        vm.prank(wallet);
        vm.expectRevert(abi.encodeWithSelector(MarketTickerRegistrar.CoinNotFirst.selector, bad, name_));
        r.launch{value: 0.0005 ether}(p, 0, name_);
        console.log("an inverted coin was refused, as TickerLauncher refuses one on its own path");
    }

    /// @dev The first salt whose coin address sorts below the name. The frontend must grind the same way, or a
    /// launch reverts with CoinNotFirst instead of producing an inverted pair.
    function _saltBelow(TokenParams memory p, address name_) internal view returns (bytes32) {
        for (uint256 i = 1; i < 50_000; ++i) {
            p.salt = bytes32(i);
            if (ILaunchDeployerLike(LAUNCH_DEPLOYER).predictToken(wallet, p, 1_000_000_000e18) < name_) return bytes32(i);
        }
        revert("no salt sorts below the name");
    }
}
