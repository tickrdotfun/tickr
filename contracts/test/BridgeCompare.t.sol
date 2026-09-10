// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {ITickerToken} from "../src/interfaces/ITickerToken.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {MarketTickerToken} from "../src/market/MarketTickerToken.sol";
import {ManagedTickerToken} from "../src/ManagedTickerToken.sol";
import {TokenParams, Socials} from "../src/Types.sol";

/// @dev Both bridges, side by side, with everything else held equal.
///
/// The only thing that differs between the two columns is how USDG becomes NAME: the live design mints it one
/// for one, the prototype swaps it in an ordinary hookless pool. Coin pools, fees, supply, opening price and
/// trade sizes are identical, so any difference in the numbers belongs to the bridge.
contract BridgeCompareTest is BaseTest {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    MarketTickerDeployer marketDeployer;
    PoolSwapTest swapper;

    // the prototype's profile, from the handoff
    uint256 constant MARKET_SUPPLY = 500_000_000e6;
    uint24 constant MARKET_FEE = 500;
    int24 constant MARKET_SPACING = 10;
    int24 constant MARKET_WIDTH = 30; // 0.3% of range either way, depending on how the addresses sort

    address legacyName;
    address marketName;

    function setUp() public override {
        super.setUp();
        swapper = new PoolSwapTest(poolManager);
        marketDeployer = new MarketTickerDeployer(
            address(this), IERC20(address(usdg)), poolManager, posm, permit2,
            MARKET_SUPPLY, MARKET_FEE, MARKET_SPACING, MARKET_WIDTH
        );
    }

    /// @dev A legacy name, built the way the launcher builds one: deployed behind the hook, registered, then
    /// initialised with a donation of dollars. No coin is launched: the comparison is of the bridge alone.
    function _legacy(string memory symbol) internal returns (address ticker) {
        bytes32 salt = keccak256(abi.encodePacked("legacy", symbol));
        vm.prank(address(tickers));
        ticker = managedDeployer.deploy(salt, symbol);
        vm.prank(address(tickers));
        managedHook.register(ManagedTickerToken(ticker));
        // the same shape of donation the live launcher makes from the name fee, and it has to come from the
        // launcher itself: the wrapper only accepts initialisation from the address that deployed it
        uint256 donation = 3_000_000;
        usdg.mint(address(tickers), donation);
        vm.startPrank(address(tickers));
        usdg.approve(ticker, donation);
        ManagedTickerToken(ticker).initialize(address(managedHook), donation);
        vm.stopPrank();
    }


    /// @dev USDG in, NAME out, the legacy way: an exact mint.
    function _legacyBridge(address name_, uint256 usdgIn) internal returns (uint256 out, uint256 gasUsed) {
        usdg.mint(address(this), usdgIn);
        usdg.approve(name_, usdgIn);
        uint256 before = IERC20(name_).balanceOf(address(this));
        uint256 g = gasleft();
        ITickerToken(name_).mint(usdgIn, address(this));
        gasUsed = g - gasleft();
        out = IERC20(name_).balanceOf(address(this)) - before;
    }

    /// @dev USDG in, NAME out, the prototype way: an ordinary swap.
    function _marketBridge(address name_, uint256 usdgIn) internal returns (uint256 out, uint256 gasUsed) {
        usdg.mint(address(this), usdgIn);
        usdg.approve(address(swapper), usdgIn);
        PoolKey memory key = marketDeployer.keyFor(name_);
        bool zeroForOne = Currency.unwrap(key.currency0) == address(usdg);
        uint256 before = IERC20(name_).balanceOf(address(this));
        uint256 g = gasleft();
        swapper.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(usdgIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        gasUsed = g - gasleft();
        out = IERC20(name_).balanceOf(address(this)) - before;
    }

    /// @dev NAME in, USDG out, both directions of each bridge.
    function _legacyExit(address name_, uint256 nameIn) internal returns (uint256 out, uint256 gasUsed) {
        uint256 before = usdg.balanceOf(address(this));
        uint256 g = gasleft();
        ITickerToken(name_).redeem(nameIn, address(this));
        gasUsed = g - gasleft();
        out = usdg.balanceOf(address(this)) - before;
    }

    function _marketExit(address name_, uint256 nameIn) internal returns (uint256 out, uint256 gasUsed) {
        IERC20(name_).approve(address(swapper), nameIn);
        PoolKey memory key = marketDeployer.keyFor(name_);
        bool zeroForOne = Currency.unwrap(key.currency0) == name_;
        uint256 before = usdg.balanceOf(address(this));
        uint256 g = gasleft();
        swapper.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(nameIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        gasUsed = g - gasleft();
        out = usdg.balanceOf(address(this)) - before;
    }

    /// @notice One buy at a ladder of sizes, through each bridge, from an untouched market.
    function test_compare_singleBuyLadder() public {
        uint256[6] memory sizes = [uint256(1e6), 100e6, 10_000e6, 100_000e6, 1_000_000e6, 10_000_000e6];
        console.log("size(USDG) | legacy NAME out | legacy gas | market NAME out | market gas | market cost vs par");
        for (uint256 i = 0; i < sizes.length; ++i) {
            uint256 size = sizes[i];
            string memory sym = string(abi.encodePacked("L", vm.toString(i)));
            address lname = _legacy(sym);
            (uint256 lout, uint256 lgas) = _legacyBridge(lname, size);

            (address mname,) = marketDeployer.create(keccak256(abi.encodePacked("M", i)), string(abi.encodePacked("M", vm.toString(i))), 6);
            (uint256 mout, uint256 mgas) = _marketBridge(mname, size);

            console.log("--- size");
            console.log(size);
            console.log("legacy out / gas");
            console.log(lout);
            console.log(lgas);
            console.log("market out / gas");
            console.log(mout);
            console.log(mgas);
            // cost against exact parity, in basis points
            console.log("market shortfall bps");
            console.log(mout >= size ? 0 : ((size - mout) * 10_000) / size);
        }
    }

    /// @notice In and straight back out. The legacy bridge returns exactly what went in; the market charges its
    /// fee twice and gives back whatever the range now pays.
    function test_compare_roundTrip() public {
        uint256[4] memory sizes = [uint256(100e6), 10_000e6, 1_000_000e6, 10_000_000e6];
        for (uint256 i = 0; i < sizes.length; ++i) {
            uint256 size = sizes[i];
            address lname = _legacy(string(abi.encodePacked("RL", vm.toString(i))));
            (uint256 lin,) = _legacyBridge(lname, size);
            (uint256 lback,) = _legacyExit(lname, lin);

            (address mname,) = marketDeployer.create(keccak256(abi.encodePacked("RM", i)), string(abi.encodePacked("RM", vm.toString(i))), 6);
            (uint256 min_,) = _marketBridge(mname, size);
            (uint256 mback,) = _marketExit(mname, min_);

            console.log("--- round trip, USDG in");
            console.log(size);
            console.log("legacy USDG back");
            console.log(lback);
            console.log("market USDG back");
            console.log(mback);
            console.log("market round trip cost, bps");
            console.log(mback >= size ? 0 : ((size - mback) * 10_000) / size);
        }
    }

    /// @notice The same buy, over and over, without anyone selling. This is the case the legacy design handles by
    /// minting and the market handles by walking its price along a finite range.
    function test_compare_sustainedBuying() public {
        uint256 clip = 1_000_000e6; // one million dollars a go
        uint256 rounds = 50; // fifty million dollars, a tenth of the market's inventory

        address lname = _legacy("SUSTL");
        uint256 lTotalOut;
        uint256 lTotalGas;
        for (uint256 i = 0; i < rounds; ++i) {
            (uint256 o, uint256 g) = _legacyBridge(lname, clip);
            lTotalOut += o;
            lTotalGas += g;
        }

        (address mname,) = marketDeployer.create(keccak256("SUSTM"), "SUSTM", 6);
        uint256 mTotalOut;
        uint256 mTotalGas;
        uint256 firstOut;
        uint256 lastOut;
        for (uint256 i = 0; i < rounds; ++i) {
            (uint256 o, uint256 g) = _marketBridge(mname, clip);
            if (i == 0) firstOut = o;
            if (i == rounds - 1) lastOut = o;
            mTotalOut += o;
            mTotalGas += g;
        }

        console.log("sustained: dollars in total");
        console.log(clip * rounds);
        console.log("legacy name out / total gas");
        console.log(lTotalOut);
        console.log(lTotalGas);
        console.log("market name out / total gas");
        console.log(mTotalOut);
        console.log(mTotalGas);
        console.log("market first clip out");
        console.log(firstOut);
        console.log("market last clip out");
        console.log(lastOut);
        console.log("decay across the run, bps");
        console.log(firstOut > lastOut ? ((firstOut - lastOut) * 10_000) / firstOut : 0);
    }

    /// @dev A buy that reports whether it worked rather than reverting the test, so the edge can be measured.
    function _tryMarketBuy(address name_, uint256 usdgIn) internal returns (bool ok, uint256 out, uint256 spent) {
        usdg.mint(address(this), usdgIn);
        usdg.approve(address(swapper), usdgIn);
        PoolKey memory key = marketDeployer.keyFor(name_);
        bool zeroForOne = Currency.unwrap(key.currency0) == address(usdg);
        uint256 beforeName = IERC20(name_).balanceOf(address(this));
        uint256 beforeUsdg = usdg.balanceOf(address(this));
        try swapper.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(usdgIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {
            ok = true;
            out = IERC20(name_).balanceOf(address(this)) - beforeName;
            spent = beforeUsdg - usdg.balanceOf(address(this));
        } catch {
            ok = false;
        }
    }

    /// @notice Buy until the market has nothing left to sell, and record what happens at the edge. The legacy
    /// bridge has no such edge; this measures the one the prototype introduces.
    function test_market_depletion() public {
        (address mname,) = marketDeployer.create(keccak256("DEPL"), "DEPL", 6);
        uint256 clip = 50_000_000e6; // fifty million a go, against five hundred million of inventory
        uint256 delivered;
        uint256 spentTotal;
        uint256 filled;
        for (uint256 i = 0; i < 20; ++i) {
            (bool ok, uint256 out, uint256 spent) = _tryMarketBuy(mname, clip);
            if (!ok) {
                console.log("buy number that reverted outright");
                console.log(i + 1);
                break;
            }
            if (out == 0) {
                console.log("buy number that filled nothing");
                console.log(i + 1);
                break;
            }
            ++filled;
            delivered += out;
            spentTotal += spent;
            if (spent < clip) {
                console.log("partial fill at buy number");
                console.log(i + 1);
                console.log("dollars asked / dollars taken");
                console.log(clip);
                console.log(spent);
            }
        }
        console.log("clips that filled");
        console.log(filled);
        console.log("name delivered in total");
        console.log(delivered);
        console.log("of an issuance of");
        console.log(MARKET_SUPPLY);
        console.log("dollars taken in total");
        console.log(spentTotal);
        console.log("name still held by the pool manager");
        console.log(IERC20(mname).balanceOf(address(poolManager)));

        // and a seller, once the market holds dollars instead of name
        uint256 hold = IERC20(mname).balanceOf(address(this));
        if (hold > 0) {
            (uint256 back,) = _marketExit(mname, hold / 10);
            console.log("selling a tenth of the position back: name in / dollars out");
            console.log(hold / 10);
            console.log(back);
        }
    }


    /// @dev A coin launched against a name, with identical config on both sides, so the coin leg is held equal.
    function _coinUnder(address name_, string memory sym) internal returns (address token) {
        vm.startPrank(owner);
        // the same opening economics the live launcher pins for a name: 3,236 units of the quote
        factory.setPairTokenEconomics(name_, PHANTOM_USDG);
        // the anchor is registered under the NAME's own ticker, not the coin's; registering it under the
        // coin's symbol reserves that symbol and the launch is then refused
        registry.register(name_, IERC20Metadata(name_).symbol(), "tickr", 0, address(0));
        factory.setWhitelistedLauncher(address(this), true);
        vm.stopPrank();
        TokenParams memory p = TokenParams({
            name: sym, symbol: sym, logo: "", description: "", socials: Socials("", "", "", "", ""),
            creatorFeeRecipient: address(0), creatorTaxBps: 0, buybackEnabled: false,
            expectedEconomics: bytes32(0), salt: bytes32(0)
        });
        p.expectedEconomics = factory.previewLaunchEconomics(0, name_);
        (token,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, name_);
    }

    /// @notice The whole path a buyer actually takes, dollars to coin, with the coin pool identical on both
    /// sides. The bridge is the only difference, so the gap here is what a buyer really loses to it.
    function test_compare_fullPath() public {
        address lname = _legacy("FPL");
        address lcoin = _coinUnder(lname, "FPLC");
        (address mname,) = marketDeployer.create(keccak256("FPM"), "FPM", 6);
        address mcoin = _coinUnder(mname, "FPMC");

        uint256[4] memory sizes = [uint256(100e6), 1_000e6, 10_000e6, 100_000e6];
        for (uint256 i = 0; i < sizes.length; ++i) {
            uint256 size = sizes[i];
            (uint256 lname_,) = _legacyBridge(lname, size);
            uint256 lcoinOut = _buyCoin(lname, lcoin, lname_);
            (uint256 mname_,) = _marketBridge(mname, size);
            uint256 mcoinOut = _buyCoin(mname, mcoin, mname_);
            console.log("--- dollars in");
            console.log(size);
            console.log("legacy coin out");
            console.log(lcoinOut);
            console.log("market coin out");
            console.log(mcoinOut);
            console.log("market shortfall on the whole path, bps");
            console.log(lcoinOut > mcoinOut ? ((lcoinOut - mcoinOut) * 10_000) / lcoinOut : 0);
        }
    }

    /// @dev Name in, coin out, through the coin's own pool.
    function _buyCoin(address name_, address coin, uint256 nameIn) internal returns (uint256 out) {
        PoolKey memory key = factory.poolKeyOf(coin);
        IERC20(name_).approve(address(swapper), nameIn);
        bool zeroForOne = Currency.unwrap(key.currency0) == name_;
        uint256 before = IERC20(coin).balanceOf(address(this));
        swapper.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(nameIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        out = IERC20(coin).balanceOf(address(this)) - before;
    }

    /// @dev USDG in, NAME out, the third way: an ordinary swap against the legacy pool, hook and all. This is
    /// the route an outside app takes today, and the one the prototype is really competing with. It is not the
    /// mint: the mint is only reachable through our own router.
    function _legacyPoolSwap(address name_, uint256 usdgIn) internal returns (bool ok, uint256 out, uint256 gasUsed) {
        usdg.mint(address(this), usdgIn);
        usdg.approve(address(swapper), usdgIn);
        PoolKey memory key = ManagedTickerToken(name_).poolKey();
        bool zeroForOne = Currency.unwrap(key.currency0) == address(usdg);
        uint256 before = IERC20(name_).balanceOf(address(this));
        uint256 g = gasleft();
        try swapper.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(usdgIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {
            gasUsed = g - gasleft();
            ok = true;
            out = IERC20(name_).balanceOf(address(this)) - before;
        } catch {
            gasUsed = g - gasleft();
            ok = false;
        }
    }

    /// @dev A market name whose address sorts on a chosen side of the counter, so both currency orderings are
    /// exercised rather than whichever one the salt happened to give.
    function _marketWithOrdering(string memory symbol, bool nameBelowCounter) internal returns (address name_) {
        for (uint256 i = 0; i < 512; ++i) {
            bytes32 salt = keccak256(abi.encodePacked(symbol, i));
            address predicted = marketDeployer.predict(salt, symbol, 6);
            if ((predicted < address(usdg)) == nameBelowCounter) {
                (name_,) = marketDeployer.create(salt, symbol, 6);
                assertEq(name_, predicted, "prediction must match the deployment");
                return name_;
            }
        }
        revert("no salt found for that ordering");
    }

    /// @notice The three routes side by side at one size, so the numbers are comparable and the gas figures are
    /// scoped to what each one actually is.
    function test_three_routes_at_one_size() public {
        uint256 size = 10_000e6;
        address lname = _legacy("TRI");
        (uint256 mintOut, uint256 mintGas) = _legacyBridge(lname, size);

        address lname2 = _legacy("TRI2");
        (bool poolOk, uint256 poolOut, uint256 poolGas) = _legacyPoolSwap(lname2, size);

        address mname = _marketWithOrdering("TRIM", true);
        (uint256 mktOut, uint256 mktGas) = _marketBridge(mname, size);

        console.log("--- $10,000 in, three routes");
        console.log("legacy mint: name out / gas (our router only)");
        console.log(mintOut);
        console.log(mintGas);
        console.log("legacy pool swap: succeeded? / name out / gas (what an outside app does today)");
        console.log(poolOk);
        console.log(poolOut);
        console.log(poolGas);
        console.log("market pool swap: name out / gas");
        console.log(mktOut);
        console.log(mktGas);

        // the mint is exact, by construction
        assertEq(mintOut, size, "legacy mint must be exactly one for one");
        // the market charges its fee and nothing else at this size
        assertApproxEqRel(mktOut, size, 0.001e18, "market should be within 10 bps of par at this size");
        assertLt(mktOut, size, "market must never hand out more than par");
    }

    /// @notice Both currency orderings must behave the same way: at or under par, never over.
    function test_market_bothOrderings_neverSellBelowPar() public {
        uint256 size = 1_000_000e6;
        address below = _marketWithOrdering("ORDA", true);
        address above = _marketWithOrdering("ORDB", false);
        assertTrue(below < address(usdg), "fixture: name should sort below the counter");
        assertTrue(above > address(usdg), "fixture: name should sort above the counter");

        (uint256 outBelow,) = _marketBridge(below, size);
        (uint256 outAbove,) = _marketBridge(above, size);
        console.log("ordering below counter: name out for a million dollars");
        console.log(outBelow);
        console.log("ordering above counter: name out for a million dollars");
        console.log(outAbove);

        // the bug this catches: a fixed tick range is wrong for one ordering and sells the name under a dollar
        assertLe(outBelow, size, "name sold below par in the below-counter ordering");
        assertLe(outAbove, size, "name sold below par in the above-counter ordering");
        // and the two orderings must cost about the same
        assertApproxEqRel(outBelow, outAbove, 0.0005e18, "the two orderings should price alike");
    }

    /// @notice A buy larger than the market can fill must either fill what it can and take only the dollars it
    /// used, or revert with nothing taken. It must never take the dollars and hand back less than it reported.
    function test_market_insufficientInventory_isSafe() public {
        address mname = _marketWithOrdering("EXH", true);
        // drain it
        for (uint256 i = 0; i < 11; ++i) {
            (bool ok,,) = _tryMarketBuy(mname, 50_000_000e6);
            if (!ok) break;
        }

        uint256 usdgBefore = usdg.balanceOf(address(this));
        uint256 nameBefore = IERC20(mname).balanceOf(address(this));
        (bool filled, uint256 out, uint256 spent) = _tryMarketBuy(mname, 10_000e6);
        uint256 usdgAfter = usdg.balanceOf(address(this));
        uint256 nameAfter = IERC20(mname).balanceOf(address(this));

        console.log("into an exhausted market: filled? / name out / dollars taken");
        console.log(filled);
        console.log(out);
        console.log(spent);

        uint256 asked = 10_000e6;
        if (filled) {
            // a fill must deliver something, must never take more than it was asked for, and every dollar it
            // did not use must still be with the caller. a partial fill reported as a full one is the failure
            // this is here to catch.
            assertGt(out, 0, "a fill that delivers nothing must revert instead");
            assertEq(nameAfter - nameBefore, out, "delivered name must match what was reported");
            assertLe(spent, asked, "took more dollars than the call authorised");
            assertEq(usdgAfter, usdgBefore + asked - spent, "unspent dollars must stay with the caller");
            if (spent < asked) {
                console.log("partial fill: asked / taken / refunded");
                console.log(asked);
                console.log(spent);
                console.log(asked - spent);
            }
            // and what it delivered has to be worth what it took, at or under par
            assertLe(out, spent, "delivered more name than dollars taken, which is selling below par");
        } else {
            // a refusal must leave the caller exactly as they were, apart from the mint in the helper
            assertEq(nameAfter, nameBefore, "a refused buy must deliver no name");
            assertEq(usdgAfter, usdgBefore + asked, "a refused buy must take no dollars");
        }
    }

    /// @notice The whole issuance is in the locked position and stays there: no code path moves it out.
    function test_market_inventoryIsLockedAndComplete() public {
        address mname = _marketWithOrdering("LOCK", true);
        MarketTickerDeployer.Market memory m = marketDeployer.market(mname);

        assertEq(IERC20(mname).totalSupply(), MARKET_SUPPLY, "supply must be the issuance");
        assertEq(IERC20(mname).balanceOf(m.locker), 0, "the locker holds the position, not loose tokens");
        assertEq(posm.ownerOf(m.tokenId), m.locker, "the position must belong to the locker");
        // everything except dust sits in the pool
        assertApproxEqAbs(IERC20(mname).balanceOf(address(poolManager)), MARKET_SUPPLY, 1_000, "issuance should be in the pool");
        // and nothing was left with the deployer that it could spend
        assertLt(IERC20(mname).balanceOf(address(marketDeployer)), 1_000, "deployer must keep only dust");
    }

    /// @notice A partial fill, produced on purpose rather than hoped for: drain the market until one buy can
    /// only be partly filled, then assert that the caller was charged for exactly what they got and keeps the
    /// rest. This is the case a router must never report as a full fill.
    function test_market_partialFill_chargesOnlyWhatItFilled() public {
        address mname = _marketWithOrdering("PART", true);
        uint256 clip = 50_000_000e6;

        bool sawPartial;
        for (uint256 i = 0; i < 15; ++i) {
            uint256 usdgBefore = usdg.balanceOf(address(this));
            uint256 nameBefore = IERC20(mname).balanceOf(address(this));
            (bool ok, uint256 out, uint256 spent) = _tryMarketBuy(mname, clip);
            if (!ok) break;
            uint256 usdgAfter = usdg.balanceOf(address(this));
            uint256 nameAfter = IERC20(mname).balanceOf(address(this));

            // every fill, partial or not, must obey the same rules
            assertEq(nameAfter - nameBefore, out, "delivered name must match the reported fill");
            assertEq(usdgAfter, usdgBefore + clip - spent, "unspent dollars must remain with the caller");
            assertLe(out, spent, "never more name than dollars taken");

            if (spent < clip) {
                sawPartial = true;
                console.log("partial fill on buy number");
                console.log(i + 1);
                console.log("asked / taken / refunded / name delivered");
                console.log(clip);
                console.log(spent);
                console.log(clip - spent);
                console.log(out);
                assertGt(out, 0, "a partial fill must still deliver something");
                assertGt(clip - spent, 0, "a partial fill must leave the caller their unspent dollars");
                break;
            }
        }
        assertTrue(sawPartial, "the market should partly fill at the edge, not only revert");
    }
}
