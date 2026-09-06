// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {TickerToken} from "../src/TickerToken.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {BuybackTreasury} from "../src/BuybackTreasury.sol";
import {TickerLauncher} from "../src/TickerLauncher.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {IFeeEscrow} from "../src/interfaces/IFeeEscrow.sol";
import {TokenParams, FeePolicy} from "../src/Types.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// The r10 audit round: the zap settles once and pays the buyer directly, so the coin's rules see the buyer and never
/// the router; a holding over the cap cannot be assembled from several wallets inside the window; the seeder's
/// minimum is what arrives; the treasury keeps revenue paid to it apart from a buy's refund and is bound to one launcher.
contract AuditR10Test is BaseTest {
    address constant DEAD_ADDR = 0x000000000000000000000000000000000000dEaD;
    address carol = makeAddr("carol");

    function setUp() public override {
        super.setUp();
        vm.deal(carol, 100 ether);
    }

    function _launchNow(address who) internal returns (Token t) {
        TokenParams memory p = defaultParams(address(0), 0);
        vm.prank(who);
        (address a,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        return Token(a);
    }

    /// the second block of the window, after the snipe tax has run out: the caps alone
    function _secondBlockAfterTheTax() internal {
        vm.warp(vm.getBlockTimestamp() + 6);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _ownPath(Token t) internal view returns (ZapRouter.Hop[] memory path) {
        path = new ZapRouter.Hop[](1);
        path[0] = ZapRouter.Hop({kind: zap.HOP_V4(), key: factory.poolKeyOf(address(t)), pool: address(0)});
    }

    function _zapBuy(Token t, address who, uint256 value) internal returns (uint256 out) {
        ZapRouter.ZapParams memory p = ZapRouter.ZapParams({token: address(t), tokenIn: address(0), amountIn: 0, path: _ownPath(t), minTokensOut: 0, recipient: who, deadline: vm.getBlockTimestamp() + 1 hours});
        vm.prank(who);
        out = zap.zapBuy{value: value}(p);
    }

    function _zapBuyMustRevert(Token t, address who, uint256 value) internal {
        ZapRouter.ZapParams memory p = ZapRouter.ZapParams({token: address(t), tokenIn: address(0), amountIn: 0, path: _ownPath(t), minTokensOut: 0, recipient: who, deadline: vm.getBlockTimestamp() + 1 hours});
        vm.expectRevert();
        vm.prank(who);
        zap.zapBuy{value: value}(p);
    }

    function _zapSell(Token t, address who, uint256 amount) internal returns (uint256 out) {
        ZapRouter.ZapSellParams memory p = ZapRouter.ZapSellParams({token: address(t), amountIn: amount, path: _ownPath(t), tokenOut: address(0), minOut: 0, recipient: who, deadline: vm.getBlockTimestamp() + 1 hours});
        vm.startPrank(who);
        t.approve(address(zap), amount);
        out = zap.zapSell(p);
        vm.stopPrank();
    }

    function _pct(Token t, address who) internal view returns (uint256 bps) {
        return (t.balanceOf(who) * 10_000) / t.totalSupply();
    }

    // ---------------------------------------------------------------- the zap sees the buyer, not the router

    function test_r10_zapBuyInTheWindow_countsAgainstTheBuyer() public {
        Token t = _launchNow(creator);
        _secondBlockAfterTheTax();
        uint256 got = _zapBuy(t, alice, 0.08 ether);
        assertEq(t.balanceOf(alice), got, "alice holds what the zap reports");
        assertEq(t.boughtInWindow(alice), got, "the buy is counted against alice");
        assertEq(t.boughtInWindow(address(zap)), 0, "and never against the router");
        assertEq(t.balanceOf(address(zap)), 0, "the router holds nothing");
        // a second buyer has their own allowance: the router's is not shared
        uint256 got2 = _zapBuy(t, bob, 0.08 ether);
        assertEq(t.boughtInWindow(bob), got2);
        // and a buyer over the cap is refused by name, not the router
        _zapBuyMustRevert(t, carol, 3 ether);
        assertEq(t.balanceOf(carol), 0, "nothing arrived over the cap");
    }

    function test_r10_zapBuyInTheLaunchBlock_launcherPassesStrangerDoesNot() public {
        Token t = _launchNow(creator);
        uint256 got = _zapBuy(t, creator, 0.2 ether);
        assertEq(t.balanceOf(creator), got, "the launcher's own zap buy passes in the launch block, untaxed");
        assertEq(t.balanceOf(DEAD_ADDR), 0, "and pays no tax");
        _zapBuyMustRevert(t, alice, 0.01 ether);
        assertEq(t.balanceOf(alice), 0, "a stranger's zap buy does not");
    }

    function test_r10_zapBuyInTheTaxSecond_paysTheTaxToTheDeadAddress() public {
        Token t = _launchNow(creator);
        vm.roll(vm.getBlockNumber() + 1); // block two, still the launch second: 99% tax
        uint256 got = _zapBuy(t, alice, 0.05 ether);
        uint256 tax = t.balanceOf(DEAD_ADDR);
        assertEq(t.balanceOf(alice), got, "what the zap reports is what alice keeps");
        assertEq(tax, ((got + tax) * 9_900) / 10_000, "99% of the pool's count burned");
        assertEq(t.boughtInWindow(alice), got, "the cap counts the net");
    }

    function test_r10_zapSellInTheWindow_coinNeverTouchesTheRouter() public {
        Token t = _launchNow(creator);
        uint256 big = buy(t, creator, 2 ether); // the launcher may hold more than 5% in the launch block
        assertGt(_pct(t, creator), 500, "over the cap, as the launcher may be");
        _secondBlockAfterTheTax();
        uint256 eth = creator.balance;
        uint256 out = _zapSell(t, creator, big);
        assertEq(creator.balance - eth, out, "the sell of a holding over the cap passes inside the window");
        assertEq(t.balanceOf(address(zap)), 0, "the coin went from the seller straight into the pool");
        assertEq(t.boughtInWindow(creator), 0, "a sell counts nothing");
    }

    // ---------------------------------------------------------------- holdings cannot be assembled

    function test_r10_transfersCannotAssembleAHoldingOverTheCap() public {
        Token t = _launchNow(creator);
        _secondBlockAfterTheTax();
        address dave = makeAddr("dave");
        vm.deal(dave, 1 ether);
        uint256 b = buy(t, bob, 0.04 ether);
        uint256 c = buy(t, carol, 0.04 ether);
        uint256 d = buy(t, dave, 0.04 ether);
        uint256 supply = t.totalSupply();
        uint256 cap = (supply * 500) / 10_000;
        assertLt(b + c, cap, "two of them fit under the cap");
        assertGt(b + c + d, cap, "three of them are over it");
        vm.prank(bob);
        t.transfer(alice, b);
        vm.prank(carol);
        t.transfer(alice, c);
        assertEq(t.balanceOf(alice), b + c, "transfers that stay under the cap pass");
        vm.expectRevert(abi.encodeWithSelector(Token.WalletCapExceeded.selector, alice, b + c + d, 0));
        vm.prank(dave);
        t.transfer(alice, d); // the one that would take alice over it
        assertEq(t.balanceOf(alice), b + c, "nothing moved");
        assertEq(t.boughtInWindow(alice), 0, "a transfer never counts as a buy");
        // a partial transfer that stays under the cap passes, up to exactly the cap
        uint256 room = cap - (b + c);
        vm.prank(dave);
        t.transfer(alice, room);
        assertEq(t.balanceOf(alice), cap, "exactly at the cap");
        // and from the fourth block every limit is gone
        vm.roll(vm.getBlockNumber() + 2);
        vm.prank(dave);
        t.transfer(alice, d - room);
        assertEq(t.balanceOf(alice), b + c + d, "assembled after the window, as any buy could be");
    }

    function test_r10_transfersIntoTheExemptSetAreNeverLimited() public {
        Token t = _launchNow(creator);
        uint256 big = buy(t, creator, 3 ether);
        assertGt(_pct(t, creator), 500);
        _secondBlockAfterTheTax();
        uint256 lockerHad = t.balanceOf(address(locker)); // the launch's rounding dust already sits there
        vm.startPrank(creator);
        t.transfer(DEAD_ADDR, big / 4); // a burn
        t.transfer(address(locker), big / 4); // the locker
        t.transfer(address(escrow), big / 4); // the escrow
        vm.stopPrank();
        assertEq(t.balanceOf(DEAD_ADDR), big / 4);
        assertEq(t.balanceOf(address(locker)) - lockerHad, big / 4);
        assertEq(t.balanceOf(address(escrow)), big / 4);
        // and the launch's own wallet may receive over the cap, as it may buy over it
        TokenParams memory p = defaultParams(address(0), 0);
        p.salt = keccak256("r10 fee wallet");
        p.creatorFeeRecipient = bob;
        vm.prank(creator);
        (address a,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        Token t2 = Token(a);
        uint256 got = buy(t2, creator, 3 ether);
        uint256 had = t2.balanceOf(bob); // the launch's rounding dust may already sit with the fee wallet
        vm.prank(creator);
        t2.transfer(bob, got);
        assertEq(t2.balanceOf(bob) - had, got, "the fee wallet is the launch's own");
    }

    // ---------------------------------------------------------------- the seeder's minimum is what arrives

    function test_r10_seederMinimumIsNetOfTheTax() public {
        Token t = _launchNow(creator);
        pastTheBlocks();
        vm.warp(uint256(t.launchedAt()) + 1); // 25% tax
        PoolKey memory key = factory.poolKeyOf(address(t));
        bool zeroForOne = Currency.unwrap(key.currency0) == address(0);
        // what the pool would count out, from a dry run
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        uint256 net = seeder.swapExactIn{value: 0.01 ether}(key, zeroForOne, 0.01 ether, 0, alice);
        uint256 gross = net + t.balanceOf(DEAD_ADDR);
        vm.revertToState(snap);
        assertGt(gross, net, "the tax is real");
        // a minimum set from the pool's count is refused: less than that arrives
        vm.expectRevert();
        vm.prank(alice);
        seeder.swapExactIn{value: 0.01 ether}(key, zeroForOne, 0.01 ether, gross, alice);
        // a minimum set from the net passes and the return value is the net
        vm.prank(alice);
        uint256 out = seeder.swapExactIn{value: 0.01 ether}(key, zeroForOne, 0.01 ether, net, alice);
        assertEq(out, net);
        assertEq(t.balanceOf(alice), net);
    }

    // ---------------------------------------------------------------- the treasury

    address team = makeAddr("team");
    BuybackTreasury treasury;
    TickerToken fun;
    Token tickr;

    function _treasuryGenesis() internal {
        treasury = new BuybackTreasury(IFactory(address(factory)), IFeeEscrow(address(escrow)), seeder, IERC20(address(usdg)), team);
        vm.prank(owner);
        factory.setFeePolicy(FeePolicy({protocolFeeRecipient: address(treasury), creatorShareBps: 5_000, clubShareBps: 1_000, protocolShareBps: 4_000, buybackBurnBps: 0, club: address(tickers), hookFeeBps: 100, maxInternalPriceImpactBps: 300}));
        (,, bytes32 expected,) = tickers.previewLaunch("FUN", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.name = "tickr";
        p.symbol = "TICKR";
        p.expectedEconomics = expected;
        p.salt = keccak256("r10 genesis");
        vm.prank(creator);
        (address f, address t,) = tickers.launch{value: LAUNCH_FEE + tickers.NEW_TICKER_FEE()}("FUN", p, 0);
        fun = TickerToken(f);
        tickr = Token(t);
        pastTheWindow();
        usdg.mint(address(this), 10_000e6);
        usdg.approve(address(escrow), 10_000e6);
        escrow.creditToken(address(treasury), address(usdg), 10_000e6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdg);
        treasury.collect(tokens);
    }

    /// FUN a club sweep paid straight to the treasury waits for `collect`; a buy neither spends it nor counts it as a refund
    function test_r10_treasury_revenuePaidDirectlyIsNotABuysRefund() public {
        _treasuryGenesis();
        (uint256 usdgIn,) = treasury.previewBuy();
        uint256 prior = usdgIn * 3; // more than the tranche, so the old accounting would have underflowed
        usdg.mint(address(this), prior);
        usdg.approve(address(fun), prior);
        fun.mint(prior, address(treasury));
        uint256 earmark = treasury.earmarkedUsdg();
        uint256 teamBefore = usdg.balanceOf(team);
        (uint256 spent, uint256 burned) = treasury.buy();
        assertGt(burned, 0, "the buy went through");
        assertEq(fun.balanceOf(address(treasury)), prior, "the revenue is untouched");
        assertEq(treasury.earmarkedUsdg(), earmark - spent, "the earmark paid for the buy and nothing else");
        assertEq(treasury.totalUsdgSpent(), spent);
        // `collect` then splits the revenue the ordinary way
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdg);
        tokens[1] = address(fun);
        (uint256 total, uint256 toTeam, uint256 earmarked) = treasury.collect(tokens);
        assertEq(total, prior, "the revenue was converted at par");
        assertEq(toTeam, prior / 2, "half to the team");
        assertEq(earmarked, prior - prior / 2, "half earmarked");
        assertEq(usdg.balanceOf(team) - teamBefore, toTeam);
        assertEq(fun.balanceOf(address(treasury)), 0);
    }

    /// the launcher the treasury answers to is fixed at its first use; the owner's `setTickerLauncher` cannot move it
    function test_r10_treasury_launcherIsBoundAtFirstUse() public {
        _treasuryGenesis();
        assertEq(treasury.launcher(), address(tickers), "bound by the first collect");
        (address t0, address f0) = treasury.official();
        assertEq(t0, address(tickr));
        assertEq(f0, address(fun));
        TickerLauncher other = new TickerLauncher(IFactory(address(factory)), registry, IERC20(address(usdg)), seeder);
        vm.prank(owner);
        factory.setTickerLauncher(address(other));
        assertEq(factory.tickerLauncher(), address(other), "the factory moved");
        (address t1, address f1) = treasury.official();
        assertEq(t1, address(tickr), "the treasury did not");
        assertEq(f1, address(fun));
        (, uint256 burned) = treasury.buy();
        assertGt(burned, 0, "and it still buys the official coin");
    }
}
