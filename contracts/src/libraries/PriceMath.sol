// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice sqrtPriceX96 helpers shared by graduation and the Mode 2 anchor pool.
library PriceMath {
    uint256 internal constant Q192 = 2 ** 192;

    /// @notice sqrt(amount1 / amount0) * 2^96, i.e. the v4 price of currency0 in currency1.
    function sqrtPriceX96(uint256 amount1, uint256 amount0) internal pure returns (uint160) {
        require(amount0 > 0 && amount1 > 0, "PriceMath: zero");
        uint256 root;
        if (amount1 / amount0 < (1 << 64)) {
            // the ratio fits a Q192 fixed point: full precision
            root = Math.sqrt(FullMath.mulDiv(amount1, Q192, amount0));
        } else {
            // a steep ratio, such as a whole supply against a few raw units of a six decimal quote: Q128, then
            // the root shifted back up, so no quote layout can overflow the price
            root = Math.sqrt(FullMath.mulDiv(amount1, 1 << 128, amount0)) << 32;
        }
        require(root > 0 && root <= type(uint160).max, "PriceMath: overflow");
        return uint160(root);
    }

    /// @notice sqrtPriceX96 after a relative price move of `bps` (up if `up`, else down). Exact sqrt scaling.
    function sqrtPriceAfterMove(uint160 sqrtP, uint256 bps, bool up) internal pure returns (uint160) {
        return up ? scaleSqrtPrice(sqrtP, 10_000 + bps, 10_000) : scaleSqrtPrice(sqrtP, 10_000 - bps, 10_000);
    }

    /// @notice sqrtPriceX96 scaled so the underlying price is multiplied by `num / den`.
    /// @dev Lets a caller bound a move on a price that is the *inverse* of the pool's own (quote as currency1)
    /// by passing the reciprocal ratio, instead of approximating it with a same-sized move in the other direction.
    function scaleSqrtPrice(uint160 sqrtP, uint256 num, uint256 den) internal pure returns (uint160) {
        uint256 root = Math.sqrt(FullMath.mulDiv(num, 1e36, den)); // sqrt(num/den) * 1e18
        uint256 r = FullMath.mulDiv(uint256(sqrtP), root, 1e18);
        return r > type(uint160).max ? type(uint160).max : uint160(r);
    }

    /// @notice price of currency0 in currency1 scaled by 1e18, from sqrtPriceX96.
    function priceX18(uint160 sqrtP) internal pure returns (uint256) {
        uint256 p = uint256(sqrtP);
        // (p^2 / 2^192) * 1e18 computed as mulDiv twice to stay in range
        uint256 a = FullMath.mulDiv(p, p, 2 ** 96);
        return FullMath.mulDiv(a, 1e18, 2 ** 96);
    }
}
