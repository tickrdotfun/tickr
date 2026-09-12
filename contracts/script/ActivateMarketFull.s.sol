// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {LaunchConfig, FeePolicy} from "../src/Types.sol";
import {FeeSettings} from "../src/market/FeeSettings.sol";

/// @notice The three owner calls that make the market release live on a factory: the protocol fee recipient, the
/// 82 bps configuration, and the registrar.
///
/// The fee policy it sends is the factory's current default with exactly one field changed, the protocol fee
/// recipient. The shares, the buyback burn, the club, the hook fee and the impact cap are read from the factory and
/// written back as they were, and the script checks that field by field before it sends. It never sets a split of
/// its own (Option A: the live 5000 / 1000 / 4000, which a coin without a club freezes as 6000 / 0 / 4000).
/// `setFeePolicy` changes only the default applied to FUTURE launches; every coin already trading keeps the policy
/// frozen into its own storage at launch.
///
/// The new configuration's id is whatever the factory assigns when the transaction is mined, so this script does not
/// print one. Read it from the `LaunchConfigAdded` event in the receipt of the second transaction, then run
/// `check(uint256)` with it (no broadcast): it confirms that configuration, the recipient and the registrar on chain.
///
/// env: EXPECTED_CHAIN, MARKET_LAUNCHER, MARKET_TREASURY, OWNER_KEY (prompted for when unset).
contract ActivateMarketFull is Script {
    using stdJson for string;

    function run() external {
        (IFactory factory, address launcher, address treasury) = _env();
        uint256 ownerPk = vm.envOr("OWNER_KEY", uint256(0));
        if (ownerPk == 0) ownerPk = vm.promptSecretUint("factory owner private key");
        require(vm.addr(ownerPk) == factory.owner(), "that key is not the factory owner");

        FeePolicy memory before = _policy(factory);
        FeePolicy memory p = _policy(factory);
        p.protocolFeeRecipient = treasury;
        _onlyTheRecipientDiffers(before, p);
        console.log("fee policy before: creator / club / protocol shares", before.creatorShareBps, before.clubShareBps, before.protocolShareBps);

        LaunchConfig memory base = factory.getLaunchConfig(0);
        vm.startBroadcast(ownerPk);
        (bool ok1,) = address(factory).call(
            abi.encodeWithSignature("setFeePolicy((address,uint16,uint16,uint16,uint16,address,uint16,uint16))", p)
        );
        require(ok1, "setFeePolicy failed");
        (bool ok2,) = address(factory).call(
            abi.encodeWithSignature(
                "addLaunchConfig((uint256,uint256,uint256,int24,bool))",
                LaunchConfig({
                    supply: base.supply, baseFeeBps: FeeSettings.BASE_FEE_BPS,
                    phantomQuote: base.phantomQuote, tickSpacing: base.tickSpacing, enabled: true
                })
            )
        );
        require(ok2, "addLaunchConfig failed");
        (bool ok3,) = address(factory).call(abi.encodeWithSignature("setRegistrar(address,bool)", launcher, true));
        require(ok3, "setRegistrar failed");
        vm.stopBroadcast();

        console.log("fee recipient set to", treasury);
        console.log("registrar authorised", launcher);
        console.log("the configuration id is in LaunchConfigAdded, in the second transaction's receipt: run check(id)");
    }

    /// @notice After the receipts: the configuration `id` is the 82 bps one built from configuration 0, the fee
    /// recipient is the treasury, and the launcher is a registrar. Reads only.
    function check(uint256 id) external view {
        (IFactory factory, address launcher, address treasury) = _env();
        LaunchConfig memory base = factory.getLaunchConfig(0);
        LaunchConfig memory c = factory.getLaunchConfig(id);
        require(
            c.enabled && c.baseFeeBps == FeeSettings.BASE_FEE_BPS && c.supply == base.supply && c.phantomQuote == base.phantomQuote
                && c.tickSpacing == base.tickSpacing,
            "that configuration is not the enabled 82 bps one"
        );
        FeePolicy memory p = _policy(factory);
        require(p.protocolFeeRecipient == treasury, "the fee recipient is not the treasury");
        (bool ok, bytes memory r) = address(factory).staticcall(abi.encodeWithSignature("registrars(address)", launcher));
        require(ok && abi.decode(r, (bool)), "the launcher is not a registrar");
        console.log("configuration", id, "checked: 82 bps, enabled");
        console.log("fee policy now: creator / club / protocol shares", p.creatorShareBps, p.clubShareBps, p.protocolShareBps);
    }

    function _env() internal view returns (IFactory factory, address launcher, address treasury) {
        require(vm.envUint("EXPECTED_CHAIN") == block.chainid, "wrong chain");
        string memory rec = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        factory = IFactory(rec.readAddress(".factory"));
        launcher = vm.envAddress("MARKET_LAUNCHER");
        treasury = vm.envAddress("MARKET_TREASURY");
        require(treasury != address(0), "no treasury");
    }

    function _policy(IFactory factory) internal view returns (FeePolicy memory) {
        (bool ok, bytes memory raw) = address(factory).staticcall(abi.encodeWithSignature("defaultPolicy()"));
        require(ok, "defaultPolicy");
        return abi.decode(raw, (FeePolicy));
    }

    /// @dev Option A, enforced: every field but the recipient goes back exactly as it was read.
    function _onlyTheRecipientDiffers(FeePolicy memory a, FeePolicy memory b) internal pure {
        require(
            a.creatorShareBps == b.creatorShareBps && a.clubShareBps == b.clubShareBps && a.protocolShareBps == b.protocolShareBps
                && a.buybackBurnBps == b.buybackBurnBps && a.club == b.club && a.hookFeeBps == b.hookFeeBps
                && a.maxInternalPriceImpactBps == b.maxInternalPriceImpactBps,
            "the policy would change more than its recipient"
        );
    }
}
