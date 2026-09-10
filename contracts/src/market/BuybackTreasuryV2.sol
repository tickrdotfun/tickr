// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IQuoteKind} from "./IQuoteKind.sol";
import {FeeSettings} from "./FeeSettings.sol";
import {QuoteConverter, ISeederLike} from "./QuoteConverter.sol";
import {MarketTickerDeployer} from "./MarketTickerDeployer.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/src/libraries/FixedPoint96.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LaunchedToken} from "../Types.sol";
import {IFactory} from "../interfaces/IFactory.sol";
import {IFeeEscrow} from "../interfaces/IFeeEscrow.sol";
import {ITickerToken} from "../interfaces/ITickerToken.sol";
import {PriceMath} from "../libraries/PriceMath.sol";
import {TickerLauncher} from "../TickerLauncher.sol";
import {LaunchSeeder} from "../LaunchSeeder.sol";

/// @title BuybackTreasuryV2
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
contract BuybackTreasuryV2 is ReentrancyGuard {
    using QuoteConverter for IQuoteKind;

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

    // ---------------------------------------------------------------- version awareness

    /// @notice What kind of quote asset an address is. Read, never guessed.
    IQuoteKind public immutable quoteRegistry;
    /// @notice The deployer whose markets a fixed-inventory name trades in.
    MarketTickerDeployer public immutable marketIssuer;

    /// @notice The floor a conversion of `token` must beat, as output per unit of input, Q96. Set by the owner,
    /// and a caller may only be stricter. Without one, a fixed-inventory conversion of that token is refused.
    ///
    /// This is the difference between a rate the treasury has agreed to and a rate whoever called happened to
    /// pass in. `collect` and `buy` are open to anyone, on purpose, so a caller-supplied floor alone is not price
    /// protection: it is the caller's own preference, and a caller can prefer a terrible price.
    /// @dev Selling the name for counter. Counter out per name in, Q96.
    mapping(address => uint256) public minRateToCounterX96;
    /// @dev Buying the name with counter. Name out per counter in, Q96. A different unit from the above, and
    /// deliberately a separate setting: one floor cannot govern both directions of a trade.
    mapping(address => uint256) public minRateFromCounterX96;

    /// @notice Name held because a buy could not sell its leftover back. This came out of the earmark, so its
    /// eventual proceeds belong wholly to the earmark and must never be split with the team as fresh revenue.
    mapping(address => uint256) public buybackHeld;
    /// @notice How far ahead a caller's deadline may sit. Keeps a stale authorisation from being reused later.
    uint256 public maxTermsAhead = 15 minutes;

    /// @notice The floor applied to a market name the owner has not set one for, so a name onboards itself
    /// without an owner transaction. Set from the frozen policy at construction.
    ///
    /// A per-token floor still wins wherever one is set, and a token floor may only be higher than this or the
    /// conversion is refused, so this can raise protection for an unknown name but never lower it for a known
    /// one. Without it a new name reverts NoPolicy on every collect and its revenue simply accumulates: safe,
    /// but it means the agreed allocation never happens until someone remembers a transaction per launch.
    uint256 public defaultMinRateToCounterX96;
    uint256 public defaultMinRateFromCounterX96;

    event MinRateSet(address indexed token, bool toCounter, uint256 rateX96);
    event BuybackHeld(address indexed token, uint256 amount);
    event BuybackReturned(address indexed token, uint256 counterIn);
    event AwaitingRegistration(address indexed token, uint256 held);
    event MaxTermsAheadSet(uint256 seconds_);

    event NotConverted(address indexed token, uint256 held, bytes reason);

    error NotOwner();
    error NoPolicy(address token);
    error TermsWeakerThanPolicy(address token, uint256 offered, uint256 required);
    error DeadlineTooFar(uint256 deadline, uint256 latest);

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

    constructor(
        IFactory factory_,
        IFeeEscrow escrow_,
        LaunchSeeder seeder_,
        IERC20 usdg_,
        address teamWallet_,
        IQuoteKind quoteRegistry_,
        MarketTickerDeployer marketIssuer_
    ) {
        require(address(quoteRegistry_) != address(0) && address(marketIssuer_) != address(0), "BuybackTreasuryV2: registry");
        quoteRegistry = quoteRegistry_;
        marketIssuer = marketIssuer_;
        require(teamWallet_ != address(0), "BuybackTreasury: team wallet");
        factory = factory_;
        escrow = escrow_;
        seeder = seeder_;
        usdg = usdg_;
        teamWallet = teamWallet_;
        buybackShareBps = 5_000;
        defaultMinRateToCounterX96 = FeeSettings.MIN_RATE_NAME_TO_COUNTER_X96;
        defaultMinRateFromCounterX96 = FeeSettings.MIN_RATE_COUNTER_TO_NAME_X96;
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

    /// @notice The floor a conversion of `token` must beat. Only the factory owner sets it.
    /// @param toCounter true for selling the name into counter, false for buying it with counter.
    function setMinRate(address token, bool toCounter, uint256 rateX96) external {
        if (msg.sender != factory.owner()) revert NotOwner();
        if (toCounter) minRateToCounterX96[token] = rateX96;
        else minRateFromCounterX96[token] = rateX96;
        emit MinRateSet(token, toCounter, rateX96);
    }

    /// @notice The floor for names with no floor of their own. Only the factory owner sets it, and it may
    /// never go below the frozen policy: the default is a safety net, not a way to open one up.
    function setDefaultMinRate(bool toCounter, uint256 rateX96) external {
        if (msg.sender != factory.owner()) revert NotOwner();
        uint256 frozen = toCounter ? FeeSettings.MIN_RATE_NAME_TO_COUNTER_X96 : FeeSettings.MIN_RATE_COUNTER_TO_NAME_X96;
        if (rateX96 < frozen) revert TermsWeakerThanPolicy(address(0), rateX96, frozen);
        if (toCounter) defaultMinRateToCounterX96 = rateX96;
        else defaultMinRateFromCounterX96 = rateX96;
        emit MinRateSet(address(0), toCounter, rateX96);
    }

    function setMaxTermsAhead(uint256 seconds_) external {
        if (msg.sender != factory.owner()) revert NotOwner();
        require(seconds_ > 0 && seconds_ <= 1 hours, "BuybackTreasuryV2: window");
        maxTermsAhead = seconds_;
        emit MaxTermsAheadSet(seconds_);
    }

    /// @notice The terms a conversion of `token` would run under, or the reason it would be refused. A view, so
    /// a caller can find out before spending gas and a test can assert the refusal directly.
    function checkTerms(address token, bool toCounter, QuoteConverter.Terms calldata offered)
        external
        view
        returns (QuoteConverter.Terms memory)
    {
        return _terms(token, toCounter, offered);
    }

    /// @dev The terms a conversion of `token` runs under: the caller's, held to the owner's policy. A caller may
    /// demand a better price than the policy and may not accept a worse one, and may not carry a deadline
    /// further ahead than the window allows.
    function _terms(address token, bool toCounter, QuoteConverter.Terms memory offered)
        internal
        view
        returns (QuoteConverter.Terms memory)
    {
        uint256 floor = toCounter ? minRateToCounterX96[token] : minRateFromCounterX96[token];
        // an unset token takes the default rather than being refused outright, which is what lets a name
        // onboard itself. zero here means "not set", so a token can never end up with no floor at all
        if (floor == 0) floor = toCounter ? defaultMinRateToCounterX96 : defaultMinRateFromCounterX96;
        if (floor == 0) revert NoPolicy(token);
        if (offered.minOutPerInX96 < floor) revert TermsWeakerThanPolicy(token, offered.minOutPerInX96, floor);
        uint256 latest = block.timestamp + maxTermsAhead;
        if (offered.deadline > latest) revert DeadlineTooFar(offered.deadline, latest);
        return offered;
    }

    // ---------------------------------------------------------------- views

    /// @notice The official coin and its ticker, read from the chain: FUN, and the first coin launched under it.
    /// Both zero before genesis.
    /// @dev Virtual so a test can point the buy at a coin priced in a fixed-inventory name. Nothing on chain
    /// overrides it; the live answer is the factory's.
    function official() public view virtual returns (address tickr, address fun) {
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
    function collect(address[] calldata tokens, QuoteConverter.Terms[] calldata terms)
        external
        nonReentrant
        returns (uint256 usdgTotal, uint256 toTeam, uint256 earmarked)
    {
        require(terms.length == tokens.length, "BuybackTreasuryV2: terms");
        uint256 buybackOnly;
        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        TickerLauncher tl = _launcher();
        for (uint256 i; i < tokens.length; i++) {
            address t = tokens[i];
            if (escrow.balanceOfToken(address(this), t) > 0) escrow.claimToken(t);
            if (t == address(usdg)) continue;
            uint256 bal = IERC20(t).balanceOf(address(this));
            if (bal == 0) continue;
            uint256 counterBefore = usdg.balanceOf(address(this));
            uint256 heldBefore = buybackHeld[t];
            IQuoteKind.Kind kind = quoteRegistry.kindOf(t);
            if (kind == IQuoteKind.Kind.LEGACY_REDEEMABLE_WRAPPER) {
                // exactly as before: a wrapped dollar unwraps at par, no fee, the whole balance
                ITickerToken(t).redeem(bal, address(this));
            } else if (kind == IQuoteKind.Kind.FIXED_INVENTORY_MARKET) {
                // a market price, so a protected swap under the owner's policy. Only what arrives is revenue,
                // and what the swap could not take stays here for the next collect rather than going to the team
                // as though it were unconvertible.
                try this.convertFixed(t, bal, terms[i]) {
                    // whatever arrived is already in the balance below
                } catch (bytes memory reason) {
                    emit NotConverted(t, bal, reason);
                }
            } else if (address(tl) != address(0) && tl.isTicker(t)) {
                // a wrapper the registry has not been told about yet: still legacy, still exact
                ITickerToken(t).redeem(bal, address(this));
            } else if (quoteRegistry.provenanceOf(t) == IQuoteKind.Kind.FIXED_INVENTORY_MARKET) {
                // a genuine market that has not been recorded yet. The registry is permissionless and decides
                // by provenance, so recording it here proves nothing new and skips nothing: the same issuer
                // check runs either way. Doing it on the spot is what removes the owner transaction per launch.
                try quoteRegistry.record(t) {
                    try this.convertFixed(t, bal, terms[i]) {
                        // whatever arrived is already in the balance below
                    } catch (bytes memory reason) {
                        emit NotConverted(t, bal, reason);
                    }
                } catch (bytes memory reason) {
                    // provenance refused it, so it is not ours to convert. It stays put rather than going to
                    // the team as though it were unconvertible
                    emit AwaitingRegistration(t, bal);
                    emit NotConverted(t, bal, reason);
                }
            } else {
                // a Stock Token, a coin used as a quote, anything else: nothing here converts it, so the team takes it whole
                IERC20(t).safeTransfer(teamWallet, bal);
                emit Forwarded(t, bal);
            }

            // whatever this token produced, the share of it that belongs to the buyback is the share of the
            // balance that the buyback was holding. A partial conversion returns a proportional part, so a
            // leftover sold over several collects still comes back whole and never leaks into the team split.
            if (heldBefore > 0) {
                uint256 arrived = usdg.balanceOf(address(this)) - counterBefore;
                uint256 remaining = IERC20(t).balanceOf(address(this));
                uint256 consumed = bal > remaining ? bal - remaining : 0;
                if (consumed > 0 && arrived > 0) {
                    uint256 fromHeld = consumed < heldBefore ? consumed : heldBefore;
                    uint256 back = FullMath.mulDiv(arrived, fromHeld, consumed);
                    buybackHeld[t] = heldBefore - fromHeld;
                    buybackOnly += back;
                    emit BuybackReturned(t, back);
                }
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
        // the part that came back from a buyback's own leftover is not new revenue and is not split
        uint256 shareable = usdgTotal > buybackOnly ? usdgTotal - buybackOnly : 0;
        toTeam = (shareable * (BPS - buybackShareBps)) / BPS;
        earmarked = usdgTotal - toTeam;
        if (toTeam > 0) usdg.safeTransfer(teamWallet, toTeam);
        earmarkedUsdg += earmarked;
        emit Collected(usdgTotal, toTeam, earmarked);
    }

    /// @dev The name leg on its own: dollars into the name at the name market's own rate.
    ///
    /// Its own function, and overridable, because everything after it depends on the one thing it decides: how
    /// much name a given number of dollars turns into. A market cannot sell a name below a dollar today, so it
    /// always returns less name than the dollars paid, and the bound that follows never has to cap. A test that
    /// wants to see the cap bind replaces this, which is the only way to reach that case without a market that
    /// does not exist yet.
    function _toName(address fun, uint256 usdgIn, QuoteConverter.Terms calldata offered)
        internal
        virtual
        returns (uint256 got, uint256 usedCounter)
    {
        return QuoteConverter.fromCounter(
            quoteRegistry, marketIssuer, ISeederLike(address(seeder)), address(usdg), fun, usdgIn, MAX_IMPACT_BPS, _terms(fun, false, offered)
        );
    }

    /// @dev External so `collect` can catch a refusal and carry on with the other assets, without a failure on
    /// one losing or misclassifying another.
    function convertFixed(address token, uint256 amount, QuoteConverter.Terms calldata offered)
        external
        virtual
        returns (uint256 out, uint256 used)
    {
        require(msg.sender == address(this), "BuybackTreasuryV2: internal");
        return QuoteConverter.toCounter(
            quoteRegistry, marketIssuer, ISeederLike(address(seeder)), address(usdg), token, amount, MAX_IMPACT_BPS, _terms(token, true, offered)
        );
    }

    // ---------------------------------------------------------------- buy

    /// @notice Spend one tranche of the earmarked dollars on TICKR and burn it. Anyone may call, once per interval.
    function buy(QuoteConverter.Terms calldata offered) external nonReentrant returns (uint256 usdgIn, uint256 tickrOut) {
        if (lastBuyAt != 0 && block.timestamp < lastBuyAt + MIN_INTERVAL) revert TooSoon();
        if (earmarkedUsdg == 0) revert NothingEarmarked();
        _launcher();
        (address tickr, address fun) = official();
        if (tickr == address(0)) revert NotYetLaunched();
        (PoolKey memory key, bool funIs0, uint256 minOut, uint256 sized, LaunchedToken memory l, uint160 limit) =
            _sizeBuy(tickr);
        usdgIn = sized;
        if (usdgIn == 0) revert NothingToBuy();
        // FUN that club sweeps paid straight to the treasury is revenue waiting for `collect`, not part of this buy
        uint256 funBefore = IERC20(fun).balanceOf(address(this));
        // dollars become the name. A legacy wrapper mints one for one, as it always has. A fixed-inventory name
        // is bought in its own market, so what arrives is not what was sent and the amount actually received is
        // what goes on into the coin's pool.
        uint256 nameIn;
        // what actually goes to the coin's pool. It is the name in hand, unless the bound decided on less: the
        // amount sent and the minimum sent have to be the pair the bound produced, and what is not sent stays
        // here and is recovered below with the rest of the leftover.
        uint256 swapIn;
        bool nameIsMarket = quoteRegistry.kindOf(fun) == IQuoteKind.Kind.FIXED_INVENTORY_MARKET;
        if (nameIsMarket) {
            (uint256 got, uint256 usedCounter) = _toName(fun, usdgIn, offered);
            // only what the market actually took leaves the earmark, and only what arrived is swapped onward
            usdgIn = usedCounter;
            nameIn = got;
            // the tranche was sized against the coin's pool in dollars, which is the right amount only while a
            // name is a dollar. A market sets its own rate, so the bound is taken again for the name in hand: a
            // minimum belonging to a different amount would refuse a good swap or wave a bad one through.
            (swapIn, minOut, limit) = _boundFor(key, funIs0, l, nameIn);
            if (swapIn == 0) revert NothingToBuy();
        } else {
            usdg.forceApprove(fun, usdgIn);
            ITickerToken(fun).mint(usdgIn, address(this));
            nameIn = usdgIn;
            swapIn = usdgIn; // a wrapper mints one for one, so the tranche's own bound still fits it exactly
        }
        IERC20(fun).forceApprove(address(seeder), swapIn);
        // the pool stops at the bound whatever its liquidity turns out to be; FUN it did not take comes back below
        tickrOut = seeder.swapExactInBounded(key, funIs0, swapIn, minOut, DEAD, limit);
        earmarkedUsdg -= usdgIn;
        // the name the coin's pool did not take goes back to dollars and stays earmarked. A wrapper redeems it
        // exactly; a market sells it back, so what returns is again not what went out, and only that is credited.
        uint256 left = IERC20(fun).balanceOf(address(this)) - funBefore;
        if (left > 0) {
            if (nameIsMarket) {
                try this.convertFixed(fun, left, offered) returns (uint256 back, uint256 usedName) {
                    earmarkedUsdg += back;
                    usdgIn -= back < usdgIn ? back : usdgIn;
                    // a market takes what it can and no more. Whatever it would not take is in the same position
                    // as a leftover that could not be sold at all: it came out of the earmark, so it is recorded
                    // as the buyback's rather than waiting here to be split as though it were new revenue.
                    uint256 stuck = left > usedName ? left - usedName : 0;
                    if (stuck > 0) {
                        buybackHeld[fun] += stuck;
                        emit BuybackHeld(fun, stuck);
                    }
                } catch (bytes memory reason) {
                    // unconvertible for now: it stays as the name, and it stays the buyback's. This came out of
                    // the earmark, so when it is eventually sold its proceeds go back to the earmark whole,
                    // rather than being split with the team as though they were new revenue.
                    buybackHeld[fun] += left;
                    emit NotConverted(fun, left, reason);
                    emit BuybackHeld(fun, left);
                }
            } else {
                ITickerToken(fun).redeem(left, address(this));
                earmarkedUsdg += left;
                usdgIn -= left;
            }
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

    /// @dev The bound `_sizeBuy` applies, taken again for an amount already in hand rather than for a tranche
    /// still to be sized. Same impact ceiling, same price limit, same fallback to the launch position's own edge.
    ///
    /// It returns the amount as well as the minimum, and the two must be sent to the seeder together. The
    /// seeder holds a bounded swap to a price, not a quantity: it divides the minimum by the amount it was
    /// handed. Handing it more than the amount the minimum was computed for divides the floor down by that
    /// much, and the swap then answers to a weaker rate than the one this bound decided on.
    function _boundFor(PoolKey memory key, bool funIs0, LaunchedToken memory l, uint256 amountIn)
        internal
        view
        returns (uint256 fits, uint256 minOut, uint160 limit)
    {
        uint160 edge = funIs0 ? TickMath.getSqrtPriceAtTick(l.tickUpper) : TickMath.getSqrtPriceAtTick(l.tickLower);
        (fits, minOut, limit) = _bounded(key, funIs0, amountIn, l.liquidity, edge);
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
