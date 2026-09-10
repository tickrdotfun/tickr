// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {LaunchConfig, FeePolicy} from "../src/Types.sol";
import {FeeSettings} from "../src/market/FeeSettings.sol";

/// @notice The three owner calls that make the module live: the fee policy, the configuration, the registrar.
///
/// `setFeePolicy` changes only the default applied to FUTURE launches; every coin already trading keeps the
/// policy frozen into its own storage at launch, so nothing existing is disturbed by it.
contract ActivateMarketFull is Script {
    using stdJson for string;

    function run() external {
        require(vm.envUint("EXPECTED_CHAIN") == block.chainid, "wrong chain");
        string memory rec = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        address factory = rec.readAddress(".factory");
        address launcher = vm.envAddress("MARKET_LAUNCHER");
        address treasury = vm.envAddress("MARKET_TREASURY");

        uint256 ownerPk = vm.envOr("OWNER_KEY", uint256(0));
        if (ownerPk == 0) ownerPk = vm.promptSecretUint("factory owner private key");
        require(vm.addr(ownerPk) == IFactory(factory).owner(), "that key is not the factory owner");

        (bool okp, bytes memory raw) = factory.staticcall(abi.encodeWithSignature("defaultPolicy()"));
        require(okp, "defaultPolicy");
        FeePolicy memory p = abi.decode(raw, (FeePolicy));
        p.protocolFeeRecipient = treasury;
        p.creatorShareBps = FeeSettings.CREATOR_SHARE_BPS;
        p.clubShareBps = 0;
        p.protocolShareBps = FeeSettings.PROTOCOL_SHARE_BPS;
        p.buybackBurnBps = 0; // the treasury divides the protocol's share; the locker does not pre-split it

        LaunchConfig memory base = IFactory(factory).getLaunchConfig(0);
        uint256 id = IFactory(factory).launchConfigCount();

        vm.startBroadcast(ownerPk);
        (bool ok1,) = factory.call(
            abi.encodeWithSignature("setFeePolicy((address,uint16,uint16,uint16,uint16,address,uint16,uint16))", p)
        );
        require(ok1, "setFeePolicy failed");
        (bool ok2,) = factory.call(
            abi.encodeWithSignature(
                "addLaunchConfig((uint256,uint256,uint256,int24,bool))",
                LaunchConfig({
                    supply: base.supply, baseFeeBps: FeeSettings.BASE_FEE_BPS,
                    phantomQuote: base.phantomQuote, tickSpacing: base.tickSpacing, enabled: true
                })
            )
        );
        require(ok2, "addLaunchConfig failed");
        (bool ok3,) = factory.call(abi.encodeWithSignature("setRegistrar(address,bool)", launcher, true));
        require(ok3, "setRegistrar failed");
        vm.stopBroadcast();

        console.log("fee recipient now", treasury);
        console.log("launch config id", id);
        console.log("registrar authorised", launcher);
    }
}
