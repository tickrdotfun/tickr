// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";

/// @notice Finds a CREATE2 salt whose address carries exactly the given hook flags. Hashes the init code once and
/// keeps each attempt to one small keccak, so it runs inside a deploy script where the periphery's miner runs out
/// of memory after a few thousand attempts. An address starting with 0x91 is skipped: Uniswap's routing policy
/// treats that prefix as needing manual allowlisting whatever the flags say.
library HookMine {
    uint256 internal constant MAX_TRIES = 1_000_000;

    function find(address deployer, uint160 flags, bytes32 initCodeHash) internal view returns (address hook, bytes32 salt) {
        flags = flags & Hooks.ALL_HOOK_MASK;
        for (uint256 i; i < MAX_TRIES; i++) {
            salt = bytes32(i);
            hook = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
            if (uint160(hook) & Hooks.ALL_HOOK_MASK == flags && uint160(hook) >> 152 != 0x91 && hook.code.length == 0) return (hook, salt);
        }
        revert("HookMine: no salt found");
    }
}
