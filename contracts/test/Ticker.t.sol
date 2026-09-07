// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {ManagedTickerToken} from "../src/ManagedTickerToken.sol";
import {TickerLauncher} from "../src/TickerLauncher.sol";
import {ManagedTickerHook} from "../src/ManagedTickerHook.sol";
import {TokenParams} from "../src/Types.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// Invented tickers: a wrapper of USDG on the pair that runs its own dollar pool from the moment the name is
/// invented, and the club that pays creators under the same name. The pool's own rules are in ManagedTicker.t.sol.
contract TickerTest is BaseTest {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// the wrapper counts its own positions conservatively, so a few raw units read as circulation that nobody holds
    uint256 internal constant DUST = 1_000;

    function _launchUnder(string memory symbol, address who, string memory salt, bool isNew) internal returns (ManagedTickerToken ticker, Token token) {
        (,, bytes32 expected,) = tickers.previewLaunch(symbol, 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.salt = keccak256(bytes(salt));
        p.expectedEconomics = expected;
        p.salt = saltUnder(who, p, tickers.predictTicker(symbol));
        uint256 value = LAUNCH_FEE + (isNew ? tickers.NEW_TICKER_FEE() : 0);
        vm.prank(who);
        (address q, address t,) = tickers.launch{value: value}(symbol, p, 0);
        pastTheWindow();
        return (ManagedTickerToken(q), Token(t));
    }

    function _wrap(ManagedTickerToken ticker, address who, uint256 amount) internal {
        vm.startPrank(who);
        usdg.approve(address(ticker), amount);
        ticker.mint(amount, who);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- inventing a name

    function test_ticker_inventingANameOpensItsOwnDollarPool() public {
        uint256 nextId = posm.nextTokenId();
        uint256 seederEth = address(seeder).balance;
        (ManagedTickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
        assertEq(banana.symbol(), "BANANA");
        assertEq(banana.decimals(), 6, "a wrapper has its counter's decimals");
        assertEq(banana.hook(), address(managedHook), "bound to the one hook");
        assertEq(address(managedHook.tokenOf(banana.poolKey().toId())), address(banana), "registered by the launcher");
        PoolKey memory key = banana.poolKey();
        assertEq(address(key.hooks), address(managedHook));
        assertEq(key.fee, banana.FEE());
        (uint160 sqrtP, int24 tick,,) = poolManager.getSlot0(key.toId());
        assertEq(sqrtP, banana.PARITY(), "one dollar");
        assertEq(tick, 0);
        assertGt(poolManager.getLiquidity(key.toId()), 0, "the inventory and the cash are on offer");
        // the name fee became the wrapper's working dollars: nothing is in circulation, all of it is surplus
        (uint256 backing, uint256 circulation) = banana.accounting();
        assertLe(circulation, DUST, "nobody holds BANANA yet: only the position maths' rounding");
        assertGt(backing, banana.MIN_DONATION() - 1, "the fee bought at least the minimum");
        assertGe(banana.inventoryCapacity(), tickers.INVENTORY_FLOOR(), "ten thousand dollars' worth on offer at rest");
        // one position minted through the position manager: the coin's own, in the locker. the wrapper holds its
        // pool positions itself, not as NFTs
        assertEq(posm.nextTokenId(), nextId + 1);
        assertEq(IERC721(address(posm)).ownerOf(nextId), address(locker));
        assertEq(factory.getLaunchedToken(address(bread)).pairToken, address(banana), "BREAD is priced in BANANA");
        assertTrue(address(bread) < address(banana), "the coin is currency0, the name currency1");
        assertEq(usdg.balanceOf(address(seeder)), 0);
        assertEq(usdg.balanceOf(address(tickers)), 0, "the launcher keeps no dollars");
        assertEq(address(seeder).balance, seederEth, "seeder keeps nothing");
        assertEq(address(tickers).balance, 0);
    }

    function test_ticker_predictionMatchesCreation_andSitsInTheTopSixteenth() public {
        address predicted = tickers.predictTicker("banana");
        assertEq(uint160(predicted) >> 156, 0xF, "every ticker starts with an F");
        (ManagedTickerToken banana,) = _launchUnder("BANANA", creator, "bread", true);
        assertEq(address(banana), predicted, "BANANA, banana and Banana are one address, known before creation");
        assertEq(tickers.predictTicker("Banana"), predicted);
        PoolKey memory key = tickers.poolKeyOf(address(banana));
        assertEq(PoolId.unwrap(key.toId()), PoolId.unwrap(banana.poolKey().toId()));
    }

    function test_ticker_aCoinThatWouldSortAboveItsNameIsRefused() public {
        (,, bytes32 expected,) = tickers.previewLaunch("BANANA", 0);
        address banana = tickers.predictTicker("BANANA");
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        // hunt for a salt whose coin sorts above the name: about one in thirty two
        address above;
        for (uint256 i; i < 512 && above == address(0); i++) {
            p.salt = keccak256(abi.encodePacked("above", i));
            address predicted = deployer.predictToken(creator, p, SUPPLY);
            if (predicted > banana) above = predicted;
        }
        assertTrue(above != address(0), "a salt above the name exists");
        uint256 value = LAUNCH_FEE + tickers.NEW_TICKER_FEE();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(TickerLauncher.CoinNotFirst.selector, above, banana));
        tickers.launch{value: value}("BANANA", p, 0);
    }

    function test_ticker_theNameFeeIsExactAndOnlyForANewName() public {
        (,, bytes32 expected,) = tickers.previewLaunch("BANANA", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        p.salt = saltUnder(creator, p, tickers.predictTicker("BANANA"));
        vm.prank(creator);
        vm.expectRevert(TickerLauncher.BadValue.selector);
        tickers.launch{value: LAUNCH_FEE}("BANANA", p, 0);
        (ManagedTickerToken banana,) = _launchUnder("BANANA", creator, "bread", true);
        // the second coin under BANANA pays the launch fee alone, and the dollar pool is not touched
        PoolKey memory key = banana.poolKey();
        uint128 liq = poolManager.getLiquidity(key.toId());
        (uint256 backingBefore,) = banana.accounting();
        uint256 nextId = posm.nextTokenId();
        _launchUnder("BANANA", alice, "split", false);
        assertEq(posm.nextTokenId(), nextId + 1, "only the coin's own position");
        assertEq(poolManager.getLiquidity(key.toId()), liq);
        (uint256 backingAfter,) = banana.accounting();
        assertEq(backingAfter, backingBefore);
        uint256 tooMuch = LAUNCH_FEE + tickers.NEW_TICKER_FEE();
        p.salt = saltUnder(alice, p, address(banana));
        vm.prank(alice);
        vm.expectRevert(TickerLauncher.BadValue.selector);
        tickers.launch{value: tooMuch}("BANANA", p, 0);
    }

    function test_ticker_isADollarBothWays() public {
        (ManagedTickerToken banana,) = _launchUnder("BANANA", creator, "bread", true);
        uint256 before = usdg.balanceOf(alice);
        _wrap(banana, alice, 100e6);
        assertEq(banana.balanceOf(alice), 100e6);
        (uint256 backing, uint256 circulation) = banana.accounting();
        assertApproxEqAbs(circulation, 100e6, DUST, "what alice holds is in circulation");
        assertGe(backing, circulation, "and backed");
        vm.prank(alice);
        banana.redeem(100e6, alice);
        assertEq(usdg.balanceOf(alice), before);
        (, circulation) = banana.accounting();
        assertLe(circulation, DUST);
        assertGe(banana.reserve(), banana.circulatingSupply(), "every BANANA out is backed");
    }

    function test_ticker_reservedStockSymbolsCannotBeInvented() public {
        (,, bytes32 expected,) = tickers.previewLaunch("BANANA", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        uint256 value = LAUNCH_FEE + tickers.NEW_TICKER_FEE();
        vm.prank(creator);
        vm.expectRevert();
        tickers.launch{value: value}("NVDA", p, 0);
    }

    // ---------------------------------------------------------------- the pool

    function test_pool_tradesAtOneDollarBothWays_andStaysBacked() public {
        (ManagedTickerToken banana,) = _launchUnder("BANANA", creator, "bread", true);
        PoolKey memory key = banana.poolKey();
        bool usdgIs0 = Currency.unwrap(key.currency0) == address(usdg);
        // bob buys 5,000 BANANA with dollars through the pool, like any router would
        vm.startPrank(bob);
        usdg.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(key, SwapParams({zeroForOne: usdgIs0, amountSpecified: -int256(5_000e6), sqrtPriceLimitX96: usdgIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1}), PoolSwapTest.TestSettings(false, false), "");
        vm.stopPrank();
        uint256 got = banana.balanceOf(bob);
        assertGt(got, 5_000e6 * 99 / 100, "about a dollar each, less the pool's fee");
        assertLt(got, 5_000e6);
        (uint256 backing, uint256 circulation) = banana.accounting();
        assertApproxEqAbs(circulation, got, DUST, "what bob holds is the circulation");
        assertGe(backing, circulation, "backed by the dollars he paid");
        (uint160 sqrtP, int24 tick,,) = poolManager.getSlot0(key.toId());
        assertTrue(tick >= -2 && tick <= 2, "inside the band");
        sqrtP;
        // and sells it all back for dollars
        uint256 usdgBefore = usdg.balanceOf(bob);
        vm.startPrank(bob);
        banana.approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(key, SwapParams({zeroForOne: !usdgIs0, amountSpecified: -int256(got), sqrtPriceLimitX96: !usdgIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1}), PoolSwapTest.TestSettings(false, false), "");
        vm.stopPrank();
        assertGt(usdg.balanceOf(bob) - usdgBefore, got * 99 / 100);
        (backing, circulation) = banana.accounting();
        assertLe(circulation, DUST);
        assertGe(backing, circulation);
        assertGe(banana.usableBacking(), circulation);
    }

    function test_pool_aBuyAboveTheOfferIsRefused_whole() public {
        (ManagedTickerToken banana,) = _launchUnder("BANANA", creator, "bread", true);
        PoolKey memory key = banana.poolKey();
        bool usdgIs0 = Currency.unwrap(key.currency0) == address(usdg);
        uint256 cap = banana.inventoryCapacity();
        usdg.mint(bob, cap + 1);
        vm.startPrank(bob);
        usdg.approve(address(swapRouter), type(uint256).max);
        try swapRouter.swap(key, SwapParams({zeroForOne: usdgIs0, amountSpecified: -int256(cap + 1), sqrtPriceLimitX96: usdgIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1}), PoolSwapTest.TestSettings(false, false), "") {
            revert("a buy above the offer went through");
        } catch (bytes memory reason) {
            assertTrue(_has(reason, ManagedTickerToken.CapacityExceeded.selector), "CapacityExceeded, by name");
        }
        vm.stopPrank();
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        assertEq(sqrtP, banana.PARITY(), "nothing moved");
    }

    function test_pool_nobodyElseCanOpenAPoolBehindTheHook_orRegister() public {
        (ManagedTickerToken banana,) = _launchUnder("BANANA", creator, "bread", true);
        PoolKey memory key = PoolKey({currency0: Currency.wrap(address(usdg)), currency1: Currency.wrap(address(nvda)), fee: 500, tickSpacing: 1, hooks: managedHook});
        uint160 parity = banana.PARITY();
        vm.prank(bob);
        try poolManager.initialize(key, parity) {
            revert("a stranger opened a pool behind the hook");
        } catch (bytes memory reason) {
            assertTrue(_has(reason, ManagedTickerHook.UnknownPool.selector), "UnknownPool, by name");
        }
        vm.prank(bob);
        vm.expectRevert(ManagedTickerHook.NotIssuer.selector);
        managedHook.register(banana);
    }

    /// @dev Whether revert data carries `sel` anywhere: the pool manager wraps a hook's revert with the inner reason inside.
    function _has(bytes memory data, bytes4 sel) internal pure returns (bool) {
        for (uint256 i; i + 4 <= data.length; i++) {
            if (bytes4(uint32(uint8(data[i])) << 24 | uint32(uint8(data[i + 1])) << 16 | uint32(uint8(data[i + 2])) << 8 | uint32(uint8(data[i + 3]))) == sel) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- the club

    function test_club_proRataOverVolumeWithThePayersOwnShareToTheProtocol() public {
        (ManagedTickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
        (, Token peel) = _launchUnder("BANANA", alice, "peel", false);
        // trading in dollars: BREAD three times as much as PEEL
        _wrap(banana, bob, 4_000e6);
        vm.prank(bob);
        banana.approve(address(seeder), type(uint256).max);
        _buyWithWrapped(banana, bread, bob, 3_000e6);
        _buyWithWrapped(banana, peel, bob, 1_000e6);
        locker.collectFees(address(bread));
        locker.collectFees(address(peel));
        uint256 epoch = tickers.currentEpoch();
        uint256 potBread = tickers.pot(address(banana), epoch, address(bread));
        uint256 potPeel = tickers.pot(address(banana), epoch, address(peel));
        assertGt(potBread, 0);
        assertApproxEqRel(potBread, potPeel * 3, 0.01e18, "pots follow the fees");
        vm.warp(vm.getBlockTimestamp() + 31 days);
        address[] memory payers = new address[](1);
        payers[0] = address(bread);
        // BREAD founded BANANA and traded, so it is captain and its 3 counts as 6: weights 6 and 1 of 7
        uint256 peelGot = tickers.claimClub(address(peel), payers, epoch);
        assertApproxEqRel(peelGot, potBread / 7, 0.01e18, "PEEL: a seventh of BREAD's pot");
        payers[0] = address(peel);
        uint256 breadGot = tickers.claimClub(address(bread), payers, epoch);
        assertApproxEqRel(breadGot, (potPeel * 6) / 7, 0.01e18, "BREAD: six sevenths of PEEL's pot");
        assertApproxEqRel(tickers.sweepDeadPot(address(bread), epoch), (potBread * 6) / 7, 0.01e18, "BREAD's own share is the protocol's");
        assertEq(tickers.claimClub(address(peel), payers, epoch), 0, "nothing twice");
    }

    function test_club_aCollectionHeldBackLandsPotAndWeightTogether() public {
        (ManagedTickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
        (, Token peel) = _launchUnder("BANANA", alice, "peel", false);
        _wrap(banana, bob, 2_000e6);
        vm.prank(bob);
        banana.approve(address(seeder), type(uint256).max);
        _buyWithWrapped(banana, bread, bob, 1_000e6);
        _buyWithWrapped(banana, peel, bob, 1_000e6);
        uint256 epoch0 = tickers.currentEpoch();
        // nobody collects for 31 days; then anyone does. pot and weight land in the collection's epoch, together
        vm.warp(vm.getBlockTimestamp() + 31 days);
        uint256 epoch1 = tickers.currentEpoch();
        locker.collectFees(address(bread));
        locker.collectFees(address(peel));
        assertEq(tickers.pot(address(banana), epoch0, address(bread)), 0);
        assertGt(tickers.pot(address(banana), epoch1, address(bread)), 0);
        assertGt(tickers.volumeOf(address(peel), epoch1), 0, "PEEL's weight is in the same epoch as the pot");
        vm.warp(vm.getBlockTimestamp() + 31 days);
        address[] memory payers = new address[](1);
        payers[0] = address(bread);
        assertGt(tickers.claimClub(address(peel), payers, epoch1), 0, "PEEL is paid once that epoch closes");
    }

    // ---------------------------------------------------------------- the captain

    /// wraps dollars for bob and lets the seeder spend them
    function _fund(ManagedTickerToken banana, uint256 amount) internal {
        _wrap(banana, bob, amount);
        vm.prank(bob);
        banana.approve(address(seeder), type(uint256).max);
    }

    function test_captain_founderCountsDoubleWhileItTrades() public {
        (ManagedTickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
        (, Token peel) = _launchUnder("BANANA", alice, "peel", false);
        (, Token chip) = _launchUnder("BANANA", bob, "chip", false);
        _fund(banana, 3_000e6);
        _buyWithWrapped(banana, bread, bob, 1_000e6);
        _buyWithWrapped(banana, peel, bob, 1_000e6);
        _buyWithWrapped(banana, chip, bob, 1_000e6);
        locker.collectFees(address(bread));
        locker.collectFees(address(peel));
        locker.collectFees(address(chip));
        uint256 epoch = tickers.currentEpoch();
        assertEq(tickers.captainOf(address(banana), epoch), address(bread), "the founder's coin is captain");
        uint256 potChip = tickers.pot(address(banana), epoch, address(chip));
        assertGt(potChip, 0);
        uint256 vB = tickers.volumeOf(address(bread), epoch);
        uint256 vP = tickers.volumeOf(address(peel), epoch);
        uint256 vC = tickers.volumeOf(address(chip), epoch);
        uint256 total = vB * 2 + vP + vC;
        vm.warp(vm.getBlockTimestamp() + 31 days);
        address[] memory payers = new address[](1);
        payers[0] = address(chip);
        uint256 breadGot = tickers.claimClub(address(bread), payers, epoch);
        uint256 peelGot = tickers.claimClub(address(peel), payers, epoch);
        assertEq(breadGot, (potChip * vB * 2) / total, "BREAD: twice its volume over the total weight");
        assertEq(peelGot, (potChip * vP) / total, "PEEL: its volume over the total weight");
        assertApproxEqRel(breadGot, peelGot * 2, 0.01e18, "two to one in the founder's favour");
        assertApproxEqRel(breadGot, potChip / 2, 0.01e18, "half of CHIP's pot");
        assertEq(tickers.sweepDeadPot(address(chip), epoch), (potChip * vC) / total, "CHIP's own quarter is the protocol's");
    }

    function test_captain_deadFounderHandsTheSeatToTheBiggestCoin() public {
        (ManagedTickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
        (, Token peel) = _launchUnder("BANANA", alice, "peel", false);
        (, Token chip) = _launchUnder("BANANA", bob, "chip", false);
        _fund(banana, 4_000e6);
        _buyWithWrapped(banana, peel, bob, 3_000e6);
        _buyWithWrapped(banana, chip, bob, 1_000e6);
        locker.collectFees(address(peel));
        locker.collectFees(address(chip));
        uint256 epoch = tickers.currentEpoch();
        assertEq(tickers.volumeOf(address(bread), epoch), 0, "the founder's coin did not trade");
        assertEq(tickers.topOf(address(banana), epoch), address(peel), "PEEL leads");
        assertEq(tickers.captainOf(address(banana), epoch), address(peel), "and takes the seat");
        uint256 vP = tickers.volumeOf(address(peel), epoch);
        uint256 vC = tickers.volumeOf(address(chip), epoch);
        uint256 total = vP * 2 + vC;
        uint256 potChip = tickers.pot(address(banana), epoch, address(chip));
        vm.warp(vm.getBlockTimestamp() + 31 days);
        address[] memory payers = new address[](1);
        payers[0] = address(chip);
        assertEq(tickers.claimClub(address(peel), payers, epoch), (potChip * vP * 2) / total, "PEEL counts double");
        assertEq(tickers.claimClub(address(bread), payers, epoch), 0, "the founder earns nothing without volume");
        assertEq(tickers.sweepDeadPot(address(chip), epoch), (potChip * vC) / total, "CHIP's own share is the protocol's");
    }

    function test_captain_founderGetsTheSeatBackWhenItTradesAgain() public {
        (ManagedTickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
        (, Token peel) = _launchUnder("BANANA", alice, "peel", false);
        _fund(banana, 2_000e6);
        // window N: only PEEL trades
        _buyWithWrapped(banana, peel, bob, 1_000e6);
        locker.collectFees(address(peel));
        uint256 n = tickers.currentEpoch();
        assertEq(tickers.captainOf(address(banana), n), address(peel), "the seat moves away");
        // a later window: the founder's coin trades again
        vm.warp(vm.getBlockTimestamp() + 31 days);
        _buyWithWrapped(banana, bread, bob, 1_000e6);
        locker.collectFees(address(bread));
        uint256 later = tickers.currentEpoch();
        assertGt(later, n);
        assertEq(tickers.captainOf(address(banana), later), address(bread), "and comes back");
        assertEq(tickers.captainOf(address(banana), n), address(peel), "the closed window does not change");
    }

    function test_captain_anyVolumeKeepsTheSeat() public {
        (ManagedTickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
        (, Token peel) = _launchUnder("BANANA", alice, "peel", false);
        _fund(banana, 2_001e6);
        _buyWithWrapped(banana, bread, bob, 1e6); // one dollar
        _buyWithWrapped(banana, peel, bob, 2_000e6);
        locker.collectFees(address(bread));
        locker.collectFees(address(peel));
        uint256 epoch = tickers.currentEpoch();
        assertEq(tickers.captainOf(address(banana), epoch), address(bread), "a tiny trade keeps the seat");
        uint256 vB = tickers.volumeOf(address(bread), epoch);
        uint256 vP = tickers.volumeOf(address(peel), epoch);
        assertGt(vB, 0);
        uint256 total = vB * 2 + vP;
        uint256 potPeel = tickers.pot(address(banana), epoch, address(peel));
        vm.warp(vm.getBlockTimestamp() + 31 days);
        address[] memory payers = new address[](1);
        payers[0] = address(peel);
        uint256 got = tickers.claimClub(address(bread), payers, epoch);
        assertEq(got, (potPeel * vB * 2) / total, "double of a tiny weight");
        assertLt(got, potPeel / 100, "and not more than that");
    }

    function test_captain_noCaptainWhenNothingTraded() public {
        (ManagedTickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
        uint256 epoch = tickers.currentEpoch();
        assertEq(tickers.captainOf(address(banana), epoch), address(0), "no volume, no captain");
        // a pot with no volume behind it cannot come from a collection, since both land together. book one the way
        // the locker would, give the launcher the coins to pay it, and the sweep takes the whole pot
        _wrap(banana, bob, 100e6);
        vm.prank(bob);
        banana.transfer(address(tickers), 100e6);
        vm.prank(address(locker));
        tickers.onClubFee(address(bread), 100e6);
        vm.warp(vm.getBlockTimestamp() + 31 days);
        address protocol = factory.getLaunchFeePolicy(address(bread)).protocolFeeRecipient;
        uint256 before = banana.balanceOf(protocol);
        assertEq(tickers.sweepDeadPot(address(bread), epoch), 100e6, "the whole pot");
        assertEq(banana.balanceOf(protocol) - before, 100e6, "to the protocol");
    }

    function test_captain_sharesNeverExceedThePot() public {
        (ManagedTickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
        (, Token peel) = _launchUnder("BANANA", alice, "peel", false);
        (, Token chip) = _launchUnder("BANANA", bob, "chip", false);
        _fund(banana, 3_700e6);
        _buyWithWrapped(banana, bread, bob, 1_234e6);
        _buyWithWrapped(banana, peel, bob, 777e6);
        _buyWithWrapped(banana, chip, bob, 1_689e6);
        locker.collectFees(address(bread));
        locker.collectFees(address(peel));
        locker.collectFees(address(chip));
        uint256 epoch = tickers.currentEpoch();
        uint256 potBread = tickers.pot(address(banana), epoch, address(bread));
        assertGt(potBread, 0);
        vm.warp(vm.getBlockTimestamp() + 31 days);
        address[] memory payers = new address[](1);
        payers[0] = address(bread);
        uint256 total = tickers.claimClub(address(peel), payers, epoch) + tickers.claimClub(address(chip), payers, epoch)
            + tickers.sweepDeadPot(address(bread), epoch);
        assertLe(total, potBread, "never more than the pot");
        assertGe(total + 3, potBread, "all of it but the rounding dust of three shares");
        assertEq(tickers.claimClub(address(peel), payers, epoch), 0, "nothing twice");
        vm.expectRevert(TickerLauncher.NothingToSweep.selector);
        tickers.sweepDeadPot(address(bread), epoch);
    }

    function _buyWithWrapped(ManagedTickerToken ticker, Token coin, address who, uint256 amount) internal {
        PoolKey memory key = factory.poolKeyOf(address(coin));
        vm.prank(who);
        seeder.swapExactIn(key, Currency.unwrap(key.currency0) == address(ticker), amount, 0, who);
    }
}
