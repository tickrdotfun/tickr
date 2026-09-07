// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {TickerToken} from "../src/TickerToken.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {BuybackTreasury} from "../src/BuybackTreasury.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {IFeeEscrow} from "../src/interfaces/IFeeEscrow.sol";
import {TokenParams, FeePolicy} from "../src/Types.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/src/libraries/FixedPoint96.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// A liquidity provider for the tests: one narrow position, paid for from its own balances.
contract NarrowLP is IUnlockCallback {
    IPoolManager immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function add(PoolKey memory key, int24 lower, int24 upper, uint128 liquidity) external {
        pm.unlock(abi.encode(key, lower, upper, liquidity));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (PoolKey memory key, int24 lower, int24 upper, uint128 liquidity) = abi.decode(data, (PoolKey, int24, int24, uint128));
        (BalanceDelta d,) = pm.modifyLiquidity(key, ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: 0}), "");
        _settle(key.currency0, d.amount0());
        _settle(key.currency1, d.amount1());
        return "";
    }

    function _settle(Currency c, int128 delta) internal {
        if (delta >= 0) return;
        uint256 owed = uint256(uint128(-delta));
        pm.sync(c);
        IERC20(Currency.unwrap(c)).transfer(address(pm), owed);
        pm.settle();
    }
}

