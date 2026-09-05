// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BitMath} from "v4-core/src/libraries/BitMath.sol";
import {IFactory} from "../interfaces/IFactory.sol";
import {IAnchorRegistry} from "../interfaces/IAnchorRegistry.sol";
import {ILaunchSeeder} from "../interfaces/ILaunchSeeder.sol";
import {IUniswapV3PoolMinimal, IUniswapV3Factory} from "../interfaces/IUniswapV3PoolMinimal.sol";
import {PriceMath} from "../libraries/PriceMath.sol";
import {TokenParams, PairEconomics} from "../Types.sol";

/// @notice Mode 5: launch a coin priced in any token on the chain that has a deep enough market.
///
/// A market is a Uniswap v3 pool of the token against WETH or USDG, from the canonical v3 factory, that passes
/// two floors on its counter asset: it holds at least `minDepth` of it, and at least `minDepth` of it sits within
/// `BAND_BPS` of the current price, measured by walking the pool's own ticks. The first floor is capital in the
/// pool; the second is what it would actually cost to move the price, so a pool with capital parked far out of
/// range and dust at the price does not count. The deepest WETH market wins; USDG markets are used only when no
/// WETH market clears both floors. The opening market cap is the ETH or USDG target converted into the token at
/// that pool's spot price when the launch is sent, and pinned through `expectedEconomics`.
///
/// What this mode does not do: it does not price anchors (ETH, USDG, Stock Tokens) or coins this factory
/// launched, because each has its own mode with a better price source. It holds nothing between transactions
/// and has no privilege beyond being a registrar on the factory.
contract MarketQuoteLauncher is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant Q96 = 1 << 96;
    /// @dev Phantom reserve as a share of the threshold, matching the other launch modes.
    uint16 public constant PHANTOM_RATIO_BPS = 4_000;
    /// @notice The price band the in-range floor is measured over: five percent from the current price.
    uint256 public constant BAND_BPS = 500;
    /// @dev A hard stop on the tick walk; a real pool reaches the band edge long before this.
    uint256 internal constant MAX_SEGMENTS = 256;
    /// @notice The fewest decimals a quote may have; below this the opening price cannot be represented well.
    uint8 public constant MIN_QUOTE_DECIMALS = 6;

    IFactory public immutable factory;
    IAnchorRegistry public immutable anchorRegistry;
    IUniswapV3Factory public immutable v3Factory;
    address public immutable weth;
    address public immutable usdg;
    ILaunchSeeder public immutable seeder;

    /// @notice The least a pool must hold of its counter asset (WETH or USDG, raw units), in total and within the band.
    mapping(address => uint256) public minDepth;
    /// @notice How much of a base asset a launch should raise, in that asset's own units. `address(0)` is ETH.
    mapping(address => uint256) public targetRaise;

    struct Market {
        address pool;
        address counter; // WETH or USDG
        uint24 fee;
        uint256 depth; // the pool's balance of the counter asset
        uint256 inBand; // the counter asset the pool absorbs within BAND_BPS of the price
    }

    event MarketQuoteLaunched(
        address indexed token,
        bytes32 indexed poolId,
        address indexed quote,
        address pool,
        address counter,
        uint256 basePerQuoteX18,
        uint256 phantomQuote
    );
    /// @notice The creator's own buy in the launch transaction, in the token the new coin is priced in.
    event FirstBuy(address indexed token, uint256 quoteIn, uint256 tokensOut);
    event MinDepthUpdated(address indexed counter, uint256 amount);
    event TargetRaiseUpdated(address indexed baseAsset, uint256 amount);

    error QuoteIsAnchor();
    error QuoteLaunchedHere();
    error QuoteDecimals();
    error NoMarket();
    error QuotePriceUnavailable();
    error NoTargetRaise();
    error BadValue();

    constructor(
        address owner_,
        IFactory factory_,
        IAnchorRegistry registry_,
        IUniswapV3Factory v3Factory_,
        address weth_,
        address usdg_,
        ILaunchSeeder seeder_,
        uint256 minDepthWeth,
        uint256 minDepthUsdg
    ) Ownable(owner_) {
        factory = factory_;
        anchorRegistry = registry_;
        v3Factory = v3Factory_;
        weth = weth_;
        usdg = usdg_;
        seeder = seeder_;
        minDepth[weth_] = minDepthWeth;
        minDepth[usdg_] = minDepthUsdg;
    }

    function setMinDepth(address counter, uint256 amount) external onlyOwner {
        minDepth[counter] = amount;
        emit MinDepthUpdated(counter, amount);
    }

    function setTargetRaise(address baseAsset, uint256 amount) external onlyOwner {
        targetRaise[baseAsset] = amount;
        emit TargetRaiseUpdated(baseAsset, amount);
    }

    // ---------------------------------------------------------------- views

    /// @notice The pool a quote is priced from: its deepest v3 market against WETH that clears both floors, else
    /// its deepest against USDG. Reverts when the token is an anchor, a coin launched here, has too few decimals,
    /// or has no such market.
    function bestMarket(address quote) public view returns (Market memory m) {
        if (quote == weth || quote == usdg || anchorRegistry.isApproved(quote)) revert QuoteIsAnchor();
        if (factory.getLaunchedToken(quote).exists) revert QuoteLaunchedHere();
        if (IERC20Metadata(quote).decimals() < MIN_QUOTE_DECIMALS) revert QuoteDecimals();
        m = _deepest(quote, weth);
        if (m.pool == address(0)) m = _deepest(quote, usdg);
        if (m.pool == address(0)) revert NoMarket();
    }

    function _deepest(address quote, address counter) internal view returns (Market memory best) {
        uint24[4] memory fees = [uint24(100), 500, 3_000, 10_000];
        uint256 floor = minDepth[counter];
        for (uint256 i; i < 4; i++) {
            address pool = v3Factory.getPool(quote, counter, fees[i]);
            if (pool == address(0)) continue;
            uint256 depth = IERC20(counter).balanceOf(pool);
            if (depth < floor) continue;
            uint256 inBand = _inBand(pool, counter < quote);
            if (inBand < floor || inBand <= best.inBand) continue;
            best = Market({pool: pool, counter: counter, fee: fees[i], depth: depth, inBand: inBand});
        }
    }

    /// @dev How much of the counter asset the pool would pay out before the price has moved `BAND_BPS`, walking
    /// the pool's initialized ticks. That is the exit side: the capital a seller of the quote can actually take,
    /// which nobody can fake with free liquidity of the quote itself. Selling token1 in pushes the price up and
    /// pays token0; selling token0 in pushes it down and pays token1.
    function _inBand(address pool, bool counterIs0) internal view returns (uint256 amount) {
        IUniswapV3PoolMinimal p = IUniswapV3PoolMinimal(pool);
        uint128 liquidity = p.liquidity();
        (uint160 sqrtP, int24 tick,,,,,) = p.slot0();
        if (sqrtP == 0) return 0;
        int24 spacing = p.tickSpacing();
        bool up = counterIs0;
        uint160 limit = up ? PriceMath.scaleSqrtPrice(sqrtP, BPS + BAND_BPS, BPS) : PriceMath.scaleSqrtPrice(sqrtP, BPS - BAND_BPS, BPS);
        if (limit < TickMath.MIN_SQRT_PRICE) limit = TickMath.MIN_SQRT_PRICE;
        if (limit > TickMath.MAX_SQRT_PRICE) limit = TickMath.MAX_SQRT_PRICE;
        uint160 cur = sqrtP;
        for (uint256 i; i < MAX_SEGMENTS; i++) {
            (int24 next, bool initialized) = _nextTick(p, tick, spacing, !up);
            uint160 nextSqrt = TickMath.getSqrtPriceAtTick(next);
            bool pastLimit = up ? nextSqrt >= limit : nextSqrt <= limit;
            uint160 to = pastLimit ? limit : nextSqrt;
            if (liquidity > 0) {
                amount += up
                    ? SqrtPriceMath.getAmount0Delta(cur, to, liquidity, false)
                    : SqrtPriceMath.getAmount1Delta(to, cur, liquidity, false);
            }
            if (pastLimit) break;
            if (initialized) {
                (, int128 net,,,,,,) = p.ticks(next);
                // crossing up adds the tick's net liquidity, crossing down removes it
                liquidity = up ? _add(liquidity, net) : _sub(liquidity, net);
            }
            cur = nextSqrt;
            tick = up ? next : next - 1;
        }
    }

    /// @dev Uniswap v3's next initialized tick within one bitmap word, in the walk's direction.
    function _nextTick(IUniswapV3PoolMinimal p, int24 tick, int24 spacing, bool lte) internal view returns (int24 next, bool initialized) {
        int24 compressed = tick / spacing;
        if (tick < 0 && tick % spacing != 0) compressed--;
        if (lte) {
            int16 wordPos = int16(compressed >> 8);
            uint8 bitPos = uint8(int8(compressed % 256));
            uint256 mask = (1 << bitPos) - 1 + (1 << bitPos);
            uint256 masked = p.tickBitmap(wordPos) & mask;
            initialized = masked != 0;
            next = initialized
                ? (compressed - int24(uint24(bitPos - BitMath.mostSignificantBit(masked)))) * spacing
                : (compressed - int24(uint24(bitPos))) * spacing;
        } else {
            int24 c = compressed + 1;
            int16 wordPos = int16(c >> 8);
            uint8 bitPos = uint8(int8(c % 256));
            uint256 mask = ~((1 << bitPos) - 1);
            uint256 masked = p.tickBitmap(wordPos) & mask;
            initialized = masked != 0;
            next = initialized
                ? (c + int24(uint24(BitMath.leastSignificantBit(masked) - bitPos))) * spacing
                : (c + int24(uint24(type(uint8).max - bitPos))) * spacing;
        }
        if (next < TickMath.MIN_TICK) next = TickMath.MIN_TICK;
        if (next > TickMath.MAX_TICK) next = TickMath.MAX_TICK;
    }

    function _add(uint128 l, int128 net) internal pure returns (uint128) {
        return net < 0 ? l - uint128(-net) : l + uint128(net);
    }

    function _sub(uint128 l, int128 net) internal pure returns (uint128) {
        return net < 0 ? l + uint128(-net) : l - uint128(net);
    }

    /// @notice The market, the base asset it prices in (`address(0)` for ETH, else USDG), and the spot price as
    /// base raw units per 1e18 raw units of the quote. The price figure is informational; the economics use the
    /// pool's sqrt price directly at full precision.
    function quotePrice(address quote) public view returns (Market memory m, address base, uint256 basePerQuoteX18) {
        m = bestMarket(quote);
        base = m.counter == weth ? address(0) : usdg;
        (uint160 sqrtP,,,,,,) = IUniswapV3PoolMinimal(m.pool).slot0();
        if (sqrtP == 0) revert QuotePriceUnavailable();
        // slot0 is token1 per token0 in raw units; invert when the quote is token1
        uint256 p = PriceMath.priceX18(sqrtP);
        bool quoteIs0 = quote < m.counter;
        basePerQuoteX18 = quoteIs0 ? p : (p == 0 ? 0 : FullMath.mulDiv(1e18, 1e18, p));
    }

    /// @notice Economics for a launch priced in `quote`: the base target converted into the quote at spot, times
    /// the phantom ratio, in the quote's own decimals. Full precision from the pool's sqrt price.
    function quoteEconomics(address quote) public view returns (PairEconomics memory e) {
        (Market memory m, address base,) = quotePrice(quote);
        uint256 target = targetRaise[base];
        if (target == 0) revert NoTargetRaise();
        (uint160 sqrtP,,,,,,) = IUniswapV3PoolMinimal(m.pool).slot0();
        // quote raw units per `target` raw units of the counter, straight from sqrtP
        uint256 threshold = quote < m.counter
            ? FullMath.mulDiv(FullMath.mulDiv(target, Q96, sqrtP), Q96, sqrtP) // quote is token0: 1/price
            : FullMath.mulDiv(FullMath.mulDiv(target, sqrtP, Q96), sqrtP, Q96); // quote is token1: price
        if (threshold == 0) revert QuotePriceUnavailable();
        e = PairEconomics({phantomQuote: (threshold * PHANTOM_RATIO_BPS) / BPS, decimals: IERC20Metadata(quote).decimals()});
    }

    /// @notice Read immediately before launching and pass the hash as `params.expectedEconomics`.
    function previewLaunch(uint256 launchConfigId, address quote)
        external
        view
        returns (bytes32 expectedEconomics, PairEconomics memory econ, Market memory market, address baseAsset, uint256 basePerQuoteX18)
    {
        econ = quoteEconomics(quote);
        (market, baseAsset, basePerQuoteX18) = quotePrice(quote);
        expectedEconomics = factory.previewLaunchEconomicsWithPair(launchConfigId, quote, econ);
    }

    /// @notice True when a token can currently be used as a quote. Never reverts, so a list can be filtered with it.
    function isEligibleQuote(address quote) external view returns (bool) {
        try this.quoteEconomics(quote) returns (PairEconomics memory) {
            return true;
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------------- launch

    function launchWithMarketQuote(TokenParams calldata params, uint256 launchConfigId, address quote)
        external
        payable
        nonReentrant
        returns (address token, bytes32 poolId)
    {
        return _launch(params, launchConfigId, quote);
    }

    /// @notice `launchWithMarketQuote`, then the creator's first buy in the same transaction: `quoteIn` of the
    /// quote token is pulled from the caller and spent in the new pool, coins to the caller.
    function launchWithMarketQuoteAndBuy(
        TokenParams calldata params,
        uint256 launchConfigId,
        address quote,
        uint256 quoteIn,
        uint256 minTokensOut
    ) external payable nonReentrant returns (address token, bytes32 poolId, uint256 tokensOut) {
        (token, poolId) = _launch(params, launchConfigId, quote);
        if (quoteIn == 0) return (token, poolId, 0);
        uint256 before = IERC20(quote).balanceOf(address(this));
        IERC20(quote).safeTransferFrom(msg.sender, address(this), quoteIn);
        IERC20(quote).forceApprove(address(seeder), quoteIn);
        PoolKey memory key = factory.poolKeyOf(token);
        tokensOut = seeder.swapExactIn(key, Currency.unwrap(key.currency0) == quote, quoteIn, minTokensOut, msg.sender);
        _returnLeftover(quote, before);
        emit FirstBuy(token, quoteIn, tokensOut);
    }

    function _launch(TokenParams calldata params, uint256 launchConfigId, address quote) internal returns (address token, bytes32 poolId) {
        uint256 fee = factory.launchFee();
        if (msg.value != fee) revert BadValue();
        PairEconomics memory econ = quoteEconomics(quote);
        (Market memory m,, uint256 px) = quotePrice(quote);
        (token, poolId) = factory.launchTokenWithPair{value: fee}(msg.sender, params, launchConfigId, quote, econ);
        emit MarketQuoteLaunched(token, poolId, quote, m.pool, m.counter, px, econ.phantomQuote);
    }

    /// @dev What the pool did not take came back here from the seeder; it goes on to the buyer. Measured against
    /// the balance before the buyer's funds came in, so nothing this contract held before can leave with them.
    function _returnLeftover(address asset, uint256 before) internal {
        uint256 now_ = IERC20(asset).balanceOf(address(this));
        if (now_ > before) IERC20(asset).safeTransfer(msg.sender, now_ - before);
    }
}
