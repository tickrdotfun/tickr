// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/src/libraries/FixedPoint96.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LaunchedToken} from "./Types.sol";
import {IFactory} from "./interfaces/IFactory.sol";
import {IFeeEscrow} from "./interfaces/IFeeEscrow.sol";
import {ITickerToken} from "./interfaces/ITickerToken.sol";
import {PriceMath} from "./libraries/PriceMath.sol";
import {TickerLauncher} from "./TickerLauncher.sol";
import {LaunchSeeder} from "./LaunchSeeder.sol";

/// @title BuybackTreasury
/// @notice The protocol's fee share, put to one use. The factory names this contract as the protocol fee
/// recipient, so every launch from the first one on credits its protocol share here, in `FeeEscrow`. Anyone may
/// `collect`: the treasury claims what the escrow holds for it, turns what it can into dollars (invented tickers
/// unwrap at par, ETH goes through the live ETH/USDG pool by the seeder's own swap), forwards the team's share
/// and everything it cannot convert to the team wallet, and earmarks the rest for burning: half at the start, and
/// only ever more, since the share can be raised by the factory's owner after a delay and never lowered. Anyone may then `buy`: earmarked
/// dollars become FUN one for one, FUN buys TICKR in its own pool, and the TICKR goes to the dead address.
///
/// The official coin is found on chain, never set: FUN is the ticker named FUN, TICKR the first coin launched under
/// it, which the genesis launch is. A buy is rate-limited, bounded in size and in price impact, and computes its own
/// floor on what it must receive, since whoever calls cannot be trusted to supply one. Nothing here has an owner,
/// and nothing can leave except to the team wallet and the dead address. Burning takes coins out of circulation;
/// it does not promise anything about the price.
contract BuybackTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    /// @notice How long a proposed raise of the burn share waits before anyone may apply it.
    uint256 public constant SHARE_DELAY = 3 days;
    /// @notice A buy may move a pool's price by at most this much.
    uint256 public constant MAX_IMPACT_BPS = 300;
    /// @notice The least time between two buys.
    uint256 public constant MIN_INTERVAL = 10 minutes;
    /// @notice A single buy spends at most this share of the earmarked dollars.
    uint256 public constant MAX_TRANCHE_BPS = 500;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant PIPS = 1_000_000;
    /// @dev The live ETH/USDG pool the seeder converts the ticker fee through: fee 0.01%, spacing 1, no hook.
    uint24 internal constant ETH_USDG_FEE = 100;
    int24 internal constant ETH_USDG_TICK_SPACING = 1;

    IFactory public immutable factory;
    IFeeEscrow public immutable escrow;
    LaunchSeeder public immutable seeder;
    IERC20 public immutable usdg;
    address public immutable teamWallet;

    /// @notice The share of protocol revenue that buys and burns, in basis points; the rest goes to the team wallet.
    /// Starts at half. It only ever goes up: the factory's owner proposes a higher share, and after `SHARE_DELAY`
    /// anyone may apply it. Nothing lowers it and nothing cancels a proposal except a higher one.
    uint16 public buybackShareBps;
    /// @notice A proposed raise waiting out its delay; zero when none.
    uint16 public pendingShareBps;
    /// @notice When the pending raise may be applied.
    uint256 public shareEffectiveAt;

    /// @notice Dollars set aside for buys, held here until spent.
    uint256 public earmarkedUsdg;
    uint256 public totalUsdgSpent;
    uint256 public totalTickrBurned;
    uint256 public lastBuyAt;

    event Collected(uint256 usdgTotal, uint256 toTeam, uint256 earmarked);
    /// @notice An asset the treasury cannot convert, sent whole to the team wallet.
    event Forwarded(address indexed asset, uint256 amount);
    event BoughtAndBurned(uint256 usdgIn, uint256 tickrOut, address indexed caller);
    /// @notice The treasury fixed the ticker launcher it answers to.
    event LauncherBound(address launcher);
    /// @notice The factory's owner proposed a higher burn share; it may be applied from `effectiveAt`.
    event BuybackShareProposed(uint16 bps, uint256 effectiveAt);
    /// @notice The burn share went up.
    event BuybackShareRaised(uint16 bps);

    error TooSoon();
    error NotFactoryOwner();
    error ShareNotHigher();
    error ShareTooHigh();
    error NothingPending();
    error TooEarly(uint256 effectiveAt);
    error NothingEarmarked();
    error NotYetLaunched();
    error NothingToBuy();
    error NotFromEscrow();

    constructor(IFactory factory_, IFeeEscrow escrow_, LaunchSeeder seeder_, IERC20 usdg_, address teamWallet_) {
        require(teamWallet_ != address(0), "BuybackTreasury: team wallet");
        factory = factory_;
        escrow = escrow_;
        seeder = seeder_;
        usdg = usdg_;
        teamWallet = teamWallet_;
        buybackShareBps = 5_000;
    }

    // ---------------------------------------------------------------- the burn share, up only

    /// @notice Propose a higher burn share. Only the factory's owner, only upward, never above all of it. A newer
    /// proposal replaces the pending one and the delay starts again.
    function proposeBuybackShare(uint16 bps) external {
        if (msg.sender != factory.owner()) revert NotFactoryOwner();
        if (bps <= buybackShareBps) revert ShareNotHigher();
        if (bps > BPS) revert ShareTooHigh();
        pendingShareBps = bps;
        shareEffectiveAt = block.timestamp + SHARE_DELAY;
        emit BuybackShareProposed(bps, shareEffectiveAt);
    }

    /// @notice Apply the pending raise once its delay has passed. Anyone may call.
    function applyBuybackShare() external {
        uint16 bps = pendingShareBps;
        if (bps == 0) revert NothingPending();
        if (block.timestamp < shareEffectiveAt) revert TooEarly(shareEffectiveAt);
        buybackShareBps = bps;
        pendingShareBps = 0;
        shareEffectiveAt = 0;
        emit BuybackShareRaised(bps);
    }

    /// @dev Launch fees arrive as ETH from the escrow; a swap that takes less than it was sent gives the rest back.
    receive() external payable {
        if (msg.sender != address(escrow) && msg.sender != address(seeder)) revert NotFromEscrow();
    }

    // ---------------------------------------------------------------- views

    /// @notice The official coin and its ticker, read from the chain: FUN, and the first coin launched under it.
    /// Both zero before genesis.
    function official() public view returns (address tickr, address fun) {
        TickerLauncher tl = _launcherView();
        if (address(tl) == address(0)) return (address(0), address(0));
        fun = tl.tickerFor("FUN");
        if (fun == address(0)) return (address(0), address(0));
        if (tl.pairCount(fun) == 0) return (address(0), fun);
        tickr = tl.pairAt(fun, 0);
    }

    /// @dev The ticker launcher the treasury answers to. Read from the factory until the first `collect` or `buy`
    /// after wiring, and fixed from then on, so a later `setTickerLauncher` by the owner cannot change what FUN is,
    /// what the official coin is, or which wrappers convert.
    function _launcherView() internal view returns (TickerLauncher) {
        address a = launcher;
        return TickerLauncher(a == address(0) ? factory.tickerLauncher() : a);
    }

    function _launcher() internal returns (TickerLauncher tl) {
        address a = launcher;
        if (a == address(0)) {
            a = factory.tickerLauncher();
            if (a != address(0)) {
                launcher = a;
                emit LauncherBound(a);
            }
        }
        return TickerLauncher(a);
    }

    /// @notice The ticker launcher the treasury is bound to; zero until the first `collect` or `buy` after wiring.
    address public launcher;
    /// @notice When ETH was last turned into dollars; the next conversion waits `MIN_INTERVAL` from here.
    uint256 public lastEthAt;

    /// @notice When the next buy may happen; zero until the first one.
    function nextBuyAt() public view returns (uint256) {
        return lastBuyAt == 0 ? 0 : lastBuyAt + MIN_INTERVAL;
    }

    /// @notice What the next `buy` would spend and the least TICKR it would insist on. Zero when there is nothing
    /// earmarked or the official coin has not launched; ignores the clock.
    function previewBuy() public view returns (uint256 usdgIn, uint256 minTickrOut) {
        if (earmarkedUsdg == 0) return (0, 0);
        (address tickr,) = official();
        if (tickr == address(0)) return (0, 0);
        (,, minTickrOut, usdgIn,,) = _sizeBuy(tickr);
    }

    // ---------------------------------------------------------------- collect

    /// @notice Claim everything the escrow holds for the treasury (ETH, and each of `tokens`), convert what converts,
    /// pay the team its slice and everything unconvertible, and earmark the rest for buys. Anyone may call.
    function collect(address[] calldata tokens) external nonReentrant returns (uint256 usdgTotal, uint256 toTeam, uint256 earmarked) {
        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        TickerLauncher tl = _launcher();
        for (uint256 i; i < tokens.length; i++) {
            address t = tokens[i];
            if (escrow.balanceOfToken(address(this), t) > 0) escrow.claimToken(t);
            if (t == address(usdg)) continue;
            uint256 bal = IERC20(t).balanceOf(address(this));
            if (bal == 0) continue;
            if (address(tl) != address(0) && tl.isTicker(t)) {
                // a wrapped dollar unwraps at par, no fee
                ITickerToken(t).redeem(bal, address(this));
            } else {
                // a Stock Token, a coin used as a quote, anything else: nothing here converts it, so the team takes it whole
                IERC20(t).safeTransfer(teamWallet, bal);
                emit Forwarded(t, bal);
            }
        }
        // ETH becomes dollars through the live pool, as much as fits inside the impact bound; the rest waits
        uint256 eth = address(this).balance;
        if (eth > 0) {
            PoolKey memory key = _ethUsdgKey();
            (uint256 ethIn, uint256 minOut, uint160 limit) = _bounded(key, true, eth, 0, 0);
            // the pool stops at the bound; ETH it did not take comes back and waits for the next collect. one conversion
            // per interval, like a buy, so a caller cannot run collect again and again against a price of their making
            if (ethIn > 0 && (lastEthAt == 0 || block.timestamp >= lastEthAt + MIN_INTERVAL)) {
                seeder.swapExactInBounded{value: ethIn}(key, true, ethIn, minOut, address(this), limit);
                lastEthAt = block.timestamp;
            }
        }
        uint256 have = usdg.balanceOf(address(this));
        usdgTotal = have - earmarkedUsdg;
        toTeam = (usdgTotal * (BPS - buybackShareBps)) / BPS;
        earmarked = usdgTotal - toTeam;
        if (toTeam > 0) usdg.safeTransfer(teamWallet, toTeam);
        earmarkedUsdg += earmarked;
        emit Collected(usdgTotal, toTeam, earmarked);
    }

    // ---------------------------------------------------------------- buy

    /// @notice Spend one tranche of the earmarked dollars on TICKR and burn it. Anyone may call, once per interval.
    function buy() external nonReentrant returns (uint256 usdgIn, uint256 tickrOut) {
        if (lastBuyAt != 0 && block.timestamp < lastBuyAt + MIN_INTERVAL) revert TooSoon();
        if (earmarkedUsdg == 0) revert NothingEarmarked();
        _launcher();
        (address tickr, address fun) = official();
        if (tickr == address(0)) revert NotYetLaunched();
        (PoolKey memory key, bool funIs0, uint256 minOut, uint256 sized,, uint160 limit) = _sizeBuy(tickr);
        usdgIn = sized;
        if (usdgIn == 0) revert NothingToBuy();
        // FUN that club sweeps paid straight to the treasury is revenue waiting for `collect`, not part of this buy
        uint256 funBefore = IERC20(fun).balanceOf(address(this));
        // dollars become FUN one for one, FUN becomes TICKR in the pool, and the TICKR lands at the dead address
        usdg.forceApprove(fun, usdgIn);
        ITickerToken(fun).mint(usdgIn, address(this));
        IERC20(fun).forceApprove(address(seeder), usdgIn);
        // the pool stops at the bound whatever its liquidity turns out to be; FUN it did not take comes back below
        tickrOut = seeder.swapExactInBounded(key, funIs0, usdgIn, minOut, DEAD, limit);
        earmarkedUsdg -= usdgIn;
        // FUN the pool did not take comes back as dollars and stays earmarked
        uint256 left = IERC20(fun).balanceOf(address(this)) - funBefore;
        if (left > 0) {
            ITickerToken(fun).redeem(left, address(this));
            earmarkedUsdg += left;
            usdgIn -= left;
        }
        lastBuyAt = block.timestamp;
        totalUsdgSpent += usdgIn;
        totalTickrBurned += tickrOut;
        emit BoughtAndBurned(usdgIn, tickrOut, msg.sender);
    }

    // ---------------------------------------------------------------- internals

    /// @dev At most the tranche share of the earmark; all of it when the earmark is too small to split.
    function _tranche() internal view returns (uint256 t) {
        t = (earmarkedUsdg * MAX_TRANCHE_BPS) / BPS;
        if (t == 0) t = earmarkedUsdg;
    }

    /// @dev The next buy, sized against TICKR's pool. Before the first trade the launch position is not yet in range,
    /// so the pool reports no liquidity at the price; the position's own liquidity and its edge stand in, which
    /// is exactly what the swap meets once the price reaches it.
    function _sizeBuy(address tickr) internal view returns (PoolKey memory key, bool funIs0, uint256 minOut, uint256 usdgIn, LaunchedToken memory l, uint160 limit) {
        l = factory.getLaunchedToken(tickr);
        key = factory.poolKeyOf(tickr);
        funIs0 = Currency.unwrap(key.currency0) != tickr;
        uint160 edge = funIs0 ? TickMath.getSqrtPriceAtTick(l.tickUpper) : TickMath.getSqrtPriceAtTick(l.tickLower);
        (usdgIn, minOut, limit) = _bounded(key, funIs0, _tranche(), l.liquidity, edge);
    }

    function _ethUsdgKey() internal view returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdg)), ETH_USDG_FEE, ETH_USDG_TICK_SPACING, IHooks(address(0)));
    }

    /// @dev The most of `available` that moves `key`'s price by no more than MAX_IMPACT_BPS at the liquidity in range
    /// now, the least the swap must return for it, priced where the move ends, and that end itself as the swap's own
    /// price limit. The limit is what makes the bound hold whatever the liquidity turns out to be: a thinner range past
    /// it stops the swap at the bound with the rest of the input refunded, a thicker one just makes the buy cheaper.
    /// @param fallbackLiquidity liquidity waiting past `edge` when the pool has none at its price: a launch position
    /// before its first trade; zero when there is no such thing
    /// @param edge the sqrt price where that liquidity begins, in the direction of the trade
    function _bounded(PoolKey memory key, bool zeroForOne, uint256 available, uint128 fallbackLiquidity, uint160 edge)
        internal
        view
        returns (uint256 amountIn, uint256 minOut, uint160 limit)
    {
        IPoolManager pm = seeder.poolManager();
        (uint160 s0,,,) = pm.getSlot0(key.toId());
        uint128 liquidity = pm.getLiquidity(key.toId());
        if (liquidity == 0 && fallbackLiquidity != 0 && edge != 0) {
            // nothing to meet until the edge, which may be the price itself: the move is measured from where the position begins
            bool ahead = zeroForOne ? edge <= s0 : edge >= s0;
            if (ahead) {
                s0 = edge;
                liquidity = fallbackLiquidity;
            }
        }
        if (s0 == 0 || liquidity == 0 || available == 0) return (0, 0, 0);
        // the pool's price is currency1 per currency0: it falls when currency0 goes in, rises when currency1 does
        uint160 s1 = zeroForOne ? PriceMath.scaleSqrtPrice(s0, BPS, BPS + MAX_IMPACT_BPS) : PriceMath.scaleSqrtPrice(s0, BPS + MAX_IMPACT_BPS, BPS);
        limit = s1;
        uint256 net = zeroForOne
            ? FullMath.mulDiv(FullMath.mulDiv(liquidity, FixedPoint96.Q96, s1), s0 - s1, s0) // L * (s0 - s1) * Q96 / (s0 * s1)
            : FullMath.mulDiv(liquidity, s1 - s0, FixedPoint96.Q96); // L * (s1 - s0) / Q96
        uint256 gross = FullMath.mulDiv(net, PIPS, PIPS - key.fee);
        amountIn = gross < available ? gross : available;
        if (amountIn == 0) return (0, 0, 0);
        uint256 netIn = FullMath.mulDiv(amountIn, PIPS - key.fee, PIPS);
        minOut = zeroForOne
            ? FullMath.mulDiv(FullMath.mulDiv(netIn, s1, FixedPoint96.Q96), s1, FixedPoint96.Q96) // at price s1^2 / Q96^2
            : FullMath.mulDiv(FullMath.mulDiv(netIn, FixedPoint96.Q96, s1), FixedPoint96.Q96, s1); // at price Q96^2 / s1^2
    }
}
