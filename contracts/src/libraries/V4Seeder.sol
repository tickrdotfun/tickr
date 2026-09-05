// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

/// @notice Mints one full-range Uniswap v4 position through the canonical PositionManager, NFT to `owner`.
/// The calling contract must hold `amount0`/`amount1`. Leftovers stay with the caller.
library V4Seeder {
    using SafeERC20 for IERC20;

    function fullRangeLiquidity(PoolKey memory key, uint160 sqrtPriceX96, uint256 amount0, uint256 amount1)
        internal
        pure
        returns (uint128 liquidity, int24 tickLower, int24 tickUpper)
    {
        tickLower = TickMath.minUsableTick(key.tickSpacing);
        tickUpper = TickMath.maxUsableTick(key.tickSpacing);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), amount0, amount1
        );
    }

    function seedFullRange(
        IPositionManager posm,
        IAllowanceTransfer permit2,
        PoolKey memory key,
        uint160 sqrtPriceX96,
        uint256 amount0,
        uint256 amount1,
        address owner
    ) internal returns (uint256 tokenId, uint256 used0, uint256 used1) {
        (uint128 liquidity, int24 tickLower, int24 tickUpper) = fullRangeLiquidity(key, sqrtPriceX96, amount0, amount1);
        _approve(key.currency0, amount0, posm, permit2);
        _approve(key.currency1, amount1, posm, permit2);

        bool native0 = key.currency0.isAddressZero();
        bytes memory actions;
        bytes[] memory params;
        if (native0) {
            actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP));
            params = new bytes[](3);
            params[2] = abi.encode(key.currency0, address(this));
        } else {
            actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
            params = new bytes[](2);
        }
        params[0] = abi.encode(
            key, tickLower, tickUpper, uint256(liquidity), uint128(amount0), uint128(amount1), owner, bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);

        uint256 b0 = _balance(key.currency0);
        uint256 b1 = _balance(key.currency1);
        tokenId = posm.nextTokenId();
        posm.modifyLiquidities{value: native0 ? amount0 : 0}(abi.encode(actions, params), block.timestamp);
        used0 = b0 - _balance(key.currency0);
        used1 = b1 - _balance(key.currency1);
    }

    /// @notice Mints one position over an explicit tick range. With the range entirely above (or below) the
    /// current price the position is one-sided, which is how the bulk of a DIY quote's supply is offered to the
    /// market: buyers pull it out as the price climbs, and nobody can pull it back.
    function seedRange(
        IPositionManager posm,
        IAllowanceTransfer permit2,
        PoolKey memory key,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0,
        uint256 amount1,
        address owner
    ) internal returns (uint256 tokenId, uint256 used0, uint256 used1) {
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), amount0, amount1
        );
        if (liquidity == 0) return (0, 0, 0);
        _approve(key.currency0, amount0, posm, permit2);
        _approve(key.currency1, amount1, posm, permit2);

        bool native0 = key.currency0.isAddressZero();
        bytes memory actions;
        bytes[] memory params;
        if (native0 && amount0 > 0) {
            actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP));
            params = new bytes[](3);
            params[2] = abi.encode(key.currency0, address(this));
        } else {
            actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
            params = new bytes[](2);
        }
        params[0] = abi.encode(
            key, tickLower, tickUpper, uint256(liquidity), uint128(amount0), uint128(amount1), owner, bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);

        uint256 b0 = _balance(key.currency0);
        uint256 b1 = _balance(key.currency1);
        tokenId = posm.nextTokenId();
        posm.modifyLiquidities{value: native0 ? amount0 : 0}(abi.encode(actions, params), block.timestamp);
        used0 = b0 - _balance(key.currency0);
        used1 = b1 - _balance(key.currency1);
    }

    function _approve(Currency c, uint256 amount, IPositionManager posm, IAllowanceTransfer permit2) private {
        if (c.isAddressZero() || amount == 0) return;
        IERC20(Currency.unwrap(c)).forceApprove(address(permit2), amount);
        permit2.approve(Currency.unwrap(c), address(posm), uint160(amount), uint48(block.timestamp + 1));
    }

    function _balance(Currency c) private view returns (uint256) {
        return c.isAddressZero() ? address(this).balance : IERC20(Currency.unwrap(c)).balanceOf(address(this));
    }
}
