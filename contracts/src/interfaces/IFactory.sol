// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {LaunchConfig, TokenParams, FeePolicy, LaunchedToken, PairEconomics} from "../Types.sol";

interface IFactory {
    event TokenLaunched(
        address indexed token,
        bytes32 indexed poolId,
        address indexed deployer,
        address pairToken,
        uint256 launchConfigId,
        uint24 poolFee,
        uint256 phantomQuote
    );
    event LaunchPositionLocked(address indexed token, uint256 lpTokenId, int24 tickLower, int24 tickUpper, uint128 liquidity);
    event FeeClubUpdated(address club);
    event TickerLauncherUpdated(address launcher);
    event LaunchConfigAdded(uint256 indexed id);
    event LaunchConfigUpdated(uint256 indexed id);
    event PairTokenApproved(address indexed pairToken, uint256 phantomQuote, uint8 decimals);
    event PairTokenRevoked(address indexed pairToken);
    event LaunchFeeUpdated(uint256 launchFee);
    event FeePolicyUpdated(FeePolicy policy);
    event CreatorFeeRecipientChangeProposed(address indexed token, address indexed newRecipient, uint256 effectiveAt, uint256 expiresAt);
    event CreatorFeeRecipientUpdated(address indexed token, address indexed newRecipient);
    event PairRegistrarUpdated(address indexed registrar, bool allowed);

    error LaunchConfigDisabled();
    error UnknownLaunchConfig();
    error LaunchEconomicsMismatch();
    error PairTokenNotApproved();
    error PairTokenDecimalsMismatch();
    error LaunchFeeNotPaid();
    error CreatorTaxTooHigh();
    error NotWhitelisted();
    error NotCreatorFeeRecipient();
    error NotRegistrar();
    error TickerReserved();
    error NameReserved();
    error UnknownToken();
    error TimelockNotElapsed();
    error TimelockExpired();
    error InvalidPolicy();
    error ZeroAddress();

    function launchToken(TokenParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        returns (address token, bytes32 poolId);
    function launchTokenFor(address initiator, TokenParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        returns (address token, bytes32 poolId);
    function launchTokenWithPair(
        address initiator,
        TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        PairEconomics calldata economics
    ) external payable returns (address token, bytes32 poolId);

    function transferCreatorFeeRecipient(address token, address newRecipient) external;

    function launchFee() external view returns (uint256);
    function maxCreatorTaxBps() external view returns (uint256);
    function feeEscrow() external view returns (address);
    function launchLocker() external view returns (address);
    function buybackVault() external view returns (address);
    function feeClub() external view returns (address);
    function tickerLauncher() external view returns (address);
    function launchConfigCount() external view returns (uint256);
    function getLaunchConfig(uint256 id) external view returns (LaunchConfig memory);
    function approvedPairTokens(address pairToken) external view returns (bool);
    function pairTokenEconomics(address pairToken) external view returns (uint256 phantomQuote, uint8 decimals);
    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view returns (bytes32);
    function previewLaunchEconomicsWithPair(uint256 launchConfigId, address pairToken, PairEconomics calldata econ)
        external
        view
        returns (bytes32);
    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    function getLaunchFeePolicy(address token) external view returns (FeePolicy memory);
    function creatorFeeRecipientOf(address token) external view returns (address);
    function canLaunch(address launcher) external view returns (bool);
    function launchCount() external view returns (uint256);
    function launchAt(uint256 i) external view returns (address);
    function poolKeyOf(address token) external view returns (PoolKey memory);
    function poolIdOf(address token) external view returns (bytes32);
    function owner() external view returns (address);
}
