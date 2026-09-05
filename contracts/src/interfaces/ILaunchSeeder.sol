// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";

interface ILaunchSeeder {
    error OnlyFactory();
    error OnlyTickerLauncher();
    error Slippage();

    function factory() external view returns (address);

    /// @notice Open the pool at the opening price and lock the whole supply in it as a one-sided position.
    function seedLaunch(PoolKey calldata key, bool tokenIs0, uint256 supply, uint256 phantomQuote)
        external
        returns (uint256 tokenId, int24 tickLower, int24 tickUpper, uint128 liquidity);

    /// @notice Open a wrapper's guarded dollar pool from the ETH sent, locked. Only the ticker club may call.
    function seedDollarPool(address wrapper) external payable;

    /// @notice One pool, exact input. Send value for a native input; approve for an ERC-20 input.
    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut, address recipient)
        external
        payable
        returns (uint256 amountOut);

    function chartKey(address wrapper) external view returns (PoolKey memory);
    function hasChartPool(address wrapper) external view returns (bool);
}
