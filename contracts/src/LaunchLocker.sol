// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FixedPoint128} from "v4-core/src/libraries/FixedPoint128.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {PositionInfo, PositionInfoLibrary} from "v4-periphery/src/libraries/PositionInfoLibrary.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {IFactory} from "./interfaces/IFactory.sol";
import {IFeeEscrow} from "./interfaces/IFeeEscrow.sol";
import {IFeeClub} from "./interfaces/IFeeClub.sol";
import {IBuybackVault} from "./interfaces/IBuybackVault.sol";
import {FeePolicy, LaunchedToken} from "./Types.sol";

/// @notice Permanent home for every launch position (v4 LP NFT) and any excess supply, and the place fees are
/// collected. There is deliberately no function that can move a position or its principal out. Not the creator,
/// not the protocol.
///
/// A tickr pool is a plain Uniswap v4 pool with no hook. Its LP fee, the 1% base plus the creator's tax, lands in
/// the locked position like any Uniswap fee: buys pay it in the quote, sells pay it in the coin. `collectFees`
/// pulls what the position has earned, anyone may call it, and splits it by the terms frozen at launch. The quote
/// side goes to the fee escrow for the protocol and the creator, and to the ticker club under an invented ticker.
/// The coin side burns in full to the dead address: nobody is paid in the launched coin.
contract LaunchLocker is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using PositionInfoLibrary for PositionInfo;

    error NotPositionManager();
    error NotAMint();

    uint256 internal constant BPS = 10_000;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    IPositionManager public immutable positionManager;
    IPoolManager public immutable poolManager;
    address public immutable factory;

    event PositionLocked(address indexed positionManager, uint256 indexed tokenId);
    event FeesCollected(
        address indexed token,
        uint256 quoteCollected,
        uint256 coinCollected,
        uint256 protocolQuote,
        uint256 creatorQuote,
        uint256 clubQuote,
        uint256 creatorCoin,
        uint256 burnedCoin
    );

    error NotALaunchPool(address token);
    error NothingLocked(address token);

    constructor(IPositionManager posm, IPoolManager pm, address factory_) {
        positionManager = posm;
        poolManager = pm;
        factory = factory_;
    }

    function onERC721Received(address, address from, uint256 tokenId, bytes calldata) external override returns (bytes4) {
        if (msg.sender != address(positionManager)) revert NotPositionManager();
        // a launch position is minted straight to the locker; a position somebody already owns must not end up here
        if (from != address(0)) revert NotAMint();
        emit PositionLocked(msg.sender, tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice What the launch position of `token` has earned and not collected yet, in the pool's currency order.
    function pendingFees(address token) external view returns (uint256 amount0, uint256 amount1) {
        (uint256 tokenId, PoolKey memory key) = _position(token);
        if (tokenId == 0) return (0, 0);
        (, PositionInfo info) = positionManager.getPoolAndPositionInfo(tokenId);
        uint128 liquidity = positionManager.getPositionLiquidity(tokenId);
        if (liquidity == 0) return (0, 0);
        PoolId id = key.toId();
        bytes32 positionId = keccak256(abi.encodePacked(address(positionManager), info.tickLower(), info.tickUpper(), bytes32(tokenId)));
        (, uint256 last0, uint256 last1) = poolManager.getPositionInfo(id, positionId);
        (uint256 inside0, uint256 inside1) = poolManager.getFeeGrowthInside(id, info.tickLower(), info.tickUpper());
        unchecked {
            amount0 = FullMath.mulDiv(inside0 - last0, liquidity, FixedPoint128.Q128);
            amount1 = FullMath.mulDiv(inside1 - last1, liquidity, FixedPoint128.Q128);
        }
    }

    /// @notice Collect the fees the launch position of `token` has earned and split them. Anyone may call.
    function collectFees(address token) external nonReentrant returns (uint256 quoteOut, uint256 coinOut) {
        (uint256 tokenId, PoolKey memory key) = _position(token);
        if (tokenId == 0) revert NothingLocked(token);
        LaunchedToken memory l = IFactory(factory).getLaunchedToken(token);
        bool quoteIs0 = Currency.unwrap(key.currency0) == l.pairToken;

        // a zero-liquidity decrease pays out the fees owed without touching the principal
        uint256 b0 = _balance(key.currency0);
        uint256 b1 = _balance(key.currency1);
        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, address(this));
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        uint256 got0 = _balance(key.currency0) - b0;
        uint256 got1 = _balance(key.currency1) - b1;
        (quoteOut, coinOut) = quoteIs0 ? (got0, got1) : (got1, got0);
        if (quoteOut == 0 && coinOut == 0) return (0, 0);

        _split(token, l, quoteOut, coinOut);
    }

    /// @dev The split, frozen at launch: of the pool fee, the base part is shared by the policy and the creator's
    /// tax is the creator's alone. Quote goes to the escrow and the club; the coin's protocol and club part burns.
    function _split(address token, LaunchedToken memory l, uint256 quoteOut, uint256 coinOut) internal {
        FeePolicy memory p = IFactory(factory).getLaunchFeePolicy(token);
        (uint256 protocolQuote, uint256 creatorQuote, uint256 clubQuote) = quoteOut > 0 ? _splitQuote(token, l, p, quoteOut) : (0, 0, 0);
        (uint256 creatorCoin, uint256 burnedCoin) = coinOut > 0 ? _splitCoin(token, p, l.creatorTaxBps, coinOut) : (0, 0);
        emit FeesCollected(token, quoteOut, coinOut, protocolQuote, creatorQuote, clubQuote, creatorCoin, burnedCoin);
    }

    /// @dev The quote side: the base part of the fee is shared by the frozen policy, the creator's tax is theirs.
    function _splitQuote(address token, LaunchedToken memory l, FeePolicy memory p, uint256 quoteOut)
        internal
        returns (uint256 protocolQuote, uint256 creatorQuote, uint256 clubQuote)
    {
        uint256 base = (quoteOut * p.hookFeeBps) / (uint256(p.hookFeeBps) + l.creatorTaxBps);
        protocolQuote = (base * p.protocolShareBps) / BPS;
        clubQuote = (base * p.clubShareBps) / BPS;
        // the club is the one frozen at launch, paid in the ticker, never in native; with nobody to book it the
        // slice is the protocol's
        address club = l.pairToken == address(0) ? address(0) : p.club;
        if (clubQuote > 0 && (club == address(0) || club.code.length == 0)) {
            protocolQuote += clubQuote;
            clubQuote = 0;
        }
        uint256 rest = base - protocolQuote - clubQuote;
        uint256 buyback = (l.buybackEnabled && p.buybackBurnBps > 0) ? (rest * p.buybackBurnBps) / BPS : 0;
        creatorQuote = rest - buyback + (quoteOut - base);
        address creator = IFactory(factory).creatorFeeRecipientOf(token);
        IFeeEscrow escrow = IFeeEscrow(IFactory(factory).feeEscrow());
        if (l.pairToken == address(0)) {
            if (protocolQuote > 0) escrow.credit{value: protocolQuote}(p.protocolFeeRecipient);
            if (creatorQuote > 0) escrow.credit{value: creatorQuote}(creator);
            if (buyback > 0) IBuybackVault(IFactory(factory).buybackVault()).deposit{value: buyback}(token, address(0), buyback);
            return (protocolQuote, creatorQuote, clubQuote);
        }
        IERC20 q = IERC20(l.pairToken);
        q.forceApprove(address(escrow), protocolQuote + creatorQuote + clubQuote);
        if (protocolQuote > 0) escrow.creditToken(p.protocolFeeRecipient, l.pairToken, protocolQuote);
        if (creatorQuote > 0) escrow.creditToken(creator, l.pairToken, creatorQuote);
        // the club books the volume this collection stands for, slice or no slice; a club that cannot does not block anyone
        if (club != address(0) && club.code.length != 0) {
            try IFeeClub(club).recordVolume(token, (quoteOut * 1_000_000) / l.poolFee) {} catch {}
        }
        if (clubQuote > 0) {
            try IFeeClub(club).onClubFee(token, clubQuote) {
                q.safeTransfer(club, clubQuote);
            } catch {
                escrow.creditToken(p.protocolFeeRecipient, l.pairToken, clubQuote);
                protocolQuote += clubQuote;
                clubQuote = 0;
            }
        }
        if (buyback > 0) {
            address vault = IFactory(factory).buybackVault();
            q.forceApprove(vault, buyback);
            IBuybackVault(vault).deposit(token, l.pairToken, buyback);
        }
    }

    /// @dev The coin side burns in full: every fee taken in the launched coin on a sell goes to the dead address.
    /// Nobody, the creator, the protocol or the club, is paid in the coin. Creators earn the quote on buys.
    function _splitCoin(address token, FeePolicy memory, uint256, uint256 coinOut)
        internal
        returns (uint256 creatorCoin, uint256 burnedCoin)
    {
        creatorCoin = 0;
        burnedCoin = coinOut;
        IERC20(token).safeTransfer(BURN, burnedCoin);
    }

    function _position(address token) internal view returns (uint256 tokenId, PoolKey memory key) {
        LaunchedToken memory l = IFactory(factory).getLaunchedToken(token);
        if (!l.exists || l.lpTokenId == 0) return (0, key);
        return (l.lpTokenId, IFactory(factory).poolKeyOf(token));
    }

    function _balance(Currency c) internal view returns (uint256) {
        return c.isAddressZero() ? address(this).balance : IERC20(Currency.unwrap(c)).balanceOf(address(this));
    }

    receive() external payable {}
}
