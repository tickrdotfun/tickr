// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IFactory} from "./interfaces/IFactory.sol";
import {ILaunchDeployer} from "./interfaces/ILaunchDeployer.sol";
import {ILaunchSeeder} from "./interfaces/ILaunchSeeder.sol";
import {IFeeEscrow} from "./interfaces/IFeeEscrow.sol";
import {IAnchorRegistry} from "./interfaces/IAnchorRegistry.sol";
import {IFeeClub} from "./interfaces/IFeeClub.sol";
import {LaunchConfig, TokenParams, FeePolicy, LaunchedToken, PairEconomics} from "./Types.sol";

struct FactoryInit {
    address owner;
    address feeEscrow;
    address launchDeployer;
    address launchSeeder;
    address launchLocker;
    address buybackVault;
    address anchorRegistry;
    uint256 launchFee;
    uint256 maxCreatorTaxBps;
    FeePolicy defaultPolicy;
}

/// @notice Entry point for launching. One transaction deploys the coin, opens its Uniswap v4 pool at the opening
/// price with the entire supply in a locked one-sided position, and records the terms it will keep forever. The
/// pool has no hook: anything that trades Uniswap v4 on this chain trades it from its first block. Immutable
/// wiring; a new version is a new factory.
contract Factory is IFactory, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint256 internal constant BPS = 10_000;
    uint256 public constant CTO_TIMELOCK = 3 days;
    uint256 public constant CTO_WINDOW = 3 days;

    address public immutable override feeEscrow;
    address public immutable launchDeployer;
    address public immutable launchSeeder;
    address public immutable override launchLocker;
    address public immutable override buybackVault;
    address public immutable anchorRegistry;

    uint256 public override launchFee;
    uint256 public override maxCreatorTaxBps;
    /// @notice Closed at birth: the owner opens launches once the genesis launch is done.
    bool public launchEnabled = false;
    FeePolicy public defaultPolicy;

    LaunchConfig[] private _configs;
    mapping(address => PairEconomics) private _pairEconomics;
    mapping(address => bool) public whitelistedLaunchers;
    mapping(address => bool) public registrars;

    mapping(address => LaunchedToken) private _launches;
    mapping(address => FeePolicy) private _policies;
    /// @notice The ticker club: books the club's slice of every fee paid under an invented ticker. Zero means no
    /// launch has a club and the slice folds into the creator's.
    address public override feeClub;
    /// @notice The one contract allowed to open a ticker's dollar pool through the seeder. Independent of the club.
    address public override tickerLauncher;
    mapping(address => PairEconomics) private _launchEconomics;
    mapping(address => uint256) public launchConfigIdOf;
    address[] private _allTokens;

    struct Proposal {
        address newRecipient;
        uint256 effectiveAt;
        uint256 expiresAt;
    }

    mapping(address => Proposal) public ctoProposals;

    constructor(FactoryInit memory init) Ownable(init.owner) {
        if (
            init.feeEscrow == address(0) || init.launchDeployer == address(0) || init.launchSeeder == address(0)
                || init.launchLocker == address(0) || init.buybackVault == address(0) || init.anchorRegistry == address(0)
        ) revert ZeroAddress();
        // Wiring is immutable, so verify the predicted-address binding right here.
        require(ILaunchDeployer(init.launchDeployer).factory() == address(this), "Factory: deployer binding");
        require(ILaunchSeeder(init.launchSeeder).factory() == address(this), "Factory: seeder binding");
        feeEscrow = init.feeEscrow;
        launchDeployer = init.launchDeployer;
        launchSeeder = init.launchSeeder;
        launchLocker = init.launchLocker;
        buybackVault = init.buybackVault;
        anchorRegistry = init.anchorRegistry;
        launchFee = init.launchFee;
        maxCreatorTaxBps = init.maxCreatorTaxBps;
        _setPolicy(init.defaultPolicy);
    }

    // ---------------------------------------------------------------- owner: terms of future launches only

    function addLaunchConfig(LaunchConfig calldata c) external onlyOwner returns (uint256 id) {
        _validateConfig(c);
        _configs.push(c);
        id = _configs.length - 1;
        emit LaunchConfigAdded(id);
    }

    function setLaunchConfig(uint256 id, LaunchConfig calldata c) external onlyOwner {
        if (id >= _configs.length) revert UnknownLaunchConfig();
        _validateConfig(c);
        _configs[id] = c;
        emit LaunchConfigUpdated(id);
    }

    function setLaunchFee(uint256 fee) external onlyOwner {
        launchFee = fee;
        emit LaunchFeeUpdated(fee);
    }

    function setMaxCreatorTaxBps(uint256 bps) external onlyOwner {
        require(bps <= 1_000, "Factory: cap");
        maxCreatorTaxBps = bps;
    }

    function setLaunchEnabled(bool enabled) external onlyOwner {
        launchEnabled = enabled;
    }

    function setWhitelistedLauncher(address who, bool ok) external onlyOwner {
        whitelistedLaunchers[who] = ok;
    }

    function setRegistrar(address who, bool ok) external onlyOwner {
        registrars[who] = ok;
        emit PairRegistrarUpdated(who, ok);
    }

    /// @notice Applies to future launches only. Existing launches keep the club they launched with.
    function setTickerLauncher(address launcher) external onlyOwner {
        tickerLauncher = launcher;
        emit TickerLauncherUpdated(launcher);
    }

    function setFeeClub(address club) external onlyOwner {
        feeClub = club;
        emit FeeClubUpdated(club);
    }

    function setFeePolicy(FeePolicy calldata p) external onlyOwner {
        _setPolicy(p);
    }

    /// @notice Approve an ERC-20 quote asset with the virtual quote reserve a launch opens with, in its own units.
    /// It must also be listed in the AnchorRegistry to be usable.
    function setPairTokenEconomics(address pairToken, uint256 phantomQuote) external onlyOwner {
        require(pairToken != address(0), "Factory: native uses config");
        if (phantomQuote == 0) {
            delete _pairEconomics[pairToken];
            emit PairTokenRevoked(pairToken);
            return;
        }
        uint8 dec = IERC20Metadata(pairToken).decimals();
        _pairEconomics[pairToken] = PairEconomics(phantomQuote, dec);
        emit PairTokenApproved(pairToken, phantomQuote, dec);
    }

    // ---------------------------------------------------------------- launching

    function launchToken(TokenParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        override
        returns (address token, bytes32 poolId)
    {
        return _launch(msg.sender, params, launchConfigId, pairToken, _resolveEconomics(launchConfigId, pairToken));
    }

    /// @notice Router path (launch and buy). `initiator` is recorded as the deployer and namespaces the salt.
    function launchTokenFor(address initiator, TokenParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        override
        returns (address token, bytes32 poolId)
    {
        if (!registrars[msg.sender]) revert NotRegistrar();
        return _launch(initiator, params, launchConfigId, pairToken, _resolveEconomics(launchConfigId, pairToken));
    }

    /// @notice Registrar path for invented tickers, Stock Tokens and coin quotes: the pair is approved for this
    /// launch only, on the economics the registrar supplies.
    function launchTokenWithPair(
        address initiator,
        TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        PairEconomics calldata economics
    ) external payable override returns (address token, bytes32 poolId) {
        if (!registrars[msg.sender]) revert NotRegistrar();
        if (pairToken == address(0) || economics.phantomQuote == 0) revert PairTokenNotApproved();
        if (IERC20Metadata(pairToken).decimals() != economics.decimals) revert PairTokenDecimalsMismatch();
        return _launch(initiator, params, launchConfigId, pairToken, economics);
    }

    function _launch(
        address initiator,
        TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        PairEconomics memory econ
    ) internal nonReentrant returns (address token, bytes32 poolId) {
        if (launchConfigId >= _configs.length) revert UnknownLaunchConfig();
        LaunchConfig memory c = _configs[launchConfigId];
        if (!c.enabled) revert LaunchConfigDisabled();
        if (!canLaunch(initiator)) revert NotWhitelisted();
        if (msg.value != launchFee) revert LaunchFeeNotPaid();
        if (params.creatorTaxBps > maxCreatorTaxBps) revert CreatorTaxTooHigh();
        if (IAnchorRegistry(anchorRegistry).isReservedTicker(params.symbol)) revert TickerReserved();
        if (IAnchorRegistry(anchorRegistry).isReservedName(params.name)) revert NameReserved();
        if (params.expectedEconomics != _economicsHash(launchConfigId, c, pairToken, econ)) revert LaunchEconomicsMismatch();
        if (pairToken != address(0) && IERC20Metadata(pairToken).decimals() != econ.decimals) revert PairTokenDecimalsMismatch();
        address creatorRecipient = params.creatorFeeRecipient == address(0) ? initiator : params.creatorFeeRecipient;

        // 1. the coin: the whole supply lands here
        token = ILaunchDeployer(launchDeployer).deployToken(initiator, params, c.supply);

        // 2. the pool, opened at the opening price with the whole supply in a locked one-sided position
        uint24 poolFee = uint24((c.baseFeeBps + params.creatorTaxBps) * 100);
        PoolKey memory key = _key(token, pairToken, poolFee, c.tickSpacing);
        bool tokenIs0 = Currency.unwrap(key.currency0) == token;
        IERC20(token).safeTransfer(launchSeeder, c.supply);
        (uint256 lpTokenId, int24 tickLower, int24 tickUpper, uint128 liquidity) =
            ILaunchSeeder(launchSeeder).seedLaunch(key, tokenIs0, c.supply, econ.phantomQuote);
        poolId = PoolId.unwrap(key.toId());

        // 3. the record, frozen
        _launches[token] = LaunchedToken({
            token: token,
            deployer: initiator,
            creatorFeeRecipient: creatorRecipient,
            pairToken: pairToken,
            phantomQuote: econ.phantomQuote,
            poolFee: poolFee,
            tickSpacing: c.tickSpacing,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            lpTokenId: lpTokenId,
            creatorTaxBps: params.creatorTaxBps,
            buybackEnabled: params.buybackEnabled,
            launchedAt: uint64(block.timestamp),
            exists: true
        });
        FeePolicy memory p = defaultPolicy;
        p.hookFeeBps = uint16(c.baseFeeBps);
        // the club's share exists only where there is a club, under an invented ticker. Anywhere else it is the
        // creator's, decided here so the split a launch shows is the split it keeps
        if (p.clubShareBps > 0 && (feeClub == address(0) || !_hasClub(pairToken))) {
            p.creatorShareBps += p.clubShareBps;
            p.clubShareBps = 0;
        }
        // the club is frozen with the split: a later change of the factory's club touches no existing launch
        p.club = p.clubShareBps > 0 ? feeClub : address(0);
        _policies[token] = p;
        _launchEconomics[token] = econ;
        launchConfigIdOf[token] = launchConfigId;
        _allTokens.push(token);

        if (msg.value > 0) IFeeEscrow(feeEscrow).credit{value: msg.value}(p.protocolFeeRecipient);
        emit TokenLaunched(token, poolId, initiator, pairToken, launchConfigId, poolFee, econ.phantomQuote);
        emit LaunchPositionLocked(token, lpTokenId, tickLower, tickUpper, liquidity);
    }

    // ---------------------------------------------------------------- creator controls / CTO

    function transferCreatorFeeRecipient(address token, address newRecipient) external override {
        LaunchedToken storage l = _launches[token];
        if (!l.exists) revert UnknownToken();
        if (msg.sender != l.creatorFeeRecipient) revert NotCreatorFeeRecipient();
        if (newRecipient == address(0)) revert ZeroAddress();
        l.creatorFeeRecipient = newRecipient;
        emit CreatorFeeRecipientUpdated(token, newRecipient);
    }

    /// @notice Owner path with a public notice period, for lost keys and compromised wallets.
    function proposeCreatorFeeRecipient(address token, address newRecipient) external onlyOwner {
        if (!_launches[token].exists) revert UnknownToken();
        if (newRecipient == address(0)) revert ZeroAddress();
        uint256 effectiveAt = block.timestamp + CTO_TIMELOCK;
        uint256 expiresAt = effectiveAt + CTO_WINDOW;
        ctoProposals[token] = Proposal(newRecipient, effectiveAt, expiresAt);
        emit CreatorFeeRecipientChangeProposed(token, newRecipient, effectiveAt, expiresAt);
    }

    function cancelCreatorFeeRecipientProposal(address token) external onlyOwner {
        delete ctoProposals[token];
    }

    function executeCreatorFeeRecipientChange(address token) external {
        Proposal memory p = ctoProposals[token];
        if (p.newRecipient == address(0)) revert UnknownToken();
        if (block.timestamp < p.effectiveAt) revert TimelockNotElapsed();
        if (block.timestamp > p.expiresAt) revert TimelockExpired();
        delete ctoProposals[token];
        _launches[token].creatorFeeRecipient = p.newRecipient;
        emit CreatorFeeRecipientUpdated(token, p.newRecipient);
    }

    // ---------------------------------------------------------------- views

    function launchConfigCount() external view override returns (uint256) {
        return _configs.length;
    }

    function getLaunchConfig(uint256 id) external view override returns (LaunchConfig memory) {
        if (id >= _configs.length) revert UnknownLaunchConfig();
        return _configs[id];
    }

    function approvedPairTokens(address pairToken) public view override returns (bool) {
        if (pairToken == address(0)) return true;
        return _pairEconomics[pairToken].phantomQuote != 0 && IAnchorRegistry(anchorRegistry).isApproved(pairToken);
    }

    function pairTokenEconomics(address pairToken) external view override returns (uint256, uint8) {
        PairEconomics memory e = _pairEconomics[pairToken];
        return (e.phantomQuote, e.decimals);
    }

    function launchEconomicsOf(address token) external view returns (PairEconomics memory) {
        return _launchEconomics[token];
    }

    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view override returns (bytes32) {
        if (launchConfigId >= _configs.length) revert UnknownLaunchConfig();
        return _economicsHash(launchConfigId, _configs[launchConfigId], pairToken, _resolveEconomics(launchConfigId, pairToken));
    }

    function previewLaunchEconomicsWithPair(uint256 launchConfigId, address pairToken, PairEconomics calldata econ)
        external
        view
        override
        returns (bytes32)
    {
        if (launchConfigId >= _configs.length) revert UnknownLaunchConfig();
        return _economicsHash(launchConfigId, _configs[launchConfigId], pairToken, econ);
    }

    function getLaunchedToken(address token) external view override returns (LaunchedToken memory) {
        return _launches[token];
    }

    function getLaunchFeePolicy(address token) external view override returns (FeePolicy memory) {
        return _policies[token];
    }

    function creatorFeeRecipientOf(address token) external view override returns (address) {
        return _launches[token].creatorFeeRecipient;
    }

    function canLaunch(address launcher) public view override returns (bool) {
        return launchEnabled || whitelistedLaunchers[launcher];
    }

    function launchCount() external view override returns (uint256) {
        return _allTokens.length;
    }

    function launchAt(uint256 i) external view override returns (address) {
        return _allTokens[i];
    }

    function owner() public view override(Ownable, IFactory) returns (address) {
        return Ownable.owner();
    }

    /// @notice The pool key of a launch: currencies sorted, the fee frozen at launch, no hook.
    function poolKeyOf(address token) public view override returns (PoolKey memory) {
        LaunchedToken storage l = _launches[token];
        if (!l.exists) revert UnknownToken();
        return _key(token, l.pairToken, l.poolFee, l.tickSpacing);
    }

    function poolIdOf(address token) external view override returns (bytes32) {
        return PoolId.unwrap(poolKeyOf(token).toId());
    }

    // ---------------------------------------------------------------- internals

    function _key(address token, address pairToken, uint24 fee, int24 spacing) internal pure returns (PoolKey memory) {
        (address c0, address c1) = pairToken < token ? (pairToken, token) : (token, pairToken);
        return PoolKey({currency0: Currency.wrap(c0), currency1: Currency.wrap(c1), fee: fee, tickSpacing: spacing, hooks: IHooks(address(0))});
    }

    function _hasClub(address pairToken) internal view returns (bool) {
        if (pairToken == address(0)) return false;
        // a club that is not a contract answers nothing, and a decode of nothing is not caught by try
        if (feeClub.code.length == 0) return false;
        try IFeeClub(feeClub).hasClub(pairToken) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function _resolveEconomics(uint256 launchConfigId, address pairToken) internal view returns (PairEconomics memory e) {
        if (pairToken == address(0)) {
            LaunchConfig memory c = _configs[launchConfigId];
            return PairEconomics(c.phantomQuote, 18);
        }
        if (!approvedPairTokens(pairToken)) revert PairTokenNotApproved();
        return _pairEconomics[pairToken];
    }

    /// @dev Everything a launch freezes that a preview could have shown: the config, the quote, and the split. A
    /// change to any of it between the preview and the send is a mismatch, not a silent new deal.
    function _economicsHash(uint256 id, LaunchConfig memory c, address pairToken, PairEconomics memory e)
        internal
        view
        returns (bytes32)
    {
        FeePolicy memory p = defaultPolicy;
        // the factory's club goes into the pin as it is, not as resolved: a ticker invented inside the launch has no
        // club at preview time and one at launch time, and the pin must agree with itself across that
        return keccak256(
            abi.encode(
                id, c.supply, c.baseFeeBps, e.phantomQuote, e.decimals, c.tickSpacing, pairToken, p.creatorShareBps, p.clubShareBps, p.protocolShareBps, p.protocolFeeRecipient, p.buybackBurnBps, feeClub, launchFee
            )
        );
    }

    function _validateConfig(LaunchConfig calldata c) internal pure {
        require(c.supply > 0 && c.phantomQuote > 0, "Factory: zero");
        require(c.supply <= type(uint128).max, "Factory: supply");
        require(c.baseFeeBps <= 1_000, "Factory: fee");
        require(c.tickSpacing > 0, "Factory: tick");
    }

    function _setPolicy(FeePolicy memory p) internal {
        if (
            p.protocolFeeRecipient == address(0) || uint256(p.creatorShareBps) + p.clubShareBps + p.protocolShareBps != BPS
                || p.buybackBurnBps > BPS
        ) revert InvalidPolicy();
        p.club = address(0); // decided per launch, never a default
        defaultPolicy = p;
        emit FeePolicyUpdated(p);
    }
}
