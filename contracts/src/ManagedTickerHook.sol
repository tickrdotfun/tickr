// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {ManagedTickerToken} from "./ManagedTickerToken.sol";

/// @title ManagedTickerHook
/// @notice The one hook every invented ticker's dollar pool is created behind. It holds no funds and settles no
/// swap; it only hands each pool's callbacks to the wrapper that owns that pool, so the wrapper can top up its
/// inventory before a swap and check the price and its backing after one. Only the wrapper itself may add or
/// remove liquidity in its pool, and only while it is maintaining. The permissions are the plain before and
/// after callbacks: no swap deltas, no dynamic fee, so any router that trades ordinary pools trades these.
///
/// One hook for all tickers, registered per pool by the ticker launcher at creation, so inventing a ticker
/// needs no mined hook address of its own.
contract ManagedTickerHook is IHooks {
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;
    /// @notice The ticker launcher; the only address that may register a wrapper.
    address public immutable issuer;
    /// @notice The wrapper behind each registered pool.
    mapping(PoolId => ManagedTickerToken) public tokenOf;

    event Registered(address indexed token, bytes32 indexed poolId);

    error NotIssuer();
    error AlreadyRegistered();
    error NotPoolManager();
    error UnknownPool();
    error NotTheWrapper();

    constructor(IPoolManager manager_, address issuer_) {
        poolManager = manager_;
        issuer = issuer_;
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: false,
                beforeAddLiquidity: true,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: true,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
    }

    /// @notice Bind a wrapper to its pool, once, by the launcher that created it. The wrapper's own
    /// `initialize` then checks this binding before it opens the pool.
    function register(ManagedTickerToken token) external {
        if (msg.sender != issuer) revert NotIssuer();
        // the wrapper does not know its hook yet: the key is built here, with this hook in it, exactly as the
        // wrapper will build it once bound
        address counter = address(token.counter());
        bool w0 = address(token) < counter;
        PoolKey memory k = PoolKey(
            Currency.wrap(w0 ? address(token) : counter), Currency.wrap(w0 ? counter : address(token)), token.FEE(), 1, IHooks(address(this))
        );
        PoolId id = k.toId();
        if (address(tokenOf[id]) != address(0)) revert AlreadyRegistered();
        tokenOf[id] = token;
        emit Registered(address(token), PoolId.unwrap(id));
    }

    modifier bound(PoolKey calldata k) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (address(tokenOf[k.toId()]) == address(0)) revert UnknownPool();
        _;
    }

    function beforeInitialize(address sender, PoolKey calldata k, uint160 sqrtP) external view bound(k) returns (bytes4) {
        ManagedTickerToken token = tokenOf[k.toId()];
        if (sender != address(token) || sqrtP != token.PARITY()) revert NotTheWrapper();
        return IHooks.beforeInitialize.selector;
    }

    function beforeAddLiquidity(address sender, PoolKey calldata k, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        bound(k)
        returns (bytes4)
    {
        ManagedTickerToken token = tokenOf[k.toId()];
        if (sender != address(token) || !token.maintaining()) revert NotTheWrapper();
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeRemoveLiquidity(address sender, PoolKey calldata k, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        bound(k)
        returns (bytes4)
    {
        ManagedTickerToken token = tokenOf[k.toId()];
        if (sender != address(token) || !token.maintaining()) revert NotTheWrapper();
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function beforeSwap(address sender, PoolKey calldata k, SwapParams calldata p, bytes calldata)
        external
        bound(k)
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        ManagedTickerToken token = tokenOf[k.toId()];
        if (!(sender == address(token) && token.maintaining())) token.prepare(p);
        return (IHooks.beforeSwap.selector, BeforeSwapDelta.wrap(0), 0);
    }

    function afterSwap(address sender, PoolKey calldata k, SwapParams calldata p, BalanceDelta d, bytes calldata)
        external
        view
        bound(k)
        returns (bytes4, int128)
    {
        ManagedTickerToken token = tokenOf[k.toId()];
        if (!(sender == address(token) && token.maintaining())) token.validateAfter(p, d);
        return (IHooks.afterSwap.selector, 0);
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert UnknownPool();
    }

    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, BalanceDelta)
    {
        revert UnknownPool();
    }

    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, BalanceDelta)
    {
        revert UnknownPool();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert UnknownPool();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert UnknownPool();
    }
}
