// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PriceMath} from "../../src/libraries/PriceMath.sol";

interface IV3Callback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice A constant-price stand-in for a Uniswap v3 pool: exact-input swaps, fee taken on input, payment collected
/// through the swap callback, partial fills when its inventory runs out. Fund it by transferring tokens to it.
contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    uint256 public immutable price1e18; // token1 raw units per token0 raw unit, scaled by 1e18
    uint128 public liquidity = 1e18;
    int24 public constant tickSpacing = 60;

    function setLiquidity(uint128 l) external {
        liquidity = l;
    }

    /// @dev no initialized ticks: one segment of `liquidity` across the whole range
    function tickBitmap(int16) external pure returns (uint256) {
        return 0;
    }

    function ticks(int24) external pure returns (uint128, int128, uint256, uint256, int56, uint160, uint32, bool) {
        return (0, 0, 0, 0, 0, 0, 0, false);
    }

    constructor(address a, address b, uint24 fee_, uint256 price1e18_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        fee = fee_;
        price1e18 = price1e18_;
    }

    /// @dev The pool's own price, as a real pool would report it: sqrt(price1e18 / 1e18) * 2^96.
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (PriceMath.sqrtPriceX96(price1e18, 1e18), 0, 0, 0, 0, 0, true);
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "exact input only");
        uint256 amtIn = uint256(amountSpecified);
        (address tIn, address tOut) = zeroForOne ? (token0, token1) : (token1, token0);
        uint256 net = amtIn * (1e6 - fee) / 1e6;
        uint256 out = zeroForOne ? net * price1e18 / 1e18 : net * 1e18 / price1e18;
        uint256 avail = IERC20(tOut).balanceOf(address(this));
        if (out > avail) {
            out = avail;
            uint256 netNeeded = zeroForOne ? out * 1e18 / price1e18 : out * price1e18 / 1e18;
            amtIn = netNeeded * 1e6 / (1e6 - fee);
        }
        IERC20(tOut).transfer(recipient, out);
        uint256 before = IERC20(tIn).balanceOf(address(this));
        (amount0, amount1) = zeroForOne ? (int256(amtIn), -int256(out)) : (-int256(out), int256(amtIn));
        IV3Callback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(tIn).balanceOf(address(this)) >= before + amtIn, "unpaid");
    }
}
