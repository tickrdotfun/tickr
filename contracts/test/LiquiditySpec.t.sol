// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fork} from "./Fork.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {LaunchSeeder} from "../src/LaunchSeeder.sol";
import {ISeederLike} from "../src/market/QuoteConverter.sol";
import {MarketTickerLauncher} from "../src/market/MarketTickerLauncher.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {TokenParams, Socials} from "../src/Types.sol";

interface ILaunchDeployerLike {
    function predictToken(address initiator, TokenParams calldata params, uint256 supply) external view returns (address);
}

/// @dev What one coin's curve can actually take.
///
/// The claim "five hundred million name available" is about the bridge, and it is not the binding constraint. A
/// buyer's trade goes through the coin's own pool, which opens with the whole supply on one side and a virtual
/// reserve on the other, and it is that reserve which decides how large a trade can be before the price runs
/// away. So the measurements here are of the coin pool, in the only unit that transfers to any launch
/// configuration: a share of the opening reserve.
contract LiquiditySpecForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address constant FACTORY = 0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f;
    address constant SEEDER = 0x3733576410312D34B53F90cFE513B0D0995aB6Ca;
    address constant MARKET_DEPLOYER = 0x0F72C545Bd455DB7184F5B0eA4725f5AA8494418;
    address constant LAUNCH_DEPLOYER = 0xD86C1Cc523256519Dbd608318395e0C97e0368d6;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant TESTNAME = 0x4Dd89f107d9b8395237719FA9d621a7A5BC00c52;

    address creator = address(0xC0FFEE);
    address buyer = address(0xB0B);
    address coin;
    uint256 phantom;
    bool forked;

    function setUp() public {
        if (!Fork.select()) return;
        forked = true;
        MarketTickerLauncher ml = new MarketTickerLauncher(IFactory(FACTORY), MarketTickerDeployer(MARKET_DEPLOYER));
        vm.prank(IFactory(FACTORY).owner());
        (bool ok,) = FACTORY.call(abi.encodeWithSignature("setRegistrar(address,bool)", address(ml), true));
        require(ok, "setRegistrar");

        uint256 supply = IFactory(FACTORY).getLaunchConfig(0).supply;
        TokenParams memory p = TokenParams({
            name: "CURVE", symbol: "CURVE", logo: "", description: "",
            socials: Socials("", "", "", "", ""), creatorFeeRecipient: address(0), creatorTaxBps: 0,
            buybackEnabled: false, expectedEconomics: ml.previewEconomics(0, TESTNAME), salt: bytes32(0)
        });
        for (uint256 i = 1; i < 80_000; ++i) {
            p.salt = bytes32(i);
            if (ILaunchDeployerLike(LAUNCH_DEPLOYER).predictToken(creator, p, supply) < TESTNAME) break;
        }
        uint256 f = IFactory(FACTORY).launchFee();
        vm.deal(creator, 10 ether);
        vm.prank(creator);
        (coin,) = ml.launch{value: f}(p, 0, TESTNAME);
        phantom = ml.economics().phantomQuote;

        vm.roll(block.number + 1); // a coin refuses to move in its own launch block
    }

    /// @dev Past the launch window, where the caps and the snipe tax no longer apply.
    function afterWindow() internal {
        vm.warp(block.timestamp + 25 hours);
    }

    function key() internal view returns (PoolKey memory) {
        return IFactory(FACTORY).poolKeyOf(coin);
    }

    function spot() internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = ISeederLike(SEEDER).poolManager().getSlot0(key().toId());
    }

    /// @dev External so a probe that the coin itself refuses can be caught. A fresh coin caps what one wallet
    /// may hold, and that cap binds before the curve's own impact does, which is a finding rather than a fault.
    function tryBuy(uint256 nameIn) external returns (uint256 out, uint256 moveBps) {
        return buy(nameIn);
    }

    /// @dev The rate a vanishingly small buy gets, which is the price before the trade. Both this and the trade
    /// pay the same pool fee, so comparing them isolates the price movement from the fee.
    function marginalOutPer(uint256 unit) internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        (uint256 out,) = buy(unit);
        vm.revertToState(snap);
        return out;
    }

    /// @dev The two numbers, which are not the same and are not interchangeable.
    ///
    /// `moveBps` is where the spot price ended up: what the next trader sees. `avgImpactBps` is what this trade
    /// actually got, against the rate it would have got at the price before it: what this trader paid. On a
    /// constant product curve the average is close to half the final move, and a comparison made with one of
    /// them cannot be read as if it were the other.
    function buyBoth(uint256 nameIn, uint256 unit, uint256 unitOut)
        internal
        returns (uint256 out, uint256 moveBps, uint256 avgImpactBps)
    {
        (out, moveBps) = buy(nameIn);
        uint256 ideal = (unitOut * nameIn) / unit;
        avgImpactBps = ideal > out ? ((ideal - out) * 10_000) / ideal : 0;
    }

    /// @dev One buy of `nameIn`, reporting what came out and how far the spot price moved, in basis points.
    function buy(uint256 nameIn) internal returns (uint256 out, uint256 moveBps) {
        PoolKey memory k = key();
        bool nameIs0 = Currency.unwrap(k.currency0) != coin;
        uint160 before = spot();
        deal(TESTNAME, buyer, nameIn);
        vm.startPrank(buyer);
        IERC20(TESTNAME).approve(SEEDER, nameIn);
        uint160 limit = nameIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        out = LaunchSeeder(payable(SEEDER)).swapExactInBounded(k, nameIs0, nameIn, 0, buyer, limit);
        vm.stopPrank();
        uint160 after_ = spot();
        // the pool's price is a square root, so the price itself moved by the square of the ratio
        uint256 hi = after_ > before ? after_ : before;
        uint256 lo = after_ > before ? before : after_;
        moveBps = ((hi * hi * 10_000) / (lo * lo)) - 10_000;
    }

    // ---------------------------------------------------------------- one trade

    /// @notice What a single trade of a given size does to the price, as a share of the opening reserve. These
    /// shares are what transfer to any other launch configuration; the dollar figures beside them are this one's.
    function test_fork_whatOneTradeOfEachSizeDoesToThePrice() public {
        if (!forked) return;
        afterWindow();
        uint256[6] memory shareBps = [uint256(10), 25, 50, 100, 250, 500]; // 0.1% to 5% of the reserve
        uint256 unit = phantom / 10_000;
        uint256 unitOut = marginalOutPer(unit);
        console.log("opening reserve, in the name's units");
        console.log(phantom);
        console.log("share of reserve (bps) | name in | coins out | spot move (bps) | average execution impact (bps)");
        for (uint256 i; i < shareBps.length; i++) {
            uint256 snap = vm.snapshotState();
            uint256 nameIn = (phantom * shareBps[i]) / 10_000;
            (uint256 out, uint256 moveBps, uint256 avgBps) = buyBoth(nameIn, unit, unitOut);
            console.log(shareBps[i]);
            console.log(nameIn);
            console.log(out);
            console.log(moveBps);
            console.log(avgBps);
            vm.revertToState(snap);
            assertGt(out, 0, "every one of these sizes fills");
            assertLe(avgBps, moveBps, "what this trade paid is less than where it left the price");
        }
    }

    /// @dev The selectors a coin's launch protection reverts with. Named here so a refusal can be attributed
    /// instead of assumed: a revert is not evidence of a cap until it says which cap.
    bytes4 constant WALLET_CAP = bytes4(keccak256("WalletCapExceeded(address,uint256,uint256)"));
    bytes4 constant BUY_CAP = bytes4(keccak256("BuyCapExceeded(address,uint256,uint256)"));
    /// @dev v4 wraps a callee's revert, so the outer selector says only that something below failed. Reading it
    /// as the cause is how a wallet cap gets reported as an unknown error.
    bytes4 constant WRAPPED = bytes4(keccak256("WrappedError(address,bytes4,bytes,bytes)"));

    /// @dev The selector of what actually reverted, through as many wrappers as it takes.
    function cause(bytes memory err) internal pure returns (bytes4 sel) {
        while (true) {
            if (err.length < 4) return sel;
            sel = bytes4(err);
            if (sel != WRAPPED) return sel;
            bytes memory body = new bytes(err.length - 4);
            for (uint256 i; i < body.length; i++) body[i] = err[i + 4];
            (, , bytes memory reason, ) = abi.decode(body, (address, bytes4, bytes, bytes));
            err = reason;
        }
    }

    struct Refusal {
        bytes4 selector;
        uint256 count;
    }

    /// @dev The largest trade under `limitBps`, measured either by where the spot price ends up or by what the
    /// trade itself got. Every refusal along the way is recorded with the selector it actually reverted with.
    function largestUnder(uint256 limitBps, bool byAverage, uint256 unit, uint256 unitOut)
        internal
        returns (uint256 lo, Refusal memory first, uint256 refusals)
    {
        uint256 hi = phantom / 2;
        for (uint256 step; step < 24; step++) {
            uint256 mid = (lo + hi) / 2;
            if (mid == 0) break;
            uint256 snap = vm.snapshotState();
            bool under;
            try this.tryBuyBoth(mid, unit, unitOut) returns (uint256, uint256 moveBps, uint256 avgBps) {
                under = (byAverage ? avgBps : moveBps) <= limitBps;
            } catch (bytes memory err) {
                under = false;
                refusals++;
                if (first.count == 0) first.selector = cause(err);
                first.count++;
            }
            vm.revertToState(snap);
            if (under) lo = mid;
            else hi = mid;
        }
    }

    function tryBuyBoth(uint256 nameIn, uint256 unit, uint256 unitOut)
        external
        returns (uint256 out, uint256 moveBps, uint256 avgBps)
    {
        return buyBoth(nameIn, unit, unitOut);
    }

    /// @notice The sizes a stated limit allows, once the launch window has closed, on both measures. This is the
    /// curve on its own, with no launch protection in the way.
    function test_fork_theLargestTradeUnderEachImpactLimitAfterTheWindow() public {
        if (!forked) return;
        afterWindow();
        uint256 unit = phantom / 10_000;
        uint256 unitOut = marginalOutPer(unit);
        uint256[3] memory limits = [uint256(100), 300, 500];

        console.log("after the window. limit (bps) | by spot move: size, bps of reserve | by average impact: size, bps of reserve");
        for (uint256 i; i < limits.length; i++) {
            (uint256 bySpot, Refusal memory rs, uint256 spotRefusals) = largestUnder(limits[i], false, unit, unitOut);
            (uint256 byAvg,, uint256 avgRefusals) = largestUnder(limits[i], true, unit, unitOut);
            console.log(limits[i]);
            console.log(bySpot);
            console.log((bySpot * 10_000) / phantom);
            console.log(byAvg);
            console.log((byAvg * 10_000) / phantom);
            assertGt(bySpot, 0);
            assertGt(byAvg, bySpot, "a trade allowed by what it paid is larger than one allowed by where it left the price");
            // the search probes far past these limits, and the coin refuses some of those probes even now: the
            // per-wallet cap is not something the launch window ends. Attributed by its selector, not assumed
            if (spotRefusals + avgRefusals > 0) {
                console.log("probes refused even after the window, by");
                console.logBytes4(rs.selector);
                assertEq(rs.selector, WALLET_CAP, "and the refusal is the wallet cap, unwrapped to its cause");
            }
        }
    }

    /// @notice And inside the launch window, where the coin's own caps apply. The question is whether they bind
    /// below the limits above, and the answer has to come from the error, not from the fact of a revert.
    function test_fork_whatTheLaunchWindowAllowsAndWhyItRefuses() public {
        if (!forked) return;
        // no warp: this is the protected window
        uint256 unit = phantom / 10_000;
        uint256 unitOut = marginalOutPer(unit);

        (uint256 lo, Refusal memory first, uint256 refusals) = largestUnder(500, true, unit, unitOut);
        console.log("in the window. largest trade under 5% average impact | bps of reserve | refusals seen");
        console.log(lo);
        console.log((lo * 10_000) / phantom);
        console.log(refusals);
        console.logBytes4(first.selector);

        if (refusals > 0) {
            assertEq(first.selector, WALLET_CAP, "the refusal is the wallet cap, and it says so");
        }

        // and the same measurement with the window closed, so the two are compared rather than conflated
        uint256 snap = vm.snapshotState();
        afterWindow();
        uint256 openUnitOut = marginalOutPer(unit);
        (uint256 open, Refusal memory openFirst, uint256 openRefusals) = largestUnder(500, true, unit, openUnitOut);
        vm.revertToState(snap);
        console.log("with the window closed: largest trade | refusals seen");
        console.log(open);
        console.log(openRefusals);

        // what this actually found, rather than what was expected of it. The caps did not bind at these limits
        // in either state; they refused only probes far above them, and the two allowed sizes are within a
        // fraction of a percent of each other. The window's snipe tax burns part of the output, which is why the
        // hold cap is reached later inside it than outside
        assertEq(refusals, 0, "nothing refused a trade at this limit inside the window");
        if (openRefusals > 0) assertEq(openFirst.selector, WALLET_CAP, "and outside it, only probes above the limit were refused, by the wallet cap");
        uint256 gap = lo > open ? lo - open : open - lo;
        assertLt((gap * 10_000) / open, 100, "the window and the open market allow within one percent of each other at this limit");
    }

    // ---------------------------------------------------------------- consecutive trades

    /// @notice The same size, over and over, which is what a launch actually meets. The price moves further each
    /// time, so what matters is how many such trades the curve absorbs before it has moved past a limit.
    function test_fork_howManyConsecutiveTradesTheCurveAbsorbs() public {
        if (!forked) return;
        uint256[3] memory shareBps = [uint256(10), 50, 100]; // trades at 0.1%, 0.5% and 1% of the reserve
        console.log("trade size (bps of reserve) | trades before the price has moved 10% | dollars they took");
        for (uint256 i; i < shareBps.length; i++) {
            uint256 snap = vm.snapshotState();
            uint256 nameIn = (phantom * shareBps[i]) / 10_000;
            uint160 start = spot();
            uint256 taken;
            uint256 trades;
            for (uint256 n; n < 200; n++) {
                (uint256 out,) = buy(nameIn);
                if (out == 0) break;
                taken += nameIn;
                trades++;
                uint160 now_ = spot();
                uint256 hi = now_ > start ? now_ : start;
                uint256 lo = now_ > start ? start : now_;
                if (((hi * hi * 10_000) / (lo * lo)) - 10_000 > 1_000) break; // ten percent
            }
            console.log(shareBps[i]);
            console.log(trades);
            console.log(taken);
            vm.revertToState(snap);
            assertGt(trades, 0, "the curve absorbs at least one trade of every size measured");
        }
    }
}
