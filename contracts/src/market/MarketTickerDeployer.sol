// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {V4Seeder} from "../libraries/V4Seeder.sol";
import {MarketTickerToken} from "./MarketTickerToken.sol";
import {QuoteMarketLocker} from "./QuoteMarketLocker.sol";

/// @title MarketTickerDeployer
/// @notice Creates an invented name as a fixed-supply token with one hookless USDG pool, and locks every unit of
/// it into a single immutable position, in one transaction that either finishes or reverts.
///
/// The position is one-sided on purpose: at creation nobody outside this transaction owns the name, so there is
/// nothing to bid for and no reason to pretend an unfunded dollar bid exists. The position holds only name, at
/// the top of its range, and buyers take it out as the price walks down the range. Their USDG is what builds the
/// other side. Selling walks it back. Nothing recentres, nothing is replenished, and nobody can withdraw.
contract MarketTickerDeployer {
    using PoolIdLibrary for PoolKey;

    /// @notice The launcher allowed to create markets here.
    address public immutable issuer;
    IERC20 public immutable counter;
    IPoolManager public immutable poolManager;
    IPositionManager public immutable posm;
    IAllowanceTransfer public immutable permit2;

    /// @notice Every unit a name will ever have.
    uint256 public immutable supply;
    /// @notice The pool's fee and spacing, fixed for every market this deployer makes.
    uint24 public immutable fee;
    int24 public immutable spacing;
    /// @notice How far from parity the range runs, in ticks. Which side of parity it sits on depends on which
    /// currency the name turns out to be, so the range is derived per name rather than fixed here: the market
    /// must never sell a name below a dollar, whichever way the addresses sort.
    int24 public immutable width;

    struct Market {
        address token;
        address locker;
        uint256 tokenId;
        PoolKey key;
        uint256 supply;
        int24 tickLower;
        int24 tickUpper;
    }

    mapping(address => Market) internal _markets;

    event QuoteMarketCreated(
        address indexed token,
        address indexed counter,
        PoolId indexed poolId,
        address locker,
        uint256 tokenId,
        uint256 supply,
        int24 tickLower,
        int24 tickUpper,
        uint24 fee,
        int24 spacing
    );

    error NotIssuer();
    error PoolExists();
    error NothingPlaced();
    error InventoryNotFullyPlaced(uint256 placed, uint256 expected);

    constructor(
        address issuer_,
        IERC20 counter_,
        IPoolManager poolManager_,
        IPositionManager posm_,
        IAllowanceTransfer permit2_,
        uint256 supply_,
        uint24 fee_,
        int24 spacing_,
        int24 width_
    ) {
        require(issuer_ != address(0) && supply_ != 0, "MarketTickerDeployer: zero");
        require(width_ > 0 && width_ % spacing_ == 0, "MarketTickerDeployer: width");
        issuer = issuer_;
        counter = counter_;
        poolManager = poolManager_;
        posm = posm_;
        permit2 = permit2_;
        supply = supply_;
        fee = fee_;
        spacing = spacing_;
        width = width_;
    }

    /// @notice Where a name will land for a given salt, so a caller can know its address, and its currency
    /// ordering against the counter, before it exists.
    function predict(bytes32 salt, string memory symbol, uint8 decimals_) public view returns (address) {
        return Create2.computeAddress(
            salt,
            keccak256(
                abi.encodePacked(
                    type(MarketTickerToken).creationCode,
                    abi.encode(symbol, symbol, decimals_, supply, address(counter), address(this))
                )
            ),
            address(this)
        );
    }

    function market(address token) external view returns (Market memory) {
        return _markets[token];
    }

    /// @notice The pool a name will trade in, worked out before it exists.
    function keyFor(address token) public view returns (PoolKey memory) {
        (Currency c0, Currency c1) = address(token) < address(counter)
            ? (Currency.wrap(token), Currency.wrap(address(counter)))
            : (Currency.wrap(address(counter)), Currency.wrap(token));
        return PoolKey({currency0: c0, currency1: c1, fee: fee, tickSpacing: spacing, hooks: IHooks(address(0))});
    }

    /// @notice Creates the name, opens its pool at the top of the range and locks the whole issuance into it.
    function create(bytes32 salt, string calldata symbol, uint8 decimals_) external returns (address token, address locker) {
        if (msg.sender != issuer) revert NotIssuer();

        QuoteMarketLocker lock = new QuoteMarketLocker{salt: salt}();
        // the whole issuance is minted to this contract and leaves it only into the position, below
        MarketTickerToken t = new MarketTickerToken{salt: salt}(symbol, symbol, decimals_, supply, address(counter), address(this));
        token = address(t);
        locker = address(lock);

        PoolKey memory key = keyFor(token);
        // the market opens at parity with the whole issuance on the name side
        (int24 lower, int24 upper, int24 openTick) = rangeFor(token);
        uint160 openAt = TickMath.getSqrtPriceAtTick(openTick);
        (uint160 existing,,,) = _slot0(key);
        if (existing != 0) revert PoolExists();
        poolManager.initialize(key, openAt);

        bool nameIs0 = Currency.unwrap(key.currency0) == token;
        (uint256 amount0, uint256 amount1) = nameIs0 ? (supply, uint256(0)) : (uint256(0), supply);
        (uint256 tokenId, uint256 used0, uint256 used1) =
            V4Seeder.seedRange(posm, permit2, key, openAt, lower, upper, amount0, amount1, locker);
        if (tokenId == 0) revert NothingPlaced();

        uint256 placed = nameIs0 ? used0 : used1;
        // every unit goes in; anything the maths leaves behind is dust this contract keeps and cannot spend
        if (placed + 1_000 < supply) revert InventoryNotFullyPlaced(placed, supply);

        lock.record(token, tokenId);
        _markets[token] = Market({
            token: token,
            locker: locker,
            tokenId: tokenId,
            key: key,
            supply: supply,
            tickLower: lower,
            tickUpper: upper
        });

        emit QuoteMarketCreated(token, address(counter), key.toId(), locker, tokenId, supply, lower, upper, fee, spacing);
    }

    /// @notice The range a name's market runs over, and the tick it opens at.
    ///
    /// A pool's price is currency1 per currency0, so which direction "the name gets dearer" points in depends on
    /// how the two addresses sort. Both cases must put the whole issuance on the name side at a price of exactly
    /// one counter unit, and let buying walk the price away from parity in the direction that makes the name
    /// dearer, never cheaper. Getting this backwards sells the name below a dollar, which the ladder test
    /// catches by returning more name than dollars paid.
    function rangeFor(address token) public view returns (int24 lower, int24 upper, int24 openAtTick) {
        if (address(token) < address(counter)) {
            // name is currency0: price is counter per name. Parity is tick 0, dearer is upward.
            // A position holds only currency0 while the price is at or below its lower tick.
            return (int24(0), width, int24(0));
        }
        // name is currency1: price is name per counter. Parity is tick 0, dearer for the buyer is downward.
        // A position holds only currency1 while the price is at or above its upper tick.
        return (-width, int24(0), int24(0));
    }

    function _slot0(PoolKey memory key) internal view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee) {
        bytes32 slot = keccak256(abi.encode(key.toId(), uint256(6)));
        bytes32 data = poolManager.extsload(slot);
        assembly {
            sqrtPriceX96 := and(data, 0xffffffffffffffffffffffffffffffffffffffff)
            tick := signextend(2, shr(160, data))
            protocolFee := and(shr(184, data), 0xffffff)
            lpFee := and(shr(208, data), 0xffffff)
        }
    }
}
