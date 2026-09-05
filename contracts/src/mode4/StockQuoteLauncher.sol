// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ILaunchSeeder} from "../interfaces/ILaunchSeeder.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IFactory} from "../interfaces/IFactory.sol";
import {IAnchorRegistry} from "../interfaces/IAnchorRegistry.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {TokenParams, PairEconomics} from "../Types.sol";

/// @notice Launch a coin priced in an official Stock Token, with the opening market cap sized from the asset's
/// live Chainlink feed.
///
/// A fixed number of tokens would mean wildly different raises: ten tokens of a $5 stock and ten of a $500 stock are
/// not comparable. So the owner sets one USD target and every launch converts it through the asset's own feed. A
/// $500 stock needs a tenth of the tokens a $50 stock does, and both raise the same value.
///
/// The feed answer is the price of one token with the corporate-action multiplier already applied, so it is used as
/// published. This contract holds nothing and has no privilege beyond being a registrar on the factory.
contract StockQuoteLauncher is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The creator's own buy in the launch transaction, in the Stock Token the coin is priced in.
    event FirstBuy(address indexed token, uint256 quoteIn, uint256 tokensOut);
    uint256 internal constant BPS = 10_000;
    uint16 public constant PHANTOM_RATIO_BPS = 4_000;

    IFactory public immutable factory;
    IAnchorRegistry public immutable anchorRegistry;
    ILaunchSeeder public immutable seeder;

    /// @notice The USD value the phantom ratio is applied to for the opening market cap, with `TARGET_DECIMALS` decimals.
    uint256 public targetRaiseUsd;
    uint8 public constant TARGET_DECIMALS = 8;
    /// @notice A feed older than this is refused rather than trusted.
    uint256 public maxStaleness;

    event StockQuoteLaunched(
        address indexed token,
        bytes32 indexed poolId,
        address indexed stockToken,
        uint256 priceUsd,
        uint256 phantomQuote
    );
    event TargetRaiseUpdated(uint256 targetRaiseUsd);
    event MaxStalenessUpdated(uint256 maxStaleness);

    error NotOfficialStockToken();
    error NoFeed();
    error StalePrice();
    error BadPrice();
    error NoTargetRaise();
    error BadValue();

    constructor(address owner_, IFactory factory_, IAnchorRegistry registry_, ILaunchSeeder seeder_, uint256 targetRaiseUsd_, uint256 maxStaleness_)
        Ownable(owner_)
    {
        factory = factory_;
        anchorRegistry = registry_;
        seeder = seeder_;
        targetRaiseUsd = targetRaiseUsd_;
        maxStaleness = maxStaleness_;
    }

    function setTargetRaiseUsd(uint256 amount) external onlyOwner {
        targetRaiseUsd = amount;
        emit TargetRaiseUpdated(amount);
    }

    function setMaxStaleness(uint256 seconds_) external onlyOwner {
        maxStaleness = seconds_;
        emit MaxStalenessUpdated(seconds_);
    }

    // ---------------------------------------------------------------- views

    /// @notice The live price of one Stock Token in USD, at the feed's decimals. Reverts unless the asset is an
    /// active official Stock Token with a fresh, positive feed.
    function stockPrice(address stockToken) public view returns (uint256 price, uint8 feedDecimals) {
        if (!anchorRegistry.isOfficialStock(stockToken)) revert NotOfficialStockToken();
        address feed = anchorRegistry.feedOf(stockToken);
        if (feed == address(0)) revert NoFeed();
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = IAggregatorV3(feed).latestRoundData();
        if (answer <= 0) revert BadPrice();
        if (answeredInRound < roundId) revert StalePrice();
        if (updatedAt == 0 || block.timestamp > updatedAt + maxStaleness) revert StalePrice();
        price = uint256(answer);
        feedDecimals = IAggregatorV3(feed).decimals();
    }

    /// @notice Economics for a launch priced in `stockToken`, denominated in that token.
    function quoteEconomics(address stockToken) public view returns (PairEconomics memory e) {
        (uint256 price, uint8 feedDec) = stockPrice(stockToken);
        uint256 target = targetRaiseUsd;
        if (target == 0) revert NoTargetRaise();
        uint8 dec = IERC20Metadata(stockToken).decimals();
        // tokens = (target / 10^TARGET_DECIMALS) / (price / 10^feedDec), then scaled to the token's own decimals.
        uint256 threshold = (target * (10 ** dec) * (10 ** feedDec)) / (price * (10 ** TARGET_DECIMALS));
        if (threshold == 0) revert BadPrice();
        e = PairEconomics({phantomQuote: (threshold * PHANTOM_RATIO_BPS) / BPS, decimals: dec});
    }

    /// @notice Read immediately before launching and pass the hash as `params.expectedEconomics`.
    function previewLaunch(uint256 launchConfigId, address stockToken)
        external
        view
        returns (bytes32 expectedEconomics, PairEconomics memory econ, uint256 priceUsd)
    {
        econ = quoteEconomics(stockToken);
        (priceUsd,) = stockPrice(stockToken);
        expectedEconomics = factory.previewLaunchEconomicsWithPair(launchConfigId, stockToken, econ);
    }

    /// @notice True when a Stock Token can currently be used as a quote. Never reverts, so a UI can filter with it.
    function isEligibleQuote(address stockToken) external view returns (bool) {
        try this.quoteEconomics(stockToken) returns (PairEconomics memory) {
            return true;
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------------- launch

    function launchWithStockQuote(TokenParams calldata params, uint256 launchConfigId, address stockToken)
        external
        payable
        nonReentrant
        returns (address token, bytes32 poolId)
    {
        return _launch(params, launchConfigId, stockToken);
    }

    /// @notice `launchWithStockQuote`, then the creator's first buy in the same transaction: `stockIn` of the
    /// Stock Token is pulled from the caller and spent in the new pool, coins to the caller. `minTokensOut` bounds
    /// the rate.
    function launchWithStockQuoteAndBuy(
        TokenParams calldata params,
        uint256 launchConfigId,
        address stockToken,
        uint256 stockIn,
        uint256 minTokensOut
    ) external payable nonReentrant returns (address token, bytes32 poolId, uint256 tokensOut) {
        (token, poolId) = _launch(params, launchConfigId, stockToken);
        if (stockIn == 0) return (token, poolId, 0);
        uint256 before = IERC20(stockToken).balanceOf(address(this));
        IERC20(stockToken).safeTransferFrom(msg.sender, address(this), stockIn);
        IERC20(stockToken).forceApprove(address(seeder), stockIn);
        PoolKey memory key = factory.poolKeyOf(token);
        tokensOut = seeder.swapExactIn(key, Currency.unwrap(key.currency0) == stockToken, stockIn, minTokensOut, msg.sender);
        _returnLeftover(stockToken, before);
        emit FirstBuy(token, stockIn, tokensOut);
    }

    function _launch(TokenParams calldata params, uint256 launchConfigId, address stockToken)
        internal
        returns (address token, bytes32 poolId)
    {
        uint256 fee = factory.launchFee();
        if (msg.value != fee) revert BadValue();
        PairEconomics memory econ = quoteEconomics(stockToken);
        (uint256 price,) = stockPrice(stockToken);
        (token, poolId) = factory.launchTokenWithPair{value: fee}(msg.sender, params, launchConfigId, stockToken, econ);
        emit StockQuoteLaunched(token, poolId, stockToken, price, econ.phantomQuote);
    }

    /// @dev What the pool did not take came back here from the seeder; it goes on to the buyer. Measured against
    /// the balance before the buyer's funds came in, so nothing this contract held before can leave with them.
    function _returnLeftover(address asset, uint256 before) internal {
        uint256 now_ = IERC20(asset).balanceOf(address(this));
        if (now_ > before) IERC20(asset).safeTransfer(msg.sender, now_ - before);
    }
}