/// The r11 audit round: the treasury's bound is the swap's own price limit and holds against liquidity that thins
/// out past it; the hold view says what a transfer may bring in the launch block; a self transfer never trips the cap;
/// the zap previews report what entered and left the coin's pool.
contract AuditR11Test is BaseTest {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    address team = makeAddr("team");
    BuybackTreasury treasury;
    TickerToken fun;
    Token tickr;

    function _launchNow(address who) internal returns (Token t) {
        TokenParams memory p = defaultParams(address(0), 0);
        vm.prank(who);
        (address a,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        return Token(a);
    }

    function _treasuryGenesis() internal {
        treasury = new BuybackTreasury(IFactory(address(factory)), IFeeEscrow(address(escrow)), seeder, IERC20(address(usdg)), team);
        vm.prank(owner);
        factory.setFeePolicy(FeePolicy({protocolFeeRecipient: address(treasury), creatorShareBps: 5_000, clubShareBps: 1_000, protocolShareBps: 4_000, buybackBurnBps: 0, club: address(tickers), hookFeeBps: 100, maxInternalPriceImpactBps: 300}));
        (,, bytes32 expected,) = tickers.previewLaunch("FUN", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.name = "tickr";
        p.symbol = "TICKR";
        p.expectedEconomics = expected;
        p.salt = keccak256("r11 genesis");
        p.salt = saltUnder(address(this), p, tickers.predictTicker("FUN"));
        // the fee read inside the call consumes the prank: the test contract is the sender here, as it always was
        vm.prank(creator);
        (address f, address t,) = tickers.launch{value: LAUNCH_FEE + tickers.NEW_TICKER_FEE()}("FUN", p, 0);
        fun = TickerToken(f);
        tickr = Token(t);
        pastTheWindow();
        usdg.mint(address(this), 100_000e6);
        usdg.approve(address(escrow), 100_000e6);
        escrow.creditToken(address(treasury), address(usdg), 100_000e6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdg);
        treasury.collect(tokens);
    }

    function _mintFun(address to, uint256 amount) internal {
        usdg.mint(address(this), amount);
        usdg.approve(address(fun), amount);
        fun.mint(amount, to);
    }

    /// the price of currency0 in currency1, from the pool's sqrt price, with 1e36 precision: with the coin as
    /// currency0 and an eighteen-decimal coin against a six-decimal name the raw price is around 1e-17, so 1e18
    /// alone would read it as a couple of units and a three percent move as five
    function _price(PoolKey memory key) internal view returns (uint256 p, uint160 sqrtP) {
        (sqrtP,,,) = poolManager.getSlot0(key.toId());
        p = FullMath.mulDiv(uint256(sqrtP) * uint256(sqrtP), 1e36, FixedPoint96.Q96 * FixedPoint96.Q96);
    }

    /// Thick liquidity at the price and thin liquidity past it: the sizing sees the thick part and would push the
    /// buy far through the thin part. The swap's own limit stops it at the bound and the rest of the FUN comes back.
    function test_r11_treasury_boundHoldsWhenLiquidityThinsPastIt() public {
        _treasuryGenesis();
        PoolKey memory key = factory.poolKeyOf(address(tickr));
        bool funIs0 = Currency.unwrap(key.currency0) == address(fun);
        // a provider buys a slice of TICKR and puts it right next to the price, on the side the buy will move into
        NarrowLP lp = new NarrowLP(poolManager);
        _mintFun(address(lp), 5_000e6);
        vm.startPrank(address(lp));
        fun.approve(address(seeder), 5_000e6);
        uint256 got = seeder.swapExactIn(key, funIs0, 5_000e6, 0, address(lp));
        vm.stopPrank();
        (uint160 sP, int24 tick,,) = poolManager.getSlot0(key.toId());
        int24 spacing = key.tickSpacing;
        int24 aligned = (tick / spacing) * spacing;
        if (tick < 0 && aligned != tick) aligned -= spacing;
        // a narrow range straddling the price: thick liquidity right here, and nothing of it past the next few ticks
        int24 lower = aligned - spacing;
        int24 upper = aligned + 2 * spacing;
        uint160 sl = TickMath.getSqrtPriceAtTick(lower);
        uint160 su = TickMath.getSqrtPriceAtTick(upper);
        // worth a few hundred dollars in all: far less than the tranche, so the buy runs through it into the thin part
        _mintFun(address(lp), 300e6);
        uint256 slice = (got * 6) / 100;
        uint256 a0 = funIs0 ? 300e6 : slice; // what the provider puts in of currency0
        uint256 a1 = funIs0 ? slice : 300e6; // and of currency1
        uint256 l0 = FullMath.mulDiv(FullMath.mulDiv(a0, sP, FixedPoint96.Q96), su, su - sP);
        uint256 l1 = FullMath.mulDiv(a1, FixedPoint96.Q96, sP - sl);
        uint128 liquidity = uint128((l0 < l1 ? l0 : l1) * 99 / 100);
        lp.add(key, lower, upper, liquidity);
        uint128 launchL = factory.getLaunchedToken(address(tickr)).liquidity;
        assertGt(poolManager.getLiquidity(key.toId()), launchL * 10, "the liquidity at the price is many times the launch position's");

        (uint256 p0,) = _price(key);
        (uint256 sized,) = treasury.previewBuy();
        uint256 earmark = treasury.earmarkedUsdg();
        (uint256 spent, uint256 burned) = treasury.buy();
        (uint256 p1,) = _price(key);
        assertGt(burned, 0);
        // the price moved, and by no more than the bound, although the sizing assumed the thick liquidity all the way
        uint256 moveBps = funIs0 ? ((p0 - p1) * 10_000) / p0 : ((p1 - p0) * 10_000) / p0;
        assertGt(moveBps, 0, "the buy moved the price");
        assertLe(moveBps, 300 + 1, "and never past the bound");
        // the pool stopped at the bound: it took less than the sizing offered, and the rest went back to the earmark
        assertLt(spent, sized, "the swap stopped short of what was offered");
        assertEq(treasury.earmarkedUsdg(), earmark - spent, "only what was spent left the earmark");
        assertEq(fun.balanceOf(address(treasury)), 0, "the refund was turned back into dollars");
        assertEq(treasury.totalUsdgSpent(), spent);
    }

    /// the ETH conversion in `collect` carries the same limit: at most the bound, the rest stays for the next pass
    function test_r11_treasury_ethConversionStopsAtTheBound() public {
        _treasuryGenesis();
        vm.warp(vm.getBlockTimestamp() + treasury.MIN_INTERVAL()); // the genesis launch fee was ETH the first collect converted
        vm.deal(address(this), 400 ether);
        escrow.credit{value: 400 ether}(address(treasury));
        PoolKey memory key = ethUsdgKey;
        (uint256 p0,) = _price(key);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdg);
        uint256 teamBefore = usdg.balanceOf(team);
        treasury.collect(tokens);
        (uint256 p1,) = _price(key);
        uint256 moveBps = p1 >= p0 ? ((p1 - p0) * 10_000) / p0 : ((p0 - p1) * 10_000) / p0;
        assertLe(moveBps, 300 + 1, "the conversion never moved the dollar pool past the bound");
        assertGt(usdg.balanceOf(team) - teamBefore, 0, "some ETH became dollars");
        assertGt(address(treasury).balance, 0, "the ETH the bound left stays for the next collect");
    }

    /// in the launch block the hold view says what a transfer may still bring; buys are closed there by `remainingBuy`
    function test_r11_remainingHoldInTheLaunchBlock() public {
        Token t = _launchNow(creator);
        uint256 cap = (t.totalSupply() * t.HOLD_CAP_BPS()) / 10_000;
        assertEq(t.remainingBuy(alice), 0, "no buying in the launch block");
        assertEq(t.remainingHold(alice), cap, "but a transfer may bring up to the cap");
        uint256 got = buy(t, creator, 1 ether);
        uint256 give = got < cap ? got : cap;
        vm.prank(creator);
        t.transfer(alice, give);
        assertEq(t.remainingHold(alice), cap - give, "the view follows what arrived");
        assertEq(t.balanceOf(alice), give);
    }

    /// a wallet at the cap may send coins to itself inside the window: nothing changes hands
    function test_r11_selfTransferAtTheCapPasses() public {
        Token t = _launchNow(creator);
        uint256 got = buy(t, creator, 3 ether);
        uint256 cap = (t.totalSupply() * t.HOLD_CAP_BPS()) / 10_000;
        vm.prank(creator);
        t.transfer(alice, cap); // exactly at the cap
        vm.roll(vm.getBlockNumber() + 1); // still inside the window
        vm.prank(alice);
        t.transfer(alice, cap);
        assertEq(t.balanceOf(alice), cap, "a self transfer at the cap passes and changes nothing");
        vm.expectRevert();
        vm.prank(creator);
        t.transfer(alice, 1); // one more from anyone else does not
        got;
    }

    /// the previews report what entered the coin's pool on a buy and what left it on a sell
    function test_r11_zapPreviewsReportThePoolLeg() public {
        (,, bytes32 expected,) = tickers.previewLaunch("BANANA", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        p.salt = saltUnder(address(this), p, tickers.predictTicker("BANANA"));
        // the fee read inside the call consumes the prank: the test contract is the sender here, as it always was
        vm.prank(creator);
        (address banana, address bread,) = tickers.launch{value: LAUNCH_FEE + tickers.NEW_TICKER_FEE()}("BANANA", p, 0);
        pastTheWindow();
        ZapRouter.Hop[] memory path = new ZapRouter.Hop[](3);
        PoolKey memory none;
        path[0] = ZapRouter.Hop({kind: 0, key: ethUsdgKey, pool: address(0)});
        path[1] = ZapRouter.Hop({kind: 2, key: none, pool: banana});
        path[2] = ZapRouter.Hop({kind: 0, key: factory.poolKeyOf(bread), pool: address(0)});
        ZapRouter.ZapParams memory bp = ZapRouter.ZapParams({token: bread, tokenIn: address(0), amountIn: 0, path: path, minTokensOut: 0, recipient: alice, deadline: vm.getBlockTimestamp() + 1 hours});
        uint256 quoteIn;
        uint256 coinsOut;
        vm.prank(alice);
        try zap.previewZap{value: 0.3 ether}(bp) {
            revert("preview did not revert");
        } catch (bytes memory r) {
            assembly {
                quoteIn := mload(add(r, 36))
                coinsOut := mload(add(r, 68))
            }
        }
        assertGt(quoteIn, 0, "the BANANA that entered BREAD's pool is reported");
        assertGt(coinsOut, 0);
        // the same trade for real: the pool received exactly the reported quote
        uint256 poolBefore = IERC20(banana).balanceOf(address(poolManager));
        vm.prank(alice);
        uint256 got = zap.zapBuy{value: 0.3 ether}(bp);
        assertEq(got, coinsOut, "the quote is the trade");
        assertEq(IERC20(banana).balanceOf(address(poolManager)) - poolBefore, quoteIn, "and the pool leg is what the preview said");
        // and back: the sell preview reports the BANANA the pool paid out
        ZapRouter.Hop[] memory back = new ZapRouter.Hop[](3);
        back[0] = path[2];
        back[1] = path[1];
        back[2] = path[0];
        ZapRouter.ZapSellParams memory sp = ZapRouter.ZapSellParams({token: bread, amountIn: got, path: back, tokenOut: address(0), minOut: 0, recipient: alice, deadline: vm.getBlockTimestamp() + 1 hours});
        vm.startPrank(alice);
        Token(bread).approve(address(zap), got);
        uint256 quoteOut;
        uint256 ethOut;
        try zap.previewZapSell(sp) {
            revert("preview did not revert");
        } catch (bytes memory r) {
            assembly {
                quoteOut := mload(add(r, 36))
                ethOut := mload(add(r, 68))
            }
        }
        vm.stopPrank();
        assertGt(quoteOut, 0, "the BANANA the pool paid out is reported");
        assertGt(ethOut, 0);
    }
}
