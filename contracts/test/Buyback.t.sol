// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {BuybackTreasury} from "../src/BuybackTreasury.sol";
import {Token} from "../src/Token.sol";
import {TickerToken} from "../src/TickerToken.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {IFeeEscrow} from "../src/interfaces/IFeeEscrow.sol";
import {TokenParams, FeePolicy} from "../src/Types.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// The buyback treasury: the protocol's share collects here, splits 80/20 exactly, converts what converts at par or
/// through the live dollar pool, forwards the rest to the team, and buys and burns TICKR under a rate limit, a
/// tranche cap and an impact bound. Nobody owns it and nothing leaves except the two ways.
contract BuybackTest is BaseTest {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    address team = makeAddr("team");
    BuybackTreasury treasury;
    TickerToken fun;
    Token tickr;

    function setUp() public override {
        super.setUp();
        treasury = new BuybackTreasury(IFactory(address(factory)), IFeeEscrow(address(escrow)), seeder, IERC20(address(usdg)), team);
    }

    /// the owner names the treasury as the protocol's recipient for launches from now on
    function _pointProtocolAtTreasury() internal {
        vm.prank(owner);
        factory.setFeePolicy(
            FeePolicy({
                protocolFeeRecipient: address(treasury),
                creatorShareBps: 6_000,
                clubShareBps: 1_000,
                protocolShareBps: 3_000,
                buybackBurnBps: 0,
                club: address(tickers),
                hookFeeBps: 100,
                maxInternalPriceImpactBps: 300
            })
        );
    }

    /// genesis, as the deployer does it: FUN invented, TICKR the first coin under it
    function _genesis() internal {
        (,, bytes32 expected,) = tickers.previewLaunch("FUN", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.name = "tickr";
        p.symbol = "TICKR";
        p.expectedEconomics = expected;
        p.salt = keccak256("genesis");
        vm.prank(creator);
        (address f, address t,) = tickers.launch{value: LAUNCH_FEE + tickers.NEW_TICKER_FEE()}("FUN", p, 0);
        fun = TickerToken(f);
        tickr = Token(t);
        pastTheWindow();
    }

    function _creditUsdg(uint256 amount) internal {
        usdg.mint(address(this), amount);
        usdg.approve(address(escrow), amount);
        escrow.creditToken(address(treasury), address(usdg), amount);
    }

    /// the pool's sqrt price, and whether a rise in it means TICKR got dearer (TICKR as currency0) or cheaper
    function _sqrtPrice(PoolKey memory key) internal view returns (uint160 sqrtP, bool upIsDearer) {
        (sqrtP,,,) = poolManager.getSlot0(key.toId());
        upIsDearer = Currency.unwrap(key.currency0) == address(tickr);
    }

    // ---------------------------------------------------------------- collect

    function test_buyback_collectSplitsExactly() public {
        _genesis();
        // dollars, ETH and a wrapped dollar, all owed to the treasury in the escrow
        _creditUsdg(1_000e6);
        escrow.credit{value: 1 ether}(address(treasury));
        usdg.mint(address(this), 500e6);
        usdg.approve(address(fun), 500e6);
        fun.mint(500e6, address(this));
        fun.approve(address(escrow), 500e6);
        escrow.creditToken(address(treasury), address(fun), 500e6);

        address[] memory tokens = new address[](2);
        tokens[0] = address(usdg);
        tokens[1] = address(fun);
        (uint256 total, uint256 toTeam, uint256 earmarked) = treasury.collect(tokens);

        uint256 fromEth = total - 1_500e6;
        assertApproxEqRel(fromEth, 2_000e6, 0.01e18, "one ETH became about two thousand dollars through the live pool");
        assertEq(toTeam, (total * 2_000) / 10_000, "twenty percent to the team");
        assertEq(earmarked, total - toTeam, "eighty percent earmarked");
        assertEq(usdg.balanceOf(team), toTeam, "the team holds its slice");
        assertEq(treasury.earmarkedUsdg(), earmarked);
        assertEq(usdg.balanceOf(address(treasury)), earmarked, "the treasury holds exactly the earmark");
        assertEq(fun.balanceOf(address(treasury)), 0, "the wrapped dollar unwrapped at par");
        assertEq(address(treasury).balance, 0, "no ETH left behind");
    }

    function test_buyback_nonConvertibleGoesWhollyToTeam() public {
        _genesis();
        nvda.mint(address(this), 10e18);
        nvda.approve(address(escrow), 10e18);
        escrow.creditToken(address(treasury), address(nvda), 10e18);
        address[] memory tokens = new address[](1);
        tokens[0] = address(nvda);
        (uint256 total,, uint256 earmarked) = treasury.collect(tokens);
        assertEq(total, 0, "nothing convertible");
        assertEq(earmarked, 0, "nothing earmarked");
        assertEq(nvda.balanceOf(team), 10e18, "the Stock Token went whole to the team");
        assertEq(nvda.balanceOf(address(treasury)), 0);
    }

    // ---------------------------------------------------------------- buy

    function test_buyback_buyBurns() public {
        _genesis();
        _creditUsdg(10_000e6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdg);
        treasury.collect(tokens);
        uint256 earmarkBefore = treasury.earmarkedUsdg();
        uint256 deadBefore = tickr.balanceOf(treasury.DEAD());
        (uint256 usdgIn, uint256 tickrOut) = treasury.buy();
        assertGt(usdgIn, 0);
        assertGt(tickrOut, 0);
        assertEq(tickr.balanceOf(treasury.DEAD()) - deadBefore, tickrOut, "the coins landed at the dead address");
        assertEq(treasury.totalTickrBurned(), tickrOut);
        assertEq(treasury.totalUsdgSpent(), usdgIn);
        assertEq(treasury.earmarkedUsdg(), earmarkBefore - usdgIn, "the earmark paid for it");
        assertEq(usdg.balanceOf(address(treasury)), treasury.earmarkedUsdg(), "the balance is the earmark");
        assertEq(tickr.balanceOf(address(treasury)), 0, "the treasury keeps no coin");
        assertEq(fun.balanceOf(address(treasury)), 0, "and no wrapped dollar");
    }

    function test_buyback_rateLimit() public {
        _genesis();
        _creditUsdg(10_000e6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdg);
        treasury.collect(tokens);
        treasury.buy();
        vm.expectRevert(BuybackTreasury.TooSoon.selector);
        treasury.buy();
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        (uint256 usdgIn,) = treasury.buy();
        assertGt(usdgIn, 0, "ten minutes later it buys again");
        assertEq(treasury.nextBuyAt(), vm.getBlockTimestamp() + 10 minutes);
    }

    function test_buyback_trancheAndImpactBound() public {
        _genesis();
        _creditUsdg(1_000_000e6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdg);
        treasury.collect(tokens);
        uint256 earmark = treasury.earmarkedUsdg();
        PoolKey memory key = factory.poolKeyOf(address(tickr));
        (uint160 before, bool upIsDearer) = _sqrtPrice(key);
        (uint256 previewIn, uint256 previewMin) = treasury.previewBuy();
        (uint256 usdgIn, uint256 tickrOut) = treasury.buy();
        assertEq(usdgIn, previewIn, "the preview is the buy");
        assertGe(tickrOut, previewMin, "never below the floor it computed");
        assertLe(usdgIn, (earmark * 500) / 10_000, "at most five percent per call");
        (uint160 after_,) = _sqrtPrice(key);
        // TICKR got dearer: the sqrt price moved toward its side, by at most sqrt(1.03), which is 1.0149
        uint256 sqrtRatioBps = upIsDearer ? (uint256(after_) * 10_000) / before : (uint256(before) * 10_000) / after_;
        assertGt(sqrtRatioBps, 10_000, "the price moved: coins were bought");
        assertLe(sqrtRatioBps, 10_149 + 1, "and by at most three hundred basis points");
    }

    function test_buyback_permissionless() public {
        _genesis();
        _creditUsdg(5_000e6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdg);
        vm.prank(alice);
        treasury.collect(tokens);
        vm.prank(bob);
        (uint256 usdgIn,) = treasury.buy();
        assertGt(usdgIn, 0, "a stranger triggered a buy");
    }

    function test_buyback_nothingCanLeaveExceptTheTwoWays() public {
        _genesis();
        _creditUsdg(5_000e6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdg);
        treasury.collect(tokens);
        uint256 held = usdg.balanceOf(address(treasury));
        assertEq(held, treasury.earmarkedUsdg());
        // nobody can send it ETH but the escrow and the seeder
        vm.prank(alice);
        (bool ok,) = address(treasury).call{value: 1 ether}("");
        assertFalse(ok, "a stranger's ETH is refused");
        // there is no withdrawal, rescue, sweep or ownership surface at all
        address[3] memory who = [creator, owner, alice];
        string[6] memory sigs = ["withdraw(address,uint256)", "rescue(address)", "sweep(address,address)", "transferOwnership(address)", "setTeamWallet(address)", "execute(address,bytes)"];
        for (uint256 i; i < who.length; i++) {
            for (uint256 k; k < sigs.length; k++) {
                vm.prank(who[i]);
                (bool called,) = address(treasury).call(abi.encodeWithSignature(sigs[k], alice, uint256(1)));
                assertFalse(called, "no such function");
            }
        }
        // the only two exits: a collect pays the team, a buy pays the dead address; a caller gets nothing
        uint256 teamBefore = usdg.balanceOf(team);
        uint256 ownerBefore = usdg.balanceOf(owner);
        vm.prank(owner);
        treasury.collect(tokens);
        vm.prank(owner);
        treasury.buy();
        assertEq(usdg.balanceOf(owner), ownerBefore, "the owner got nothing");
        assertGe(usdg.balanceOf(team), teamBefore, "only the team");
        assertEq(usdg.balanceOf(address(treasury)), treasury.earmarkedUsdg(), "everything else is still the earmark");
        assertEq(tickr.balanceOf(address(treasury)), 0);
    }

    function test_buyback_recipientFrozenPerLaunch() public {
        // a coin launched before the treasury became the recipient keeps paying the old wallet
        (Token early,) = launchNative(creator);
        _pointProtocolAtTreasury();
        _genesis();
        (Token late,) = launchNative(alice);
        buy(early, bob, 1 ether);
        buy(late, bob, 1 ether);
        uint256 walletBefore = escrow.balanceOf(protocolFees);
        uint256 treasuryBefore = escrow.balanceOf(address(treasury));
        locker.collectFees(address(early));
        locker.collectFees(address(late));
        assertGt(escrow.balanceOf(protocolFees) - walletBefore, 0, "the early coin still pays the wallet");
        assertGt(escrow.balanceOf(address(treasury)) - treasuryBefore, 0, "the late coin pays the treasury");
        // and the genesis coin pays the treasury too
        usdg.mint(bob, 10_000e6);
        vm.startPrank(bob);
        usdg.approve(address(fun), 1_000e6);
        fun.mint(1_000e6, bob);
        fun.approve(address(seeder), 1_000e6);
        PoolKey memory key = factory.poolKeyOf(address(tickr));
        seeder.swapExactIn(key, Currency.unwrap(key.currency0) == address(fun), 1_000e6, 0, bob);
        vm.stopPrank();
        uint256 funBefore = escrow.balanceOfToken(address(treasury), address(fun));
        locker.collectFees(address(tickr));
        assertGt(escrow.balanceOfToken(address(treasury), address(fun)) - funBefore, 0, "TICKR's protocol share is FUN, owed to the treasury");
    }
}
