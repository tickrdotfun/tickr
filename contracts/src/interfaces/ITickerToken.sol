// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The surface of an invented ticker that the router and the launcher need: what it wraps, and the
/// two ways through it.
interface ITickerToken is IERC20 {
    function counter() external view returns (IERC20);
    function mint(uint256 amount, address to) external;
    function redeem(uint256 amount, address to) external;
}
