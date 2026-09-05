// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {TickerToken} from "../src/TickerToken.sol";
import {TickerLauncher} from "../src/TickerLauncher.sol";
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

/// Invented tickers: a real wrapper of USDG on the pair, its dollar pool opened and locked the moment the name is
/// invented, guarded so it can only ever say one dollar, and the club that pays creators under the same name.
contract TickerTest is BaseTest {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 internal constant SQRT_ONE = 79228162514264337593543950336;

    function _launchUnder(string memory symbol, address who, string memory salt, bool isNew) internal returns (TickerToken ticker, Token token) {
        (,, bytes32 expected,) = tickers.previewLaunch(symbol, 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.salt = keccak256(bytes(salt));
        p.expectedEconomics = expected;
        uint256 value = LAUNCH_FEE + (isNew ? tickers.NEW_TICKER_FEE() : 0);
        vm.prank(who);
        (address q, address t,) = tickers.launch{value: value}(symbol, p, 0);
        return (TickerToken(q), Token(t));
    }

    function _wrap(TickerToken ticker, address who, uint256 amount) internal {
        vm.startPrank(who);
        usdg.approve(address(ticker), amount);
        ticker.mint(amount, who);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- inventing a name

    function test_ticker_inventingANameOpensItsLockedDollarPool() public {
        uint256 nextId = posm.nextTokenId();
        (TickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
        assertEq(banana.symbol(), "BANANA");
        assertTrue(seeder.hasChartPool(address(banana)), "BANANA/USDG exists");
        PoolKey memory key = seeder.chartKey(address(banana));
        assertEq(address(key.hooks), address(chartHook), "behind the guard");
        (uint160 sqrtP, int24 tick,,) = poolManager.getSlot0(key.toId());
        assertGt(sqrtP, 0);
        assertLe(tick, 0);
        assertGe(tick, -chartHook.GUARD_TICKS(), "one dollar, inside the guard after the listing swap");
        assertGt(poolManager.getLiquidity(key.toId()), 0);
        // two positions minted: the dollar pool's band, then the coin's pool. both in the locker
        assertEq(posm.nextTokenId(), nextId + 2);
        assertEq(IERC721(address(posm)).ownerOf(nextId), address(locker));
        assertEq(IERC721(address(posm)).ownerOf(nextId + 1), address(locker));
        assertEq(factory.getLaunchedToken(address(bread)).pairToken, address(banana), "BREAD is priced in BANANA");
        assertEq(usdg.balanceOf(address(seeder)), 0);
        assertEq(banana.balanceOf(address(seeder)), 0);
        assertEq(address(seeder).balance, 0, "seeder keeps nothing");
    }

    function test_ticker_theNameFeeIsExactAndOnlyForANewName() public {
        (,, bytes32 expected,) = tickers.previewLaunch("BANANA", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        vm.prank(creator);
        vm.expectRevert(TickerLauncher.BadValue.selector);
        tickers.launch{value: LAUNCH_FEE}("BANANA", p, 0);
        _launchUnder("BANANA", creator, "bread", true);
        // the second coin under BANANA pays the launch fee alone, and the dollar pool is not touched
        PoolKey memory key = seeder.chartKey(address(tickers.tickerFor("BANANA")));
        uint128 liq = poolManager.getLiquidity(key.toId());
        uint256 nextId = posm.nextTokenId();
        _launchUnder("BANANA", alice, "split", false);
        assertEq(posm.nextTokenId(), nextId + 1, "only the coin's own position");
        assertEq(poolManager.getLiquidity(key.toId()), liq);
        uint256 tooMuch = LAUNCH_FEE + tickers.NEW_TICKER_FEE();
        vm.prank(alice);
        vm.expectRevert(TickerLauncher.BadValue.selector);
        tickers.launch{value: tooMuch}("BANANA", p, 0);
    }

    function test_ticker_isADollarBothWays() public {
        (TickerToken banana,) = _launchUnder("BANANA", creator, "bread", true);
        uint256 before = usdg.balanceOf(alice);
        _wrap(banana, alice, 100e6);
        assertEq(banana.balanceOf(alice), 100e6);
        vm.prank(alice);
        banana.redeem(100e6, alice);
        assertEq(usdg.balanceOf(alice), before);
        assertEq(banana.reserve(), banana.totalSupply(), "every BANANA is backed");
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

    // ---------------------------------------------------------------- the guard

    function test_guard_aShoveRevertsAndTheTickDoesNotMove() public {
        (TickerToken banana,) = _launchUnder("BANANA", creator, "bread", true);
        PoolKey memory key = seeder.chartKey(address(banana));
        bool usdgIs0 = Currency.unwrap(key.currency0) == address(usdg);
        (uint160 sqrtBefore, int24 tickBefore,,) = poolManager.getSlot0(key.toId());
        vm.startPrank(bob);
        usdg.approve(address(swapRouter), type(uint256).max);
        vm.expectRevert();
        swapRouter.swap(key, SwapParams({zeroForOne: usdgIs0, amountSpecified: -int256(300e6), sqrtPriceLimitX96: usdgIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1}), PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), "");
        vm.stopPrank();
        (uint160 sqrtAfter, int24 tickAfter,,) = poolManager.getSlot0(key.toId());
        assertEq(sqrtAfter, sqrtBefore);
        assertEq(tickAfter, tickBefore);
    }

    function test_guard_nobodyElseCanOpenAGuardedPool() public {
        (TickerToken banana,) = _launchUnder("BANANA", creator, "bread", true);
        PoolKey memory key = PoolKey({currency0: Currency.wrap(address(usdg)), currency1: Currency.wrap(address(nvda)), fee: 100, tickSpacing: 1, hooks: chartHook});
        vm.prank(bob);
        vm.expectRevert();
        poolManager.initialize(key, SQRT_ONE);
        banana;
    }

    // ---------------------------------------------------------------- the club

    function test_club_proRataOverVolumeWithThePayersOwnShareToTheProtocol() public {
        (TickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
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
        (TickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
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
    function _fund(TickerToken banana, uint256 amount) internal {
        _wrap(banana, bob, amount);
        vm.prank(bob);
        banana.approve(address(seeder), type(uint256).max);
    }

    function test_captain_founderCountsDoubleWhileItTrades() public {
        (TickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
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
        (TickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
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
        (TickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
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
        (TickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
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
        (TickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
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
        (TickerToken banana, Token bread) = _launchUnder("BANANA", creator, "bread", true);
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

    function _buyWithWrapped(TickerToken ticker, Token coin, address who, uint256 amount) internal {
        PoolKey memory key = factory.poolKeyOf(address(coin));
        vm.prank(who);
        seeder.swapExactIn(key, Currency.unwrap(key.currency0) == address(ticker), amount, 0, who);
    }
}
