// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {ILaunchDeployer} from "./interfaces/ILaunchDeployer.sol";
import {Token} from "./Token.sol";
import {TokenParams} from "./Types.sol";

/// @notice Deploys each coin at a CREATE2 address. Salts are namespaced per initiator, so nobody can take an
/// address somebody else predicted, and the address follows from the coin's own metadata and the launcher.
contract LaunchDeployer is ILaunchDeployer {
    address public immutable override factory;

    uint256 public constant MAX_NAME = 64;
    uint256 public constant MAX_SYMBOL = 16;
    /// @dev room for a small on-chain image when pinning is not available
    uint256 public constant MAX_LOGO = 8_192;
    uint256 public constant MAX_DESCRIPTION = 2_048;
    uint256 public constant MAX_SOCIAL = 256;

    error EmptyMetadata();
    error BadSymbol();
    error BadName();
    error MetadataTooLong();

    constructor(address factory_) {
        factory = factory_;
    }

    function deployToken(address initiator, TokenParams calldata params, uint256 supply) external override returns (address token) {
        if (msg.sender != factory) revert OnlyFactory();
        _checkMetadata(params);
        bytes32 salt = _salt(initiator, params.salt);
        token = address(new Token{salt: salt}(params.name, params.symbol, params.logo, params.description, params.socials, supply, factory));
        SafeERC20.safeTransfer(IERC20(token), factory, supply);
    }

    function predictToken(address initiator, TokenParams calldata params, uint256 supply) external view override returns (address token) {
        bytes32 tokenHash = keccak256(
            abi.encodePacked(
                type(Token).creationCode,
                abi.encode(params.name, params.symbol, params.logo, params.description, params.socials, supply, factory)
            )
        );
        token = Create2.computeAddress(_salt(initiator, params.salt), tokenHash, address(this));
    }

    /// @dev Bounded so `name`, `symbol`, `socials()` and `contractURI()` stay readable by anyone forever.
    function _checkMetadata(TokenParams calldata p) internal pure {
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert EmptyMetadata();
        // a name may hold any script, but not a space at either end, two spaces in a row, or a control character:
        // the reserved list compares whole names, and those are the ways to look like one without matching it
        bytes memory nm = bytes(p.name);
        if (nm[0] == 0x20 || nm[nm.length - 1] == 0x20) revert BadName();
        for (uint256 i; i < nm.length; i++) {
            if (uint8(nm[i]) < 0x20 || nm[i] == 0x7F) revert BadName();
            if (nm[i] == 0x20 && i + 1 < nm.length && nm[i + 1] == 0x20) revert BadName();
        }
        // a symbol is letters and digits, nothing else: no "NVDA " past the reserved list, no lookalike scripts
        bytes memory sym = bytes(p.symbol);
        for (uint256 i; i < sym.length; i++) {
            bytes1 c = sym[i];
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A);
            if (!ok) revert BadSymbol();
        }
        if (
            bytes(p.name).length > MAX_NAME || bytes(p.symbol).length > MAX_SYMBOL || bytes(p.logo).length > MAX_LOGO
                || bytes(p.description).length > MAX_DESCRIPTION || bytes(p.socials.twitter).length > MAX_SOCIAL
                || bytes(p.socials.telegram).length > MAX_SOCIAL || bytes(p.socials.discord).length > MAX_SOCIAL
                || bytes(p.socials.website).length > MAX_SOCIAL || bytes(p.socials.farcaster).length > MAX_SOCIAL
        ) revert MetadataTooLong();
    }

    function _salt(address initiator, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(initiator, salt));
    }
}
