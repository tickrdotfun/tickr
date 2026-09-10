// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/src/libraries/FixedPoint96.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IQuoteKind} from "./IQuoteKind.sol";
import {MarketTickerDeployer} from "./MarketTickerDeployer.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PriceMath} from "../libraries/PriceMath.sol";

interface IPositionLiquidity {
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
}

interface ITickerTokenLike {
    function mint(uint256 amount, address to) external;
    function redeem(uint256 amount, address to) external;
}

interface ISeederLike {
    function poolManager() external view returns (IPoolManager);
    function swapExactInBounded(PoolKey memory key, bool zeroForOne, uint256 amountIn, uint256 minOut, address to, uint160 limit)
        external
        payable
        returns (uint256 out);
}

/// @title QuoteConverter
/// @notice Turns a quote asset into the counter asset, and back, by the rules of the generation it belongs to.
///
/// A legacy wrapper converts by `mint` and `redeem`: exact, no fee, no price, no bound. A fixed-inventory name
/// converts by a swap in its own USDG pool: a fee, a price, a bound on how far that price may move, and an
/// **actual received amount** that is not the amount sent. Everything downstream must use what came back.
///
/// Three rules this enforces, which the treasury depends on:
///
/// 1. The asset must be registered before it is converted. An unregistered address reverts; nothing here guesses,
///    and nothing falls back to the legacy path, because doing so on a fixed-inventory name would treat a swapped
///    amount as exact and mis-state real balances.
/// 2. A fixed-inventory swap is bounded by price, not by a spot quote read in the same transaction, which a
///    caller could have moved. The bound is the same discipline `BuybackTreasury` already applies to its ETH and
///    its buys.
/// 3. What could not be converted is returned as a number, never silently dropped or forwarded.
library QuoteConverter {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant PIPS = 1_000_000;

    /// @notice A floor on the exchange rate, decided away from this transaction, and the moment it stops being
    /// good. `minOutPerInX96` is the least output one unit of input must fetch, as a Q96 fixed point number, and
    /// it is checked against what was actually spent, so a partial fill is held to the same rate as a full one.
    struct Terms {
        uint256 minOutPerInX96;
        uint256 deadline;
    }

    error NotRegistered(address token);
    error UnsupportedKind(address token, IQuoteKind.Kind kind);
    error NoMarket(address token);
    error RateTooLow(uint256 gotRateX96, uint256 minRateX96);
    error TermsExpired(uint256 deadline, uint256 nowTs);
    error NoTerms();
    /// @dev A market whose price sits outside its funded range has nothing to trade against here. Converting it
    /// is refused rather than reported as a conversion of nothing, so a caller cannot mistake it for success.
    error MarketNotPrimed(address token);

    /// @notice The counter received for `amount` of `token`, by that token's own rules.
    /// @param maxImpactBps How far the price may move on a swap. Ignored by the legacy path, which has no price.
    /// @return outCounter What actually arrived, which for a swap is not `amount`.
    /// @return usedIn How much of `amount` was actually spent; the rest stays with the caller.
    function toCounter(
        IQuoteKind registry,
        MarketTickerDeployer marketIssuer,
        ISeederLike seeder,
        address counter,
        address token,
        uint256 amount,
        uint256 maxImpactBps,
        Terms memory terms
    ) internal returns (uint256 outCounter, uint256 usedIn) {
        if (amount == 0) return (0, 0);
        IQuoteKind.Kind kind = registry.kindOf(token);
        if (kind == IQuoteKind.Kind.UNKNOWN) revert NotRegistered(token);
        if (kind == IQuoteKind.Kind.COUNTER_ASSET) return (amount, amount);

        if (kind == IQuoteKind.Kind.LEGACY_REDEEMABLE_WRAPPER) {
            // exactly as it has always worked: one for one, no fee, the whole balance
            uint256 before = IERC20(counter).balanceOf(address(this));
            ITickerTokenLike(token).redeem(amount, address(this));
            outCounter = IERC20(counter).balanceOf(address(this)) - before;
            return (outCounter, amount);
        }
        if (kind != IQuoteKind.Kind.FIXED_INVENTORY_MARKET) revert UnsupportedKind(token, kind);

        MarketTickerDeployer.Market memory m = marketIssuer.market(token);
        if (m.token != token) revert NoMarket(token);
        bool nameIs0 = Currency.unwrap(m.key.currency0) == token;
        (outCounter, usedIn) =
            _swapBounded(seeder, m.key, nameIs0, token, counter, amount, maxImpactBps, terms, token, _edgeOf(marketIssuer, m, nameIs0));
    }

    /// @notice `amount` of the counter turned into `token`, by that token's own rules.
    /// @return outToken What actually arrived, which for a swap is not `amount`.
    /// @return usedCounter How much counter was actually spent.
    function fromCounter(
        IQuoteKind registry,
        MarketTickerDeployer marketIssuer,
        ISeederLike seeder,
        address counter,
        address token,
        uint256 amount,
        uint256 maxImpactBps,
        Terms memory terms
    ) internal returns (uint256 outToken, uint256 usedCounter) {
        if (amount == 0) return (0, 0);
        IQuoteKind.Kind kind = registry.kindOf(token);
        if (kind == IQuoteKind.Kind.UNKNOWN) revert NotRegistered(token);
        if (kind == IQuoteKind.Kind.COUNTER_ASSET) return (amount, amount);

        if (kind == IQuoteKind.Kind.LEGACY_REDEEMABLE_WRAPPER) {
            uint256 before = IERC20(token).balanceOf(address(this));
            IERC20(counter).forceApprove(token, amount);
            ITickerTokenLike(token).mint(amount, address(this));
            outToken = IERC20(token).balanceOf(address(this)) - before;
            return (outToken, amount);
        }
        if (kind != IQuoteKind.Kind.FIXED_INVENTORY_MARKET) revert UnsupportedKind(token, kind);

        MarketTickerDeployer.Market memory m = marketIssuer.market(token);
        if (m.token != token) revert NoMarket(token);
        bool counterIs0 = Currency.unwrap(m.key.currency0) == counter;
        (outToken, usedCounter) =
            _swapBounded(seeder, m.key, counterIs0, counter, token, amount, maxImpactBps, terms, token, _edgeOf(marketIssuer, m, counterIs0));
    }

    /// @dev One bounded swap, protected by the price it actually achieved rather than by a size planned in
    /// advance.
    ///
    /// A planned minimum is wrong here. A name's market can be deeply one-sided, so a sale may be truncated by
    /// the price limit and fill only partly; a minimum computed for the whole amount would then revert a trade
    /// that executed at a perfectly good price. What matters is the average price paid, so the swap runs to the
    /// limit, and afterwards the amount that arrived is checked against what the limit price entitles the amount
    /// actually spent to. Anything not spent stays with the caller and is reported as unspent.
    function _swapBounded(
        ISeederLike seeder,
        PoolKey memory key,
        bool zeroForOne,
        address tokenIn,
        address tokenOut,
        uint256 available,
        uint256 maxImpactBps,
        Terms memory terms,
        address market,
        Edge memory edge
    ) private returns (uint256 out, uint256 spent) {
        // terms are not optional. A swap without an independently decided floor is a swap at whatever price the
        // pool happens to hold, which is the thing the caller cannot verify from inside this transaction.
        if (terms.minOutPerInX96 == 0) revert NoTerms();
        if (block.timestamp > terms.deadline) revert TermsExpired(terms.deadline, block.timestamp);

        (uint256 sized,, uint160 limit) = _bounded(seeder.poolManager(), key, zeroForOne, available, maxImpactBps, edge);
        // a market whose price is outside its funded range: nothing is executable here, and saying so is the
        // point. Reporting a conversion of zero would let a caller record it as handled.
        if (sized == 0 || limit == 0) revert MarketNotPrimed(market);

        uint256 hadIn = IERC20(tokenIn).balanceOf(address(this));
        uint256 hadOut = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(address(seeder), sized);
        // no planned minimum: the price limit is the protection, and the achieved price is checked below
        seeder.swapExactInBounded(key, zeroForOne, sized, 0, address(this), limit);
        IERC20(tokenIn).forceApprove(address(seeder), 0);

        out = IERC20(tokenOut).balanceOf(address(this)) - hadOut;
        spent = hadIn - IERC20(tokenIn).balanceOf(address(this));
        // a swap that moved nothing is a refusal, not a conversion of zero. Returning quietly here would let a
        // caller record the asset as handled when it is untouched, which is the failure this whole path exists
        // to avoid.
        if (spent == 0 || out == 0) revert MarketNotPrimed(market);

        // the rate the caller decided in advance, measured against what was actually spent, so a partial fill is
        // held to exactly the standard a full one is. This is the protection: the price limit only constrains
        // movement during the swap and says nothing about whether the starting price was acceptable.
        uint256 rateX96 = FullMath.mulDiv(out, FixedPoint96.Q96, spent);
        if (rateX96 < terms.minOutPerInX96) revert RateTooLow(rateX96, terms.minOutPerInX96);
    }

    /// @dev The edge of a market's own position: the boundary its price starts at, and what is behind it. The
    /// tick a swap would enter from depends on which way it is travelling.
    function _edgeOf(MarketTickerDeployer issuer, MarketTickerDeployer.Market memory m, bool zeroForOne)
        private
        view
        returns (Edge memory)
    {
        if (m.tokenId == 0) return Edge({sqrtPrice: 0, liquidity: 0});
        uint128 l;
        try IPositionLiquidity(address(issuer.posm())).getPositionLiquidity(m.tokenId) returns (uint128 got) {
            l = got;
        } catch {
            return Edge({sqrtPrice: 0, liquidity: 0});
        }
        // going down in price, the range is entered at its upper tick; going up, at its lower
        int24 tick = zeroForOne ? m.tickUpper : m.tickLower;
        return Edge({sqrtPrice: TickMath.getSqrtPriceAtTick(tick), liquidity: l});
    }

    /// @notice Where a market's funded range begins and how much sits in it, for the case where the pool's price
    /// is at the edge of that range rather than inside it.
    struct Edge {
        uint160 sqrtPrice;
        uint128 liquidity;
    }

    /// @dev The same shape of bound `BuybackTreasury` uses: the price may move `maxImpactBps` and no further, and
    /// the size is whatever fits inside that, never more than is available.
    ///
    /// A market that has never traded sits exactly on the boundary of its own position, and a position is not
    /// active at its upper tick, so the pool reports no liquidity at all. A swap that would move the price *into*
    /// the range is perfectly executable there, and refusing it would mean no fresh market could ever be bought
    /// from. When the pool reports nothing, the range's own edge and liquidity are used instead, and only when
    /// the trade is heading into it.
    function _bounded(
        IPoolManager pm,
        PoolKey memory key,
        bool zeroForOne,
        uint256 available,
        uint256 maxImpactBps,
        Edge memory edge
    ) private view returns (uint256 amountIn, uint256 minOut, uint160 limit) {
        (uint160 s0,,,) = pm.getSlot0(key.toId());
        uint128 liquidity = pm.getLiquidity(key.toId());
        if (liquidity == 0 && edge.liquidity != 0 && edge.sqrtPrice != 0) {
            // heading into the range, not away from it
            bool ahead = zeroForOne ? edge.sqrtPrice <= s0 : edge.sqrtPrice >= s0;
            if (ahead) {
                s0 = edge.sqrtPrice;
                liquidity = edge.liquidity;
            }
        }
        if (s0 == 0 || liquidity == 0 || available == 0) return (0, 0, 0);
        uint160 s1 = zeroForOne
            ? PriceMath.scaleSqrtPrice(s0, BPS, BPS + maxImpactBps)
            : PriceMath.scaleSqrtPrice(s0, BPS + maxImpactBps, BPS);
        limit = s1;
        uint256 net = zeroForOne
            ? FullMath.mulDiv(FullMath.mulDiv(liquidity, FixedPoint96.Q96, s1), s0 - s1, s0)
            : FullMath.mulDiv(liquidity, s1 - s0, FixedPoint96.Q96);
        uint256 gross = FullMath.mulDiv(net, PIPS, PIPS - key.fee);
        amountIn = gross < available ? gross : available;
        if (amountIn == 0) return (0, 0, 0);
        uint256 netIn = FullMath.mulDiv(amountIn, PIPS - key.fee, PIPS);
        minOut = zeroForOne
            ? FullMath.mulDiv(FullMath.mulDiv(netIn, s1, FixedPoint96.Q96), s1, FixedPoint96.Q96)
            : FullMath.mulDiv(FullMath.mulDiv(netIn, FixedPoint96.Q96, s1), FixedPoint96.Q96, s1);
    }
}
