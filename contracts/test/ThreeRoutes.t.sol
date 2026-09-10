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

interface IProtected {
    function protectionEndsAtBlock() external view returns (uint256);
}

interface ILockerLike {
    function collectFees(address token) external returns (uint256 quoteOut, uint256 coinOut);
}

/// @dev One comparison, three complete routes, both sides of launch protection.
///
///  A. the legacy wrapper's **mint**: dollars become the name one for one, no pool, no fee
///  B. the legacy wrapper's **own pool**: the same name bought through the managed pool, behind its hook
///  C. the **fixed-inventory market**: the name bought in its own hookless pool
///
/// All three end in the same kind of coin pool, on the same launch configuration and the same frozen fee, so the
/// pools are matched and the bridge is the only variable.
///
/// Protection is a **block** window, `protectionEndsAtBlock()`, not a time window. Earlier tests here warped a
/// day forward and rolled one block and called that "after the window"; it was not, which is why wallet caps
/// went on refusing. Both phases below are taken from the coin's own answer.
contract ThreeRoutesForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address constant FACTORY = 0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f;
    address constant SEEDER = 0x3733576410312D34B53F90cFE513B0D0995aB6Ca;
    address constant LOCKER = 0xDfD29cB10Ff0491CdF7896F75e54f4357F4a42b8;
    address constant TICKER_LAUNCHER = 0x7f6c8bA781b5bDC499F2BA7501A2178508877649;
    address constant MARKET_DEPLOYER = 0x0F72C545Bd455DB7184F5B0eA4725f5AA8494418;
    address constant LAUNCH_DEPLOYER = 0xD86C1Cc523256519Dbd608318395e0C97e0368d6;
    address constant MANAGED_HOOK = 0x3adE2d75475e3262A4dfd1b55c012d39d704eAC0;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant FUN = 0xF9d30A05A63d795e3eF37b34143f33b2cBEf0f14;
    address constant TESTNAME = 0x4Dd89f107d9b8395237719FA9d621a7A5BC00c52;

    /// @dev The minimum a caller derives from its own quote: three percent under it, which is the site's default.
    uint256 constant SLIP_BPS = 300;

    address me = address(0xC0FFEE);
    address legacyCoin;
    address marketCoin;
    MarketZapRouter router;
    uint256 buyers;
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

        (address ticker,, bytes32 expected,) = ITickerLauncherFull(TICKER_LAUNCHER).previewLaunch("FUN", configId);
        TokenParams memory lp = _params("LEGACY3", expected);
        lp.salt = _saltBelow(lp, ticker, c.supply);
        vm.prank(me);
        (, legacyCoin,) = ITickerLauncherFull(TICKER_LAUNCHER).launch{value: fee}("FUN", lp, configId);

        TokenParams memory mp = _params("MARKET3", ml.previewEconomics(configId, TESTNAME));
        mp.salt = _saltBelow(mp, TESTNAME, c.supply);
        vm.prank(me);
        (marketCoin,) = ml.launch{value: fee}(mp, configId, TESTNAME);

        QuoteRegistry reg = new QuoteRegistry(ITickerLauncherLike(TICKER_LAUNCHER), MarketTickerDeployer(MARKET_DEPLOYER), USDG);
        reg.record(FUN);
        reg.record(TESTNAME);
        router = new MarketZapRouter(IFactory(FACTORY), ISeederLike(SEEDER).poolManager(), IWETH9(WETH), reg);

        // out of the launch block, and past the snipe seconds, but still inside the block protection
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 60);
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

    // ---------------------------------------------------------------- the three routes

    function ethUsdg() internal pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(USDG), 100, 1, IHooks(address(0)));
    }

    function managedKey() internal pure returns (PoolKey memory) {
        (address c0, address c1) = FUN < USDG ? (FUN, USDG) : (USDG, FUN);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), 500, 1, IHooks(MANAGED_HOOK));
    }

    /// @dev 0 the mint, 1 the wrapper's own pool, 2 the market.
    function coinOf(uint8 route) internal view returns (address) {
        return route == 2 ? marketCoin : legacyCoin;
    }

    function pathFor(uint8 route) internal view returns (MarketZapRouter.Hop[] memory p) {
        PoolKey memory empty;
        p = new MarketZapRouter.Hop[](3);
        p[0] = MarketZapRouter.Hop({kind: 0, key: ethUsdg(), pool: address(0)});
        if (route == 0) p[1] = MarketZapRouter.Hop({kind: 2, key: empty, pool: FUN});
        else if (route == 1) p[1] = MarketZapRouter.Hop({kind: 0, key: managedKey(), pool: address(0)});
        else p[1] = MarketZapRouter.Hop({kind: 0, key: MarketTickerDeployer(MARKET_DEPLOYER).keyFor(TESTNAME), pool: address(0)});
        p[2] = MarketZapRouter.Hop({kind: 0, key: IFactory(FACTORY).poolKeyOf(coinOf(route)), pool: address(0)});
    }

    function nextBuyer() internal returns (address who) {
        who = address(uint160(uint256(keccak256(abi.encode("b3", buyers++)))));
        vm.deal(who, 20_000 ether);
    }

    function spotOf(address coin) internal view returns (uint160 s) {
        (s,,,) = ISeederLike(SEEDER).poolManager().getSlot0(IFactory(FACTORY).poolKeyOf(coin).toId());
    }

    /// @dev The caller's own quote for this route and size, taken the way a front end takes one.
    function quoteBuy(uint8 route, uint256 value) external payable returns (uint256 tokensOut) {
        MarketZapRouter.ZapParams memory p = MarketZapRouter.ZapParams({
            token: coinOf(route), tokenIn: address(0), amountIn: 0, path: pathFor(route),
            minTokensOut: 1, recipient: address(this), deadline: block.timestamp + 300
        });
        try router.previewZap{value: value}(p) {
            return 0;
        } catch (bytes memory err) {
            if (bytes4(err) != MarketZapRouter.Preview.selector) return 0;
            (, tokensOut) = abi.decode(_body(err), (uint256, uint256));
        }
    }

    function _body(bytes memory err) internal pure returns (bytes memory out) {
        out = new bytes(err.length - 4);
        for (uint256 i; i < out.length; i++) out[i] = err[i + 4];
    }

    /// @dev The caller's own quote for selling `amount` back through this route.
    function quoteSell(uint8 route, uint256 amount, address who) external returns (uint256 out) {
        MarketZapRouter.Hop[] memory f = pathFor(route);
        MarketZapRouter.Hop[] memory back = new MarketZapRouter.Hop[](3);
        back[0] = f[2];
        back[1] = f[1];
        back[2] = f[0];
        vm.prank(who);
        try router.previewZapSell(
            MarketZapRouter.ZapSellParams({
                token: coinOf(route), amountIn: amount, path: back, tokenOut: address(0),
                minOut: 1, recipient: who, deadline: block.timestamp + 300
            })
        ) {
            return 0;
        } catch (bytes memory err) {
            if (bytes4(err) != MarketZapRouter.Preview.selector) return 0;
            (, out) = abi.decode(_body(err), (uint256, uint256));
        }
    }

    struct Leg {
        uint256 out;
        uint256 gas;
        bytes4 failure;
    }

    /// @dev One buy, with a minimum the caller derived from its own quote rather than a placeholder.
    function buyOnce(uint8 route, uint256 value, address who) internal returns (Leg memory l) {
        uint256 quoted;
        try this.quoteBuy{value: value}(route, value) returns (uint256 q) {
            quoted = q;
        } catch {
            quoted = 0;
        }
        if (quoted == 0) {
            l.failure = bytes4(keccak256("NoQuote()"));
            return l;
        }
        uint256 minOut = (quoted * (10_000 - SLIP_BPS)) / 10_000;
        MarketZapRouter.ZapParams memory p = MarketZapRouter.ZapParams({
            token: coinOf(route), tokenIn: address(0), amountIn: 0, path: pathFor(route),
            minTokensOut: minOut, recipient: who, deadline: block.timestamp + 300
        });
        vm.prank(who);
        uint256 g = gasleft();
        try router.zapBuy{value: value}(p) returns (uint256 got) {
            l.out = got;
            l.gas = g - gasleft();
        } catch (bytes memory err) {
            l.failure = cause(err);
        }
    }

    bytes4 constant WRAPPED = bytes4(keccak256("WrappedError(address,bytes4,bytes,bytes)"));

    function cause(bytes memory err) internal pure returns (bytes4 sel) {
        while (true) {
            if (err.length < 4) return sel;
            sel = bytes4(err);
            if (sel != WRAPPED) return sel;
            (,, bytes memory reason,) = abi.decode(_body(err), (address, bytes4, bytes, bytes));
            err = reason;
        }
    }

    /// @dev What a route charges a trader, in pips, compounded: every pool's own fee and the chain's fee on it
    /// **in the direction that leg is traded**. The chain's fee is two twelve-bit halves, one per direction, so
    /// a buy and a sell through the same pools need not cost the same, and are computed separately below.
    ///
    /// This is a property of the route. It is not the fee any one pool happened to collect during a run.
    function chargeOf(MarketZapRouter.Hop[] memory p, address from) internal view returns (uint256 pips) {
        uint256 keptPpm = 1_000_000;
        address cur = from;
        for (uint256 i; i < p.length; i++) {
            if (p[i].kind == 2) {
                // a mint or a redeem: one for one, no pool, no fee either way
                cur = cur == p[i].pool ? address(0) : p[i].pool;
                continue;
            }
            bool zfo = Currency.unwrap(p[i].key.currency0) == cur;
            (,, uint24 protocolFee,) = ISeederLike(SEEDER).poolManager().getSlot0(p[i].key.toId());
            uint256 chain = zfo ? (protocolFee & 0xfff) : ((protocolFee >> 12) & 0xfff);
            keptPpm = (keptPpm * (1_000_000 - chain)) / 1_000_000;
            keptPpm = (keptPpm * (1_000_000 - p[i].key.fee)) / 1_000_000;
            cur = zfo ? Currency.unwrap(p[i].key.currency1) : Currency.unwrap(p[i].key.currency0);
        }
        return 1_000_000 - keptPpm;
    }

    function reversed(MarketZapRouter.Hop[] memory f) internal pure returns (MarketZapRouter.Hop[] memory b) {
        b = new MarketZapRouter.Hop[](f.length);
        for (uint256 i; i < f.length; i++) b[i] = f[f.length - 1 - i];
    }

    struct Run {
        uint256 bought;
        uint256 buyGas;
        uint256 sold;
        uint256 sellGas;
        uint256 fills;
        bytes4 failure;
        uint256 avgImpactBps;
        uint256 spotMoveBps;
        /// @dev The quote-side fee this coin's own pool collected during this run, in the pair asset's units.
        /// It is one pool's takings, not what the route charged the trader.
        uint256 coinPoolFeeCollected;
        /// @dev What the whole route charges a buyer, in pips, in the direction a buy trades it.
        uint256 routeChargeBuyPips;
        /// @dev And a seller, in the other direction, which the chain's fee need not price the same.
        uint256 routeChargeSellPips;
    }

    /// @dev Five buys of the same size, then a sell of a quarter of what they bought.
    function run(uint8 route, uint256 each) internal returns (Run memory r) {
        address coin = coinOf(route);
        uint160 start = spotOf(coin);
        // the rate a vanishing trade gets now, so the average the real trades achieved can be measured against it
        uint256 snap = vm.snapshotState();
        Leg memory probe = buyOnce(route, each / 1_000, nextBuyer());
        vm.revertToState(snap);

        address last;
        for (uint256 i; i < 5; i++) {
            last = nextBuyer();
            Leg memory l = buyOnce(route, each, last);
            if (l.out == 0) {
                r.failure = l.failure;
                break;
            }
            r.bought += l.out;
            r.buyGas += l.gas;
            r.fills++;
        }
        if (r.fills == 0) return r;

        uint256 ideal = probe.out * 1_000 * r.fills;
        r.avgImpactBps = ideal > r.bought ? ((ideal - r.bought) * 10_000) / ideal : 0;

        uint160 now_ = spotOf(coin);
        uint256 hi = now_ > start ? now_ : start;
        uint256 lo = now_ > start ? start : now_;
        r.spotMoveBps = ((hi * hi * 10_000) / (lo * lo)) - 10_000;

        // a sell back through the same bridge, by the wallet that made the last buy
        MarketZapRouter.Hop[] memory f = pathFor(route);
        MarketZapRouter.Hop[] memory back = new MarketZapRouter.Hop[](3);
        back[0] = f[2];
        back[1] = f[1];
        back[2] = f[0];
        uint256 amount = IERC20(coin).balanceOf(last) / 2;
        // the sell carries a minimum from its own fresh quote, exactly as the buys do. A placeholder minimum
        // would let a sell through that a real caller's floor would have stopped
        vm.prank(last);
        IERC20(coin).approve(address(router), amount);
        uint256 sellQuote;
        try this.quoteSell(route, amount, last) returns (uint256 q) {
            sellQuote = q;
        } catch {
            sellQuote = 0;
        }
        if (sellQuote == 0) {
            r.failure = bytes4(keccak256("NoSellQuote()"));
            (r.coinPoolFeeCollected,) = ILockerLike(LOCKER).collectFees(coin);
            return r;
        }
        uint256 sellMin = (sellQuote * (10_000 - SLIP_BPS)) / 10_000;
        vm.startPrank(last);
        uint256 g = gasleft();
        try router.zapSell(
            MarketZapRouter.ZapSellParams({
                token: coin, amountIn: amount, path: back, tokenOut: address(0),
                minOut: sellMin, recipient: last, deadline: block.timestamp + 300
            })
        ) returns (uint256 got) {
            r.sold = got;
            r.sellGas = g - gasleft();
        } catch (bytes memory err) {
            r.failure = cause(err);
        }
        vm.stopPrank();

        (r.coinPoolFeeCollected,) = ILockerLike(LOCKER).collectFees(coin);
        r.routeChargeBuyPips = chargeOf(pathFor(route), address(0));
        r.routeChargeSellPips = chargeOf(reversed(pathFor(route)), coin);
    }

    /// @dev Gas here is **router execution gas**: `gasleft()` either side of the call into the router. It is not
    /// a wallet transaction's cost, and excludes the intrinsic 21,000, calldata and any wallet overhead. All
    /// three routes are measured the same way, so they compare; the absolute figures are not a receipt.
    function report(string memory label, Run memory r) internal pure {
        console.log(label);
        console.log(r.fills);
        console.log(r.bought);
        console.log(r.buyGas);
        console.log(r.avgImpactBps);
        console.log(r.spotMoveBps);
        console.log(r.sold);
        console.log(r.sellGas);
        console.log(r.coinPoolFeeCollected);
        console.log(r.routeChargeBuyPips);
        console.log(r.routeChargeSellPips);
        console.logBytes4(r.failure);
    }

    // ---------------------------------------------------------------- the comparison

    /// @notice All three routes, inside launch protection.
    function test_fork_threeRoutesDuringProtection() public {
        if (!forked) return;
        assertLt(block.number, IProtected(legacyCoin).protectionEndsAtBlock(), "this phase really is inside it");
        assertLt(block.number, IProtected(marketCoin).protectionEndsAtBlock());
        console.log("inside protection. fills | bought | router buy gas | avg impact bps | spot move bps | sold | router sell gas | coin pool fee collected | route charge buy pips | route charge sell pips | failure");
        _three(0.01 ether);
    }

    /// @notice And after it, taken from the coin's own ending block rather than from a guess about time.
    function test_fork_threeRoutesAfterProtection() public {
        if (!forked) return;
        uint256 endL = IProtected(legacyCoin).protectionEndsAtBlock();
        uint256 endM = IProtected(marketCoin).protectionEndsAtBlock();
        vm.roll(endL > endM ? endL : endM);
        assertGe(block.number, endL, "past the legacy coin's protection");
        assertGe(block.number, endM, "and the market coin's");
        console.log("after protection. fills | bought | router buy gas | avg impact bps | spot move bps | sold | router sell gas | coin pool fee collected | route charge buy pips | route charge sell pips | failure");
        _three(0.01 ether);
    }

    function _three(uint256 each) internal {
        uint256 snap = vm.snapshotState();
        Run memory a = run(0, each);
        vm.revertToState(snap);
        Run memory b = run(1, each);
        vm.revertToState(snap);
        Run memory c = run(2, each);
        vm.revertToState(snap);

        report("A: legacy mint", a);
        report("B: legacy hooked pool", b);
        report("C: fixed-inventory market", c);

        // every route, every phase: five buys filled, the sell went through, and nothing failed
        _complete("A", a);
        _complete("B", b);
        _complete("C", c);

        // the claim the recommendation rests on, asserted rather than described: the market delivers within a
        // stated tolerance of the pool an outside app would actually route through
        uint256 keptVsHooked = (c.bought * 10_000) / b.bought;
        console.log("C as bps of B, on the buys");
        console.log(keptVsHooked);
        assertGe(keptVsHooked, 9_995, "the market is within five basis points of the hooked pool");
        assertLe(keptVsHooked, 10_000, "and does not beat it");

        // and against the mint, which charges nothing and is the reference rather than a route anyone uses
        assertLt(c.bought, a.bought, "the market costs its pool's fee, which the mint does not");
        assertGt((c.bought * 10_000) / a.bought, 9_900, "and that cost is under one percent");

        // the gas gap, which is the reason for the recommendation
        console.log("C router buy gas as bps of B | C router sell gas as bps of B");
        console.log((c.buyGas * 10_000) / b.buyGas);
        console.log((c.sellGas * 10_000) / b.sellGas);
        assertLt(c.buyGas, b.buyGas, "the market is cheaper to buy through than the hooked pool");
        assertLt(c.sellGas, b.sellGas, "and cheaper to sell through");
    }

    function _complete(string memory label, Run memory r) internal pure {
        console.log(label);
        assertEq(r.fills, 5, "all five buys filled");
        assertGt(r.sold, 0, "and the sell went through");
        assertEq(r.failure, bytes4(0), "with nothing refused");
    }
}
