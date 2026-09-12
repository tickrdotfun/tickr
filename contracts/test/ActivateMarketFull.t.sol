// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Fork} from "./Fork.sol";
import {ActivateMarketFull} from "../script/ActivateMarketFull.s.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {LaunchConfig, FeePolicy} from "../src/Types.sol";

/// @notice The activation script itself, run against the live factory: it changes the fee recipient and nothing else
/// of the policy (Option A), adds the 82 bps configuration, authorises the registrar, and its `check` confirms the
/// id read from the confirmed event rather than one counted before sending.
///
/// Ownership is handed to a test key on the fork, the one way to let the script sign as the owner. Without
/// `FORK_RPC` the test does nothing, like every fork suite.
contract ActivateMarketFullForkTest is Test {
    using stdJson for string;

    uint256 internal constant OWNER_PK = 0x0A11;
    bytes32 internal constant CONFIG_ADDED = keccak256("LaunchConfigAdded(uint256)");

    function test_fork_activation_changesOnlyTheRecipient() public {
        if (!Fork.select()) return;
        IFactory factory = IFactory(vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json")).readAddress(".factory"));
        address owner = vm.addr(OWNER_PK);
        vm.prank(factory.owner());
        Ownable2Step(address(factory)).transferOwnership(owner);
        vm.prank(owner);
        Ownable2Step(address(factory)).acceptOwnership();

        address launcher = makeAddr("market launcher");
        address treasury = makeAddr("market treasury");
        vm.setEnv("EXPECTED_CHAIN", vm.toString(block.chainid));
        vm.setEnv("OWNER_KEY", vm.toString(OWNER_PK));
        vm.setEnv("MARKET_LAUNCHER", vm.toString(launcher));
        vm.setEnv("MARKET_TREASURY", vm.toString(treasury));

        FeePolicy memory before = _policy(factory);
        uint256 countBefore = factory.launchConfigCount();
        ActivateMarketFull s = new ActivateMarketFull();
        vm.recordLogs();
        s.run();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        FeePolicy memory afterwards = _policy(factory);
        assertEq(afterwards.protocolFeeRecipient, treasury, "the recipient is the new treasury");
        assertEq(afterwards.creatorShareBps, before.creatorShareBps, "creator share unchanged");
        assertEq(afterwards.clubShareBps, before.clubShareBps, "club share unchanged");
        assertEq(afterwards.protocolShareBps, before.protocolShareBps, "protocol share unchanged");
        assertEq(afterwards.buybackBurnBps, before.buybackBurnBps, "buyback burn unchanged");
        assertEq(afterwards.club, before.club, "club unchanged");
        assertEq(afterwards.hookFeeBps, before.hookFeeBps, "hook fee unchanged");
        assertEq(afterwards.maxInternalPriceImpactBps, before.maxInternalPriceImpactBps, "impact cap unchanged");
        // and the live default is Option A: a script that brought back 4000 / 0 / 6000 fails here
        assertEq(afterwards.creatorShareBps, 5000, "Option A: creators half");
        assertEq(afterwards.clubShareBps, 1000, "Option A: the club a tenth");
        assertEq(afterwards.protocolShareBps, 4000, "Option A: the protocol the rest");

        // the configuration's id, as the mined event gives it
        uint256 id = type(uint256).max;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(factory) && logs[i].topics[0] == CONFIG_ADDED) id = uint256(logs[i].topics[1]);
        }
        assertEq(id, countBefore, "one configuration added, at the next id");
        LaunchConfig memory c = factory.getLaunchConfig(id);
        assertTrue(c.enabled, "enabled");
        assertEq(c.baseFeeBps, 82, "82 bps");
        s.check(id);
        vm.expectRevert(bytes("that configuration is not the enabled 82 bps one"));
        s.check(0);
    }

    function _policy(IFactory factory) internal view returns (FeePolicy memory) {
        (bool ok, bytes memory raw) = address(factory).staticcall(abi.encodeWithSignature("defaultPolicy()"));
        require(ok, "defaultPolicy");
        return abi.decode(raw, (FeePolicy));
    }
}
