// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";

/// @notice The guard on a wrapper's dollar pool. An invented ticker is a one-for-one wrapper of USDG; its pool
/// against USDG exists only so chart sites can price the coins under it, and it must never say anything but one
/// dollar. This hook makes that a rule of the pool rather than a hope: the pool can only open at one dollar,
/// liquidity can only be added inside a narrow band around it, and any swap that would leave the pool more than
/// `GUARD_TICKS` away from one dollar reverts. Swaps inside the band clear normally, so the pool stays a real
/// pool with real liquidity and real trades, which is what the indexers read. Nothing here can hold or move funds.
contract ChartGuardHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @notice Furthest the pool may sit from one dollar after any swap, in ticks. Two ticks is about 0.02%.
    int24 public constant GUARD_TICKS = 2;
    /// @notice Liquidity may only be added inside this many ticks of one dollar, about 0.1%.
    int24 public constant BAND_TICKS = 10;
    uint160 internal constant SQRT_ONE = 79228162514264337593543950336; // sqrt(1) * 2^96

    IPoolManager public immutable poolManager;
    /// @notice The only contract that may open a guarded pool: the seeder, when a name is invented.
    address public immutable executor;

    error OnlyPoolManager();
    error OnlyExecutor(address sender);
    error HookNotImplemented();
    error NotOneDollar(uint160 sqrtPriceX96);
    error OutsideTheBand(int24 tickLower, int24 tickUpper);
    error PriceGuard(int24 tick);

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    constructor(IPoolManager pm, address executor_) {
        poolManager = pm;
        executor = executor_;
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: false,
                beforeAddLiquidity: true,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: false,
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

    /// @notice A guarded pool can only be opened by the executor, at exactly one dollar. Nobody can open one
    /// ahead of a graduation to skip the protocol's locked seed.
    function beforeInitialize(address sender, PoolKey calldata, uint160 sqrtPriceX96) external view override onlyPoolManager returns (bytes4) {
        if (sender != executor) revert OnlyExecutor(sender);
        if (sqrtPriceX96 != SQRT_ONE) revert NotOneDollar(sqrtPriceX96);
        return IHooks.beforeInitialize.selector;
    }

    /// @notice Liquidity only inside the band, so there is nowhere for the price to go.
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata p, bytes calldata)
        external
        view
        override
        onlyPoolManager
        returns (bytes4)
    {
        if (p.tickLower < -BAND_TICKS || p.tickUpper > BAND_TICKS) revert OutsideTheBand(p.tickLower, p.tickUpper);
        return IHooks.beforeAddLiquidity.selector;
    }

    /// @notice The swap has happened inside the pool manager's lock; if it left the pool off one dollar, undo it.
    function afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        view
        override
        onlyPoolManager
        returns (bytes4, int128)
    {
        (, int24 tick,,) = poolManager.getSlot0(key.toId());
        if (tick > GUARD_TICKS || tick < -GUARD_TICKS) revert PriceGuard(tick);
        return (IHooks.afterSwap.selector, 0);
    }

    // ---------------------------------------------------------------- not used

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        override
        returns (bytes4, BalanceDelta)
    {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        override
        returns (bytes4, BalanceDelta)
    {
        revert HookNotImplemented();
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata) external pure override returns (bytes4, BeforeSwapDelta, uint24) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }
}
