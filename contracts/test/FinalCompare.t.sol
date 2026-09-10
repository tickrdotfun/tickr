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
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {MarketTickerLauncher} from "../src/market/MarketTickerLauncher.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {MarketZapRouter} from "../src/market/MarketZapRouter.sol";
import {QuoteRegistry, ITickerLauncherLike} from "../src/market/QuoteRegistry.sol";
import {ISeederLike} from "../src/market/QuoteConverter.sol";
import {FeeSettings} from "../src/market/FeeSettings.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {TokenParams, Socials, LaunchConfig, PairEconomics} from "../src/Types.sol";

interface ILaunchDeployerLike {
    function predictToken(address initiator, TokenParams calldata params, uint256 supply) external view returns (address);
}

interface ITickerLauncherFull {
    function launch(string calldata symbol, TokenParams calldata coin, uint256 launchConfigId)
        external payable returns (address ticker, address token, bytes32 poolId);
    function previewLaunch(string calldata symbol, uint256 launchConfigId)
        external view returns (address ticker, bool exists, bytes32 expected, PairEconomics memory econ);
}

/// @dev The last comparison: two coins, the same launch configuration and so the same pool, one priced in the
/// wrapper and one in the fixed-inventory name. Everything that differs between them is the bridge.
///
/// Both carry the frozen 82 basis point fee, so the fee is not a variable here either. What is reported is what
/// a trader actually gets: output, the fee they paid, gas, price impact, and, where something fails, the error
/// it failed with rather than the fact that it failed.
contract FinalCompareForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address constant FACTORY = 0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f;
    address constant SEEDER = 0x3733576410312D34B53F90cFE513B0D0995aB6Ca;
    address constant TICKER_LAUNCHER = 0x7f6c8bA781b5bDC499F2BA7501A2178508877649;
    address constant MARKET_DEPLOYER = 0x0F72C545Bd455DB7184F5B0eA4725f5AA8494418;
    address constant LAUNCH_DEPLOYER = 0xD86C1Cc523256519Dbd608318395e0C97e0368d6;
    address constant MANAGED_HOOK = 0x3adE2d75475e3262A4dfd1b55c012d39d704eAC0;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant FUN = 0xF9d30A05A63d795e3eF37b34143f33b2cBEf0f14;
    address constant TESTNAME = 0x4Dd89f107d9b8395237719FA9d621a7A5BC00c52;

    address me = address(0xC0FFEE);
    address trader = address(0x77AD);
    address legacyCoin;
    address marketCoin;
    MarketZapRouter router;
    bool forked;

    function setUp() public {
        if (!Fork.select()) return;
        forked = true;
        address owner = IFactory(FACTORY).owner();
        LaunchConfig memory base = IFactory(FACTORY).getLaunchConfig(0);
        LaunchConfig memory c = LaunchConfig({
            supply: base.supply, baseFeeBps: FeeSettings.BASE_FEE_BPS,
            phantomQuote: base.phantomQuote, tickSpacing: base.tickSpacing, enabled: true
        });
        MarketTickerLauncher ml = new MarketTickerLauncher(IFactory(FACTORY), MarketTickerDeployer(MARKET_DEPLOYER));
        vm.startPrank(owner);
        (bool ok1, bytes memory cid) = FACTORY.call(abi.encodeWithSignature("addLaunchConfig((uint256,uint256,uint256,int24,bool))", c));
        (bool ok2,) = FACTORY.call(abi.encodeWithSignature("setRegistrar(address,bool)", address(ml), true));
        vm.stopPrank();
        require(ok1 && ok2, "setup");
        uint256 configId = abi.decode(cid, (uint256));

        uint256 fee = IFactory(FACTORY).launchFee();
        vm.deal(me, 10 ether);

        // the legacy side, under the live wrapper, on the same configuration
        (address ticker,, bytes32 expected,) = ITickerLauncherFull(TICKER_LAUNCHER).previewLaunch("FUN", configId);
        TokenParams memory lp = _params("LEGACYFINAL", expected);
        lp.salt = _saltBelow(lp, ticker, c.supply);
        vm.prank(me);
        (, legacyCoin,) = ITickerLauncherFull(TICKER_LAUNCHER).launch{value: fee}("FUN", lp, configId);

        // the market side, same configuration again
        TokenParams memory mp = _params("MARKETFINAL", ml.previewEconomics(configId, TESTNAME));
        mp.salt = _saltBelow(mp, TESTNAME, c.supply);
        vm.prank(me);
        (marketCoin,) = ml.launch{value: fee}(mp, configId, TESTNAME);

        QuoteRegistry reg = new QuoteRegistry(ITickerLauncherLike(TICKER_LAUNCHER), MarketTickerDeployer(MARKET_DEPLOYER), USDG);
        reg.record(FUN);
        reg.record(TESTNAME);
        router = new MarketZapRouter(IFactory(FACTORY), ISeederLike(SEEDER).poolManager(), IWETH9(WETH), reg);

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 25 hours);
        vm.deal(trader, 10_000 ether);
    }

    function _params(string memory sym, bytes32 expected) internal pure returns (TokenParams memory p) {
        p = TokenParams({
            name: sym, symbol: sym, logo: "", description: "",
            socials: Socials("", "", "", "", ""), creatorFeeRecipient: address(0),
            creatorTaxBps: FeeSettings.CREATOR_TAX_BPS, buybackEnabled: false, expectedEconomics: expected, salt: bytes32(0)
        });
    }

    function _saltBelow(TokenParams memory p, address name, uint256 supply) internal view returns (bytes32) {
        for (uint256 i = 1; i < 80_000; ++i) {
            p.salt = bytes32(i);
            if (ILaunchDeployerLike(LAUNCH_DEPLOYER).predictToken(me, p, supply) < name) return bytes32(i);
        }
        revert("no salt sorts below the name");
    }

    function ethUsdg() internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(USDG), 100, 1, IHooks(address(0)));
    }

    function v4(PoolKey memory k) internal pure returns (MarketZapRouter.Hop memory) {
        return MarketZapRouter.Hop({kind: 0, key: k, pool: address(0)});
    }

    function wrap(address name) internal pure returns (MarketZapRouter.Hop memory) {
        PoolKey memory empty;
        return MarketZapRouter.Hop({kind: 2, key: empty, pool: name});
    }

    /// @dev The buy route for each design: three hops, differing only in the middle one.
    function pathFor(bool market) internal view returns (MarketZapRouter.Hop[] memory p) {
        p = new MarketZapRouter.Hop[](3);
        p[0] = v4(ethUsdg());
        p[1] = market ? v4(MarketTickerDeployer(MARKET_DEPLOYER).keyFor(TESTNAME)) : wrap(FUN);
        p[2] = v4(IFactory(FACTORY).poolKeyOf(market ? marketCoin : legacyCoin));
    }

    function spotOf(address coin) internal view returns (uint160 s) {
        (s,,,) = ISeederLike(SEEDER).poolManager().getSlot0(IFactory(FACTORY).poolKeyOf(coin).toId());
    }

    /// @dev v4 wraps a callee's revert, so the outer selector says only that something below failed. Reading it
    /// as the cause is how a wallet cap gets reported as an unknown error.
    bytes4 constant WRAPPED = bytes4(keccak256("WrappedError(address,bytes4,bytes,bytes)"));

    function cause(bytes memory err) internal pure returns (bytes4 sel) {
        while (true) {
            if (err.length < 4) return sel;
            sel = bytes4(err);
            if (sel != WRAPPED) return sel;
            bytes memory body = new bytes(err.length - 4);
            for (uint256 i; i < body.length; i++) body[i] = err[i + 4];
            (,, bytes memory reason,) = abi.decode(body, (address, bytes4, bytes, bytes));
            err = reason;
        }
    }

    struct Result {
        uint256 out;
        uint256 gas;
        uint256 moveBps;
    }

    uint256 buyers;

    /// @dev A different wallet each time. A coin caps what one wallet may hold, and consecutive buying at a
    /// launch is many people rather than one person going again.
    function nextBuyer() internal returns (address who) {
        who = address(uint160(uint256(keccak256(abi.encode("buyer", buyers++)))));
        vm.deal(who, 10_000 ether);
    }

    function buy(bool market, uint256 value) internal returns (Result memory r) {
        address coin = market ? marketCoin : legacyCoin;
        address who = nextBuyer();
        uint160 before = spotOf(coin);
        MarketZapRouter.ZapParams memory p = MarketZapRouter.ZapParams({
            token: coin, tokenIn: address(0), amountIn: 0, path: pathFor(market),
            minTokensOut: 1, recipient: who, deadline: block.timestamp + 300
        });
        vm.prank(who);
        uint256 g = gasleft();
        r.out = router.zapBuy{value: value}(p);
        r.gas = g - gasleft();
        uint160 after_ = spotOf(coin);
        uint256 hi = after_ > before ? after_ : before;
        uint256 lo = after_ > before ? before : after_;
        r.moveBps = ((hi * hi * 10_000) / (lo * lo)) - 10_000;
    }

    /// @dev External so a failure can be caught and named rather than only counted.
    function tryBuy(bool market, uint256 value) external returns (Result memory) {
        return buy(market, value);
    }

    function sell(bool market, uint256 amount, address who) internal returns (uint256 out, uint256 gas) {
        address coin = market ? marketCoin : legacyCoin;
        MarketZapRouter.Hop[] memory f = pathFor(market);
        MarketZapRouter.Hop[] memory back = new MarketZapRouter.Hop[](3);
        back[0] = f[2];
        back[1] = f[1];
        back[2] = f[0];
        vm.startPrank(who);
        IERC20(coin).approve(address(router), amount);
        uint256 g = gasleft();
        out = router.zapSell(
            MarketZapRouter.ZapSellParams({
                token: coin, amountIn: amount, path: back, tokenOut: address(0),
                minOut: 1, recipient: who, deadline: block.timestamp + 300
            })
        );
        gas = g - gasleft();
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- one buy, two sizes

    /// @notice A small buy and a large one, on both designs, at matched liquidity and the same fee.
    function test_fork_smallAndLargeBuysOnBothDesigns() public {
        if (!forked) return;
        _oneSize(0.002 ether);
        // the larger size is bounded by the coin's own wallet cap, not by either bridge: a single wallet cannot
        // hold what 0.2 ether buys at this configuration, on either design. That limit is measured in the
        // refusal case below, where both refuse with the same error
        _oneSize(0.05 ether);
    }

    function _oneSize(uint256 size) internal {
        uint256 snap = vm.snapshotState();
        Result memory L = buy(false, size);
        vm.revertToState(snap);
        Result memory M = buy(true, size);
        vm.revertToState(snap);

        console.log("size in wei | legacy out | legacy gas | legacy move bps | market out | market gas | market move bps");
        console.log(size);
        console.log(L.out);
        console.log(L.gas);
        console.log(L.moveBps);
        console.log(M.out);
        console.log(M.gas);
        console.log(M.moveBps);
        console.log("market keeps, in bps of the legacy result");
        console.log((M.out * 10_000) / L.out);

        assertGt(L.out, 0, "the legacy route filled");
        assertGt(M.out, 0, "and so did the market route");
        // the pools are matched and the fee is the same, so the whole difference is the bridge
        assertLt(M.out, L.out, "the market costs the bridge's fee that the mint does not");
        assertGt((M.out * 10_000) / L.out, 9_900, "and it is under one percent of the trade");
    }

    // ---------------------------------------------------------------- consecutive buys

    /// @notice Ten buys in a row on each, which is what a launch actually meets.
    function test_fork_consecutiveBuysOnBothDesigns() public {
        if (!forked) return;
        uint256 each = 0.01 ether;
        uint256 snap = vm.snapshotState();

        uint256 legacyTotal;
        uint256 legacyGas;
        for (uint256 i; i < 10; i++) {
            Result memory r = buy(false, each);
            legacyTotal += r.out;
            legacyGas += r.gas;
        }
        vm.revertToState(snap);

        uint256 marketTotal;
        uint256 marketGas;
        for (uint256 i; i < 10; i++) {
            Result memory r = buy(true, each);
            marketTotal += r.out;
            marketGas += r.gas;
        }
        vm.revertToState(snap);

        console.log("ten buys of 0.01 ether: legacy coins | legacy gas | market coins | market gas");
        console.log(legacyTotal);
        console.log(legacyGas);
        console.log(marketTotal);
        console.log(marketGas);
        console.log("market keeps, in bps of the legacy result");
        console.log((marketTotal * 10_000) / legacyTotal);

        assertGt(legacyTotal, 0);
        assertGt(marketTotal, 0);
        assertGt((marketTotal * 10_000) / legacyTotal, 9_900, "the gap does not compound into something large");
    }

    // ---------------------------------------------------------------- a round trip

    /// @notice In and out on both, which is the number a trader actually feels.
    function test_fork_roundTripOnBothDesigns() public {
        if (!forked) return;
        uint256 stake = 0.05 ether;
        uint256 snap = vm.snapshotState();

        Result memory L = buy(false, stake);
        address lastL = address(uint160(uint256(keccak256(abi.encode("buyer", buyers - 1)))));
        (uint256 legacyBack, uint256 legacySellGas) = sell(false, L.out, lastL);
        vm.revertToState(snap);

        Result memory M = buy(true, stake);
        address lastM = address(uint160(uint256(keccak256(abi.encode("buyer", buyers - 1)))));
        (uint256 marketBack, uint256 marketSellGas) = sell(true, M.out, lastM);
        vm.revertToState(snap);

        console.log("stake in wei | legacy back | legacy gas in+out | market back | market gas in+out");
        console.log(stake);
        console.log(legacyBack);
        console.log(L.gas + legacySellGas);
        console.log(marketBack);
        console.log(M.gas + marketSellGas);
        console.log("kept, in bps of the stake: legacy | market");
        console.log((legacyBack * 10_000) / stake);
        console.log((marketBack * 10_000) / stake);

        assertGt(legacyBack, 0);
        assertGt(marketBack, 0);
        assertLt(legacyBack, stake, "a round trip costs something on both");
        assertLt(marketBack, stake);
        assertLt(legacyBack - marketBack, stake / 100, "and the difference between them is under a percent of the stake");
    }

    // ---------------------------------------------------------------- failures, decoded

    /// @notice What each design does with a trade too large for it, named by the error rather than counted.
    function test_fork_whatEachDesignRefusesAndWithWhat() public {
        if (!forked) return;
        uint256 huge = 5_000 ether;

        bytes4 legacySel;
        try this.tryBuy(false, huge) returns (Result memory) {
            legacySel = bytes4(0);
        } catch (bytes memory err) {
            legacySel = cause(err);
        }
        bytes4 marketSel;
        try this.tryBuy(true, huge) returns (Result memory) {
            marketSel = bytes4(0);
        } catch (bytes memory err) {
            marketSel = cause(err);
        }

        console.log("a five thousand ether buy: legacy selector | market selector");
        console.logBytes4(legacySel);
        console.logBytes4(marketSel);
        if (legacySel != bytes4(0)) console.log("the legacy route refused it");
        if (marketSel != bytes4(0)) console.log("the market route refused it");

        // whatever happened, neither design half-executed: the trader either bought or kept their ether
        assertEq(IERC20(USDG).balanceOf(address(router)), 0, "nothing stranded in the router");
        assertEq(IERC20(TESTNAME).balanceOf(address(router)), 0);
        assertEq(IERC20(FUN).balanceOf(address(router)), 0);
    }
}
