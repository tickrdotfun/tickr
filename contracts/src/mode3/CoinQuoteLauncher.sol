// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IFactory} from "../interfaces/IFactory.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAnchorRegistry} from "../interfaces/IAnchorRegistry.sol";
import {PriceMath} from "../libraries/PriceMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TokenParams, PairEconomics, LaunchedToken} from "../Types.sol";
import {ILaunchSeeder} from "../interfaces/ILaunchSeeder.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @notice Mode 3: launch a coin priced in another coin this factory already launched.
///
/// Buying the new coin requires holding the quote coin, so every buy is demand for it, and the NEW/QUOTE pool the
/// launch opens is locked forever. That deepens the quote coin's market permanently and cannot be withdrawn.
///
/// Four guardrails, in the order they are checked:
///  1. The quote must be a coin this factory launched. Third-party tokens can charge fees on transfer, rebase, or
///     blocklist, all of which silently corrupt the curve's accounting, which assumes it receives exactly what was sent.
///  2. Depth one only. The quote coin must itself be priced against an approved anchor (ETH, USDG, a Stock Token),
///     so a launch can never sit on top of a tower of other launches.
///  3. The quote must have liquidity, so it has a readable price and an exit.
///  4. The opening market cap is sized from the quote coin's live pool at creation, and pinned through
///     `expectedEconomics` so it cannot move between the quote a creator reads and the transaction they send.
///
/// This contract holds nothing and has no privileges beyond being a registrar on the factory.
contract CoinQuoteLauncher is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The creator's own buy in the launch transaction, in the coin the new coin is priced in.
    event FirstBuy(address indexed token, uint256 quoteIn, uint256 tokensOut);
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant Q96 = 1 << 96;
    /// @dev Phantom reserve as a share of the threshold, matching the other launch modes.
    uint16 public constant PHANTOM_RATIO_BPS = 4_000;

    IFactory public immutable factory;
    IPoolManager public immutable poolManager;
    IAnchorRegistry public immutable anchorRegistry;
    ILaunchSeeder public immutable seeder;

    /// @notice How much of a base asset a launch quoted in a coin should raise, in that base asset's own units.
    mapping(address => uint256) public targetRaise;

    event CoinQuoteLaunched(
        address indexed token,
        bytes32 indexed poolId,
        address indexed quoteCoin,
        address baseAsset,
        uint256 quotePriceX18,
        uint256 phantomQuote
    );
    event TargetRaiseUpdated(address indexed baseAsset, uint256 amount);

    error QuoteNotLaunchedHere();
    error QuoteTooDeep();
    error QuoteNotGraduated();
    error NoTargetRaise();
    error QuotePriceUnavailable();
    error BadValue();

    constructor(address owner_, IFactory factory_, IPoolManager pm, IAnchorRegistry registry_, ILaunchSeeder seeder_) Ownable(owner_) {
        factory = factory_;
        poolManager = pm;
        anchorRegistry = registry_;
        seeder = seeder_;
    }

    function setTargetRaise(address baseAsset, uint256 amount) external onlyOwner {
        targetRaise[baseAsset] = amount;
        emit TargetRaiseUpdated(baseAsset, amount);
    }

    // ---------------------------------------------------------------- views

    /// @notice The base asset a coin is ultimately priced against, and its live price in that asset
    /// (base-asset units per 1e18 of the coin). Reverts unless all three eligibility guardrails hold.
    function quotePrice(address quoteCoin) public view returns (address baseAsset, uint256 priceX18) {
        LaunchedToken memory l = factory.getLaunchedToken(quoteCoin);
        if (!l.exists) revert QuoteNotLaunchedHere();
        baseAsset = l.pairToken;
        // Depth one: the quote coin must be priced against a real anchor, never against another launch.
        if (!anchorRegistry.isApproved(baseAsset)) revert QuoteTooDeep();

        PoolKey memory key = factory.poolKeyOf(quoteCoin);
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        if (sqrtP == 0) revert QuotePriceUnavailable();
        // priceX18 from slot0 is currency1 per currency0 in raw units; invert when the coin is currency1.
        uint256 p = PriceMath.priceX18(sqrtP);
        if (p == 0) revert QuotePriceUnavailable();
        bool coinIsCurrency0 = Currency.unwrap(key.currency0) == quoteCoin;
        priceX18 = coinIsCurrency0 ? p : (1e36 / p);
        if (priceX18 == 0) revert QuotePriceUnavailable();
    }

    /// @notice Economics for a launch priced in `quoteCoin`, denominated in that coin (18 decimals).
    ///
    /// The opening market cap is defined by cost, not by spot: the amount of the quote coin that the base asset's
    /// target buys out of the coin's pool right now, at constant product, times the phantom ratio. Spot would say
    /// `target / price`, and for a pool whose base-asset reserve is near the target that is the whole reserve
    /// or more, which no buyer can pull. Reserves follow from the pool's liquidity and price at the current tick.
    function quoteEconomics(address quoteCoin) public view returns (PairEconomics memory e) {
        (address base,) = quotePrice(quoteCoin);
        uint256 target = targetRaise[base];
        if (target == 0) revert NoTargetRaise();

        PoolKey memory key = factory.poolKeyOf(quoteCoin);
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        uint128 liquidity = poolManager.getLiquidity(key.toId());
        if (liquidity == 0) revert QuotePriceUnavailable();
        bool coinIs0 = Currency.unwrap(key.currency0) == quoteCoin;
        uint256 rCoin = coinIs0 ? FullMath.mulDiv(liquidity, Q96, sqrtP) : FullMath.mulDiv(liquidity, sqrtP, Q96);
        uint256 rBase = coinIs0 ? FullMath.mulDiv(liquidity, sqrtP, Q96) : FullMath.mulDiv(liquidity, Q96, sqrtP);

        uint256 threshold = FullMath.mulDiv(rCoin, target, rBase + target);
        if (threshold == 0) revert QuotePriceUnavailable();
        e = PairEconomics({phantomQuote: (threshold * PHANTOM_RATIO_BPS) / BPS, decimals: 18});
    }

    /// @notice Read immediately before launching and pass the hash as `params.expectedEconomics`.
    function previewLaunch(uint256 launchConfigId, address quoteCoin)
        external
        view
        returns (bytes32 expectedEconomics, PairEconomics memory econ, address baseAsset, uint256 priceX18)
    {
        econ = quoteEconomics(quoteCoin);
        (baseAsset, priceX18) = quotePrice(quoteCoin);
        expectedEconomics = factory.previewLaunchEconomicsWithPair(launchConfigId, quoteCoin, econ);
    }

    /// @notice True when a coin can currently be used as a quote. Never reverts, so a UI can filter with it.
    function isEligibleQuote(address quoteCoin) external view returns (bool) {
        try this.quoteEconomics(quoteCoin) returns (PairEconomics memory) {
            return true;
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------------- launch

    function launchWithCoinQuote(TokenParams calldata params, uint256 launchConfigId, address quoteCoin)
        external
        payable
        nonReentrant
        returns (address token, bytes32 poolId)
    {
        return _launch(params, launchConfigId, quoteCoin);
    }

    /// @notice `launchWithCoinQuote`, then the creator's first buy in the same transaction: `coinIn` of the quote
    /// coin is pulled from the caller and spent in the new pool, coins to the caller. `minTokensOut` bounds the rate.
    function launchWithCoinQuoteAndBuy(
        TokenParams calldata params,
        uint256 launchConfigId,
        address quoteCoin,
        uint256 coinIn,
        uint256 minTokensOut
    ) external payable nonReentrant returns (address token, bytes32 poolId, uint256 tokensOut) {
        (token, poolId) = _launch(params, launchConfigId, quoteCoin);
        if (coinIn == 0) return (token, poolId, 0);
        uint256 before = IERC20(quoteCoin).balanceOf(address(this));
        IERC20(quoteCoin).safeTransferFrom(msg.sender, address(this), coinIn);
        IERC20(quoteCoin).forceApprove(address(seeder), coinIn);
        PoolKey memory key = factory.poolKeyOf(token);
        tokensOut = seeder.swapExactIn(key, Currency.unwrap(key.currency0) == quoteCoin, coinIn, minTokensOut, msg.sender);
        _returnLeftover(quoteCoin, before);
        emit FirstBuy(token, coinIn, tokensOut);
    }

    function _launch(TokenParams calldata params, uint256 launchConfigId, address quoteCoin)
        internal
        returns (address token, bytes32 poolId)
    {
        uint256 fee = factory.launchFee();
        if (msg.value != fee) revert BadValue();
        PairEconomics memory econ = quoteEconomics(quoteCoin);
        (address baseAsset, uint256 priceX18) = quotePrice(quoteCoin);
        (token, poolId) = factory.launchTokenWithPair{value: fee}(msg.sender, params, launchConfigId, quoteCoin, econ);
        emit CoinQuoteLaunched(token, poolId, quoteCoin, baseAsset, priceX18, econ.phantomQuote);
    }

    /// @dev What the pool did not take came back here from the seeder; it goes on to the buyer. Measured against
    /// the balance before the buyer's funds came in, so nothing this contract held before can leave with them.
    function _returnLeftover(address asset, uint256 before) internal {
        uint256 now_ = IERC20(asset).balanceOf(address(this));
        if (now_ > before) IERC20(asset).safeTransfer(msg.sender, now_ - before);
    }
}
