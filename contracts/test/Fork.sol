// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";

/// @dev Selecting the fork the same way everywhere, and saying which block it was.
///
/// A fork test that follows the chain head is a different test every time it runs. That is useful, because it
/// keeps the suite honest about the live contracts, and it is a problem, because a failure cannot be looked at
/// again once the head has moved on. `FORK_BLOCK` pins it, `FORK_ECHO=true` prints the block each suite forked
/// at, and forge already names the block on any failure. A reported failure should be reproduced at its own
/// block before anyone explains it.
library Fork {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @return on Whether a fork was selected at all. False only when no url is set and none is required.
    function select() internal returns (bool on) {
        string memory url = vm.envOr("FORK_RPC", string(""));
        if (bytes(url).length == 0) {
            require(!vm.envOr("REQUIRE_FORK", false), "FORK_RPC is not set: the fork validation cannot run");
            return false;
        }
        uint256 pinned = vm.envOr("FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, pinned);
        if (vm.envOr("FORK_ECHO", false)) console.log("fork block", block.number);
        return true;
    }
}
