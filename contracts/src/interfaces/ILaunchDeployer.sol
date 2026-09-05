// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TokenParams} from "../Types.sol";

interface ILaunchDeployer {
    error OnlyFactory();

    function factory() external view returns (address);
    /// @notice Deploys the coin at its CREATE2 address and hands the whole supply to the factory.
    function deployToken(address initiator, TokenParams calldata params, uint256 supply) external returns (address token);
    /// @notice The address `deployToken` would produce.
    function predictToken(address initiator, TokenParams calldata params, uint256 supply) external view returns (address token);
}
