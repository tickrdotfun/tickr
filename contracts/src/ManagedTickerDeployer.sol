// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {ManagedTickerToken} from "./ManagedTickerToken.sol";

/// @title ManagedTickerDeployer
/// @notice Deploys every invented ticker's wrapper at a CREATE2 address, for the ticker launcher alone. It exists
/// so the wrapper's creation code lives here and not inside the launcher, which would put the launcher over the
/// size a contract may have. Every wrapper wraps the same counter, runs on the same pool manager, answers to the
/// same launcher and opens with the same inventory floor, so a ticker's address follows from its name alone and
/// can be computed before it exists.
contract ManagedTickerDeployer {
    /// @notice The ticker launcher; the only address that may deploy, and the initializer of every wrapper.
    address public immutable issuer;
    IERC20 public immutable counter;
    IPoolManager public immutable poolManager;
    uint256 public immutable floor;

    error NotIssuer();

    constructor(address issuer_, IERC20 counter_, IPoolManager poolManager_, uint256 floor_) {
        issuer = issuer_;
        counter = counter_;
        poolManager = poolManager_;
        floor = floor_;
    }

    function deploy(bytes32 salt, string calldata symbol) external returns (address) {
        if (msg.sender != issuer) revert NotIssuer();
        return address(new ManagedTickerToken{salt: salt}(symbol, symbol, counter, poolManager, issuer, floor));
    }

    function predict(bytes32 salt, string calldata symbol) external view returns (address) {
        return Create2.computeAddress(salt, initCodeHash(symbol), address(this));
    }

    function initCodeHash(string memory symbol) public view returns (bytes32) {
        return keccak256(abi.encodePacked(type(ManagedTickerToken).creationCode, abi.encode(symbol, symbol, counter, poolManager, issuer, floor)));
    }
}
