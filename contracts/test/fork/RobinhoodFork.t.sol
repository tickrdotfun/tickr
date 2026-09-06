// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {DeployStack} from "../../script/DeployStack.sol";
import {Token} from "../../src/Token.sol";
import {TickerToken} from "../../src/TickerToken.sol";
import {ZapRouter} from "../../src/ZapRouter.sol";
import {V4Seeder} from "../../src/libraries/V4Seeder.sol";
import {MarketQuoteLauncher} from "../../src/mode5/MarketQuoteLauncher.sol";
import {TokenParams, Socials, PairEconomics, LaunchedToken} from "../../src/Types.sol";

/// @notice Runs the real v2 lifecycle against the canonical Uniswap v4 deployment on Robinhood Chain.
/// Enable with: FORK=1 forge test --match-path test/fork/RobinhoodFork.t.sol --fork-url <rpc>
contract RobinhoodForkTest is Test, DeployStack {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    Stack s;
    bool live;
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_USD_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant V3_WETH_NVDA_500 = 0x62AB521f71431f78ac374CdbadC6cda3c8916b6C;
    address constant BURN = 0x000000000000000000000000000000000000dEaD;
    /// a liquid token on the chain with nothing to do with tickr, priced from its deepest v3 pool against WETH
    address constant LIVE_TOKEN = 0x39dBED3a2bd333467115dE45665cC57F813C4571;

    function setUp() public {
        live = vm.envOr("FORK", false);
        if (!live) return;
        require(block.chainid == 4663, "use --fork-url robinhood");
        s = _deployStack(address(this), address(this), address(this), address(this), IPoolManager(RH_POOL_MANAGER), IPositionManager(RH_POSITION_MANAGER), IAllowanceTransfer(PERMIT2), RH_USDG);
        _configureStack(s, RH_USDG);
        s.factory.setLaunchEnabled(true);
        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    receive() external payable {}

    function _params(string memory name, string memory symbol, bytes32 expected, string memory salt) internal pure returns (TokenParams memory) {
        return TokenParams({name: name, symbol: symbol, logo: "", description: "", socials: Socials("", "", "", "", ""), creatorFeeRecipient: address(0), creatorTaxBps: 0, buybackEnabled: false, expectedEconomics: expected, salt: keccak256(bytes(salt))});
    }

    function test_fork_ethLaunchOpensALockedPoolOnCanonicalV4_andFeesCollect() public {
        if (!live) return;
        bytes32 expected = s.factory.previewLaunchEconomics(0, address(0)); // before the prank: a view call would consume it
        vm.prank(creator);
        (address t, bytes32 poolId) = s.factory.launchToken{value: LAUNCH_FEE}(_params("Fork Meme", "FORK", expected, "fork"), 0, address(0));
        vm.roll(vm.getBlockNumber() + 3); vm.warp(vm.getBlockTimestamp() + 6); // past the launch block caps and the snipe window
        LaunchedToken memory l = s.factory.getLaunchedToken(t);
        assertEq(IERC721(RH_POSITION_MANAGER).ownerOf(l.lpTokenId), address(s.locker), "LP NFT in locker");
        PoolKey memory key = s.factory.poolKeyOf(t);
        assertEq(PoolId.unwrap(key.toId()), poolId);
        assertEq(address(key.hooks), address(0), "no hook");
        // buy, sell, collect: the split lands where it should on both sides
        vm.prank(alice);
        uint256 got = s.seeder.swapExactIn{value: 1 ether}(key, true, 1 ether, 0, alice);
        assertGt(got, 0);
        vm.startPrank(alice);
        Token(t).approve(address(s.seeder), got / 2);
        s.seeder.swapExactIn(key, false, got / 2, 0, alice);
        vm.stopPrank();
        (uint256 q, uint256 c) = s.locker.collectFees(t);
        assertGt(q, 0, "ETH fees collected");
        assertGt(c, 0, "coin fees collected");
        assertEq(Token(t).balanceOf(BURN), (c * 4_000) / 10_000, "the protocol's share of the coin side burned");
        assertEq(s.escrow.balanceOfToken(creator, t), c - (c * 4_000) / 10_000, "the creator holds the rest in the coin");
        assertGt(s.escrow.balanceOf(creator), 0, "creator's ETH in escrow");
        emit log_named_address("FORK coin", t);
        emit log_named_bytes32("FORK pool id", poolId);
        emit log_named_uint("ETH fees collected (wei)", q);
        emit log_named_uint("coin burned", Token(t).balanceOf(BURN));
    }

    function test_fork_inventingATickerOpensItsGuardedDollarPool_realUsdg() public {
        if (!live) return;
        (,, bytes32 expected,) = s.tickers.previewLaunch("BANANA", 0);
        uint256 value = LAUNCH_FEE + s.tickers.NEW_TICKER_FEE();
        vm.prank(creator);
        (address banana, address bread,) = s.tickers.launch{value: value}("BANANA", _params("Fork Bread", "BREAD", expected, "fork-bread"), 0);
        vm.roll(vm.getBlockNumber() + 3); vm.warp(vm.getBlockTimestamp() + 6); // past the launch block caps and the snipe window
        assertTrue(s.seeder.hasChartPool(banana), "BANANA/USDG exists on the canonical pool manager");
        PoolKey memory key = s.seeder.chartKey(banana);
        (uint160 sqrtP, int24 tick,,) = IPoolManager(RH_POOL_MANAGER).getSlot0(key.toId());
        assertGt(sqrtP, 0);
        assertLe(tick, 0);
        assertGe(tick, -2);
        assertGt(IPoolManager(RH_POOL_MANAGER).getLiquidity(key.toId()), 0);
        emit log_named_address("BANANA", banana);
        emit log_named_bytes32("BANANA/USDG pool id", PoolId.unwrap(key.toId()));
        emit log_named_int("tick after the listing swap", tick);
        emit log_named_uint("real USDG in the dollar pool", IERC20(RH_USDG).balanceOf(RH_POOL_MANAGER));

        // a shove with real dollars reverts and the tick does not move
        PoolSwapTest sw = new PoolSwapTest(IPoolManager(RH_POOL_MANAGER));
        PoolKey memory ethUsdg = PoolKey({currency0: Currency.wrap(address(0)), currency1: Currency.wrap(RH_USDG), fee: 100, tickSpacing: 1, hooks: IHooks(address(0))});
        vm.prank(bob);
        s.seeder.swapExactIn{value: 1 ether}(ethUsdg, true, 1 ether, 0, bob);
        bool usdgIs0 = Currency.unwrap(key.currency0) == RH_USDG;
        (, int24 tickBefore,,) = IPoolManager(RH_POOL_MANAGER).getSlot0(key.toId());
        vm.startPrank(bob);
        IERC20(RH_USDG).approve(address(sw), type(uint256).max);
        vm.expectRevert();
        sw.swap(key, SwapParams({zeroForOne: usdgIs0, amountSpecified: -int256(300e6), sqrtPriceLimitX96: usdgIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1}), PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), "");
        vm.stopPrank();
        (, int24 tickAfter,,) = IPoolManager(RH_POOL_MANAGER).getSlot0(key.toId());
        assertEq(tickAfter, tickBefore, "the guard held");
        emit log_named_int("tick after the failed shove", tickAfter);

        bread;
    }

    function test_fork_nvdaQuotedLaunchThroughLiveV3() public {
        if (!live) return;
        s.registry.register(NVDA, "NVDA", "Robinhood Assets", 2, NVDA_USD_FEED);
        (, PairEconomics memory econ,) = s.stockQuote.previewLaunch(0, NVDA);
        TokenParams memory p = _params("Fork Chip", "CHIP", s.factory.previewLaunchEconomicsWithPair(0, NVDA, econ), "fork-nvda");
        vm.prank(creator);
        (address t,) = s.stockQuote.launchWithStockQuote{value: LAUNCH_FEE}(p, 0, NVDA);
        vm.roll(vm.getBlockNumber() + 3); vm.warp(vm.getBlockTimestamp() + 6); // past the launch block caps and the snipe window
        ZapRouter.Hop[] memory path = new ZapRouter.Hop[](2);
        PoolKey memory empty;
        path[0] = ZapRouter.Hop({kind: 1, key: empty, pool: V3_WETH_NVDA_500});
        path[1] = ZapRouter.Hop({kind: 0, key: s.factory.poolKeyOf(t), pool: address(0)});
        vm.prank(alice);
        uint256 out = s.zap.zapBuy{value: 0.1 ether}(ZapRouter.ZapParams({token: t, tokenIn: address(0), amountIn: 0, path: path, minTokensOut: 0, recipient: alice, deadline: vm.getBlockTimestamp() + 1 hours}));
        assertGt(out, 0, "alice paid ETH and holds a coin quoted in NVDA");
        assertEq(IERC20(NVDA).balanceOf(address(s.zap)), 0);
    }

    function test_fork_launchPricedInALiveChainToken_andZapFromEth() public {
        if (!live) return;
        (bytes32 expected, PairEconomics memory econ, MarketQuoteLauncher.Market memory m,, uint256 px) = s.marketQuote.previewLaunch(0, LIVE_TOKEN);
        emit log_named_address("FORK market pool", m.pool);
        emit log_named_uint("FORK pool WETH depth (wei)", m.depth);
        emit log_named_uint("FORK base per quote x1e18", px);
        emit log_named_uint("FORK phantom in quote units", econ.phantomQuote);
        assertEq(m.counter, RH_WETH, "priced against WETH");
        assertGe(m.depth, MIN_DEPTH_WETH);
        TokenParams memory p = _params("Fork Live", "LIVE", expected, "fork-live");
        vm.prank(creator);
        (address t,) = s.marketQuote.launchWithMarketQuote{value: LAUNCH_FEE}(p, 0, LIVE_TOKEN);
        vm.roll(vm.getBlockNumber() + 3); vm.warp(vm.getBlockTimestamp() + 6); // past the launch block caps and the snipe window
        assertEq(s.factory.getLaunchedToken(t).pairToken, LIVE_TOKEN);
        ZapRouter.Hop[] memory path = new ZapRouter.Hop[](2);
        PoolKey memory empty;
        path[0] = ZapRouter.Hop({kind: 1, key: empty, pool: m.pool});
        path[1] = ZapRouter.Hop({kind: 0, key: s.factory.poolKeyOf(t), pool: address(0)});
        vm.prank(alice);
        uint256 out = s.zap.zapBuy{value: 0.05 ether}(ZapRouter.ZapParams({token: t, tokenIn: address(0), amountIn: 0, path: path, minTokensOut: 0, recipient: alice, deadline: vm.getBlockTimestamp() + 1 hours}));
        assertGt(out, 0, "alice paid ETH and holds a coin priced in a live chain token");
        assertEq(IERC20(LIVE_TOKEN).balanceOf(address(s.zap)), 0);
        emit log_named_address("FORK coin priced in the live token", t);
    }

    /// Proof 1: the club is frozen at launch. The owner switches the factory's club to an EOA afterwards and a
    /// collection on the existing ticker launch still pays the launcher, and does not revert.
    function test_fork_proof1_clubFrozenAtLaunch_ownerSwitchDoesNotTouchIt() public {
        if (!live) return;
        uint256 fee = LAUNCH_FEE + s.tickers.NEW_TICKER_FEE();
        (,, bytes32 expected,) = s.tickers.previewLaunch("FRZN", 0);
        vm.prank(creator);
        (address ticker, address t,) = s.tickers.launch{value: fee}("FRZN", _params("Frozen", "FRZN", expected, "fork-frozen"), 0);
        vm.roll(vm.getBlockNumber() + 3); vm.warp(vm.getBlockTimestamp() + 6); // past the launch block caps and the snipe window
        assertEq(s.factory.getLaunchFeePolicy(t).club, address(s.tickers), "club written into the policy");
        s.factory.setFeeClub(bob); // the owner here is the test contract; bob is an EOA
        // dollars for alice from the live ETH/USDG pool, wrapped into the ticker, spent in the coin's pool
        PoolKey memory ethUsdg = PoolKey(Currency.wrap(address(0)), Currency.wrap(RH_USDG), ETH_USDG_FEE, ETH_USDG_TICK_SPACING, IHooks(address(0)));
        vm.startPrank(alice);
        uint256 usd = s.seeder.swapExactIn{value: 0.05 ether}(ethUsdg, true, 0.05 ether, 0, alice);
        IERC20(RH_USDG).approve(ticker, usd);
        TickerToken(ticker).mint(usd, alice);
        IERC20(ticker).approve(address(s.seeder), usd);
        PoolKey memory key = s.factory.poolKeyOf(t);
        s.seeder.swapExactIn(key, Currency.unwrap(key.currency0) == ticker, usd, 0, alice);
        vm.stopPrank();
        uint256 clubBefore = IERC20(ticker).balanceOf(address(s.tickers));
        (uint256 q,) = s.locker.collectFees(t);
        emit log_named_uint("PROOF1 quote collected (ticker units)", q);
        emit log_named_uint("PROOF1 club slice paid to the frozen club", IERC20(ticker).balanceOf(address(s.tickers)) - clubBefore);
        emit log_named_address("PROOF1 factory club now", s.factory.feeClub());
        assertGt(IERC20(ticker).balanceOf(address(s.tickers)), clubBefore, "frozen club paid");
        assertEq(IERC20(ticker).balanceOf(bob), 0, "the EOA got nothing");
    }

    /// Proof 2: what a pool cannot take comes back. A narrow ETH/USDG pool on a fresh fee tier, a swap far past it.
    function test_fork_proof2_unfilledInputIsRefunded() public {
        if (!live) return;
        // dollars for the position, from the live pool
        PoolKey memory ethUsdg = PoolKey(Currency.wrap(address(0)), Currency.wrap(RH_USDG), ETH_USDG_FEE, ETH_USDG_TICK_SPACING, IHooks(address(0)));
        uint256 usd = s.seeder.swapExactIn{value: 0.2 ether}(ethUsdg, true, 0.2 ether, 0, address(this));
        (uint160 live0,,,) = IPoolManager(RH_POOL_MANAGER).getSlot0(ethUsdg.toId());
        int24 tick = TickMath.getTickAtSqrtPrice(live0);
        PoolKey memory narrow = PoolKey(Currency.wrap(address(0)), Currency.wrap(RH_USDG), 7777, 77, IHooks(address(0)));
        IPoolManager(RH_POOL_MANAGER).initialize(narrow, live0);
        int24 lo = (tick / 77) * 77 - 154;
        int24 hi = lo + 308;
        V4Seeder.seedRange(IPositionManager(RH_POSITION_MANAGER), IAllowanceTransfer(PERMIT2), narrow, live0, lo, hi, 0.1 ether, usd, address(this));
        uint256 before = alice.balance;
        vm.prank(alice);
        uint256 out = s.seeder.swapExactIn{value: 5 ether}(narrow, true, 5 ether, 0, alice);
        uint256 spent = before - alice.balance;
        emit log_named_uint("PROOF2 sent (wei)", 5 ether);
        emit log_named_uint("PROOF2 taken by the pool (wei)", spent);
        emit log_named_uint("PROOF2 refunded (wei)", 5 ether - spent);
        emit log_named_uint("PROOF2 USDG received", out);
        assertLt(spent, 5 ether, "the rest came back");
        assertGt(out, 0);
        assertEq(address(s.seeder).balance, 0, "nothing stays in the seeder");
    }

    /// Proof 3: a six-decimal quote at a tiny phantom, real USDG, both currency orders.
    function test_fork_proof3_usdgTinyPhantom_bothOrders() public {
        if (!live) return;
        s.factory.setPairTokenEconomics(RH_USDG, 1e6);
        bool did0;
        bool did1;
        for (uint256 i; i < 64 && !(did0 && did1); i++) {
            TokenParams memory p = _params("Order", "ORDR", s.factory.previewLaunchEconomics(0, RH_USDG), string.concat("fork-order-", vm.toString(i)));
            address predicted = s.launchDeployer.predictToken(creator, p, SUPPLY);
            bool coinIs0 = predicted < RH_USDG;
            if ((coinIs0 && did0) || (!coinIs0 && did1)) continue;
            vm.prank(creator);
            (address t,) = s.factory.launchToken{value: LAUNCH_FEE}(p, 0, RH_USDG);
            vm.roll(vm.getBlockNumber() + 3); vm.warp(vm.getBlockTimestamp() + 6); // past the launch block caps and the snipe window
            LaunchedToken memory l = s.factory.getLaunchedToken(t);
            emit log_named_address(coinIs0 ? "PROOF3 coin as currency0" : "PROOF3 coin as currency1", t);
            emit log_named_uint("PROOF3 liquidity", l.liquidity);
            assertGt(l.liquidity, 0);
            if (coinIs0) did0 = true;
            else did1 = true;
        }
        assertTrue(did0 && did1, "both orders launched on the real USDG");
    }

    /// The coin side splits on the real chain: sell, collect, the dead balance grows by the protocol's share of the coin
    /// fee and the creator's escrow in the coin grows by the rest.
    function test_fork_sellSide_creatorKeepsTheirShare_protocolAndClubBurn() public {
        if (!live) return;
        bytes32 expected = s.factory.previewLaunchEconomics(0, address(0));
        vm.prank(creator);
        (address t,) = s.factory.launchToken{value: LAUNCH_FEE}(_params("Fork Burn", "BURN", expected, "fork-burn"), 0, address(0));
        vm.roll(vm.getBlockNumber() + 3); vm.warp(vm.getBlockTimestamp() + 6); // past the launch block caps and the snipe window
        PoolKey memory key = s.factory.poolKeyOf(t);
        vm.prank(alice);
        uint256 got = s.seeder.swapExactIn{value: 0.5 ether}(key, true, 0.5 ether, 0, alice);
        vm.startPrank(alice);
        Token(t).approve(address(s.seeder), got);
        s.seeder.swapExactIn(key, false, got, 0, alice);
        vm.stopPrank();
        uint256 deadBefore = Token(t).balanceOf(BURN);
        uint256 creatorEthBefore = s.escrow.balanceOf(creator);
        (uint256 q, uint256 c) = s.locker.collectFees(t);
        assertGt(c, 0, "coin fees collected");
        uint256 burned = (c * 4_000) / 10_000;
        assertEq(Token(t).balanceOf(BURN) - deadBefore, burned, "the protocol's 40% of the coin side is dead");
        assertEq(s.escrow.balanceOfToken(creator, t), c - burned, "the creator holds its 60% of the coin side");
        assertGt(s.escrow.balanceOf(creator) - creatorEthBefore, 0, "creator earned the quote on the buy");
        assertEq(Token(t).totalSupply(), SUPPLY);
        emit log_named_uint("BURN coin fee collected", c);
        emit log_named_uint("BURN dead balance after", Token(t).balanceOf(BURN));
        emit log_named_uint("BURN quote collected (wei)", q);
    }

    /// Kept short on purpose: the public node prunes state after a few minutes, so a long fork test can see a
    /// fresh storage slot fail near its end. This one launches and zaps right away.
    function test_fork_zapEthIntoACoinUnderATicker() public {
        if (!live) return;
        (,, bytes32 expected,) = s.tickers.previewLaunch("PEEL", 0);
        uint256 value = LAUNCH_FEE + s.tickers.NEW_TICKER_FEE();
        vm.prank(creator);
        (address peel, address coin,) = s.tickers.launch{value: value}("PEEL", _params("Fork Peel Coin", "PEELC", expected, "fork-peel"), 0);
        vm.roll(vm.getBlockNumber() + 3); vm.warp(vm.getBlockTimestamp() + 6); // past the launch block caps and the snipe window
        PoolKey memory ethUsdg = PoolKey({currency0: Currency.wrap(address(0)), currency1: Currency.wrap(RH_USDG), fee: 100, tickSpacing: 1, hooks: IHooks(address(0))});
        ZapRouter.Hop[] memory path = new ZapRouter.Hop[](3);
        PoolKey memory none;
        path[0] = ZapRouter.Hop({kind: 0, key: ethUsdg, pool: address(0)});
        path[1] = ZapRouter.Hop({kind: 2, key: none, pool: peel});
        path[2] = ZapRouter.Hop({kind: 0, key: s.factory.poolKeyOf(coin), pool: address(0)});
        vm.prank(alice);
        uint256 out = s.zap.zapBuy{value: 0.2 ether}(ZapRouter.ZapParams({token: coin, tokenIn: address(0), amountIn: 0, path: path, minTokensOut: 0, recipient: alice, deadline: vm.getBlockTimestamp() + 1 hours}));
        assertGt(out, 0, "ETH became the coin through USDG and the wrapper");
        assertEq(Token(coin).balanceOf(alice), out);
        emit log_named_uint("coins bought with 0.2 ETH through USDG and PEEL", out);
    }
}
