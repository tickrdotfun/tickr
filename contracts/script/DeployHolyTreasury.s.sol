// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IFeeEscrow} from "../src/interfaces/IFeeEscrow.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {LaunchSeeder} from "../src/LaunchSeeder.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {BuybackTreasuryV2} from "../src/market/BuybackTreasuryV2.sol";
import {BuybackTreasuryHoly} from "../src/market/BuybackTreasuryHoly.sol";

/// @notice Deploys the HOLY treasury. Deploys only: nothing is authorised and no fee policy is changed. The two
/// owner-side steps that give it a role are separate transactions from separate wallets:
///   1. the creator wallet: `Factory.transferCreatorFeeRecipient(HOLY, treasury)`
///   2. the factory owner:  `Factory.setFeePolicy(default policy with protocolFeeRecipient = treasury)`
///
/// Env: EXPECTED_CHAIN, TEAM_WALLET, V2_TREASURY (the live BuybackTreasuryV2, whose registry and issuer are
/// reused), HOLY, COW; PRIVATE_KEY or a prompt.
contract DeployHolyTreasury is Script {
    using stdJson for string;

    function run() external {
        require(vm.envUint("EXPECTED_CHAIN") == block.chainid, "wrong chain");
        string memory rec = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        address factory = rec.readAddress(".factory");
        address usdg = rec.readAddress(".usdg");
        address escrow = rec.readAddress(".feeEscrow");
        address seeder = rec.readAddress(".launchSeeder");
        address team = vm.envAddress("TEAM_WALLET");
        address holy = vm.envAddress("HOLY");
        address cow = vm.envAddress("COW");
        BuybackTreasuryV2 live = BuybackTreasuryV2(payable(vm.envAddress("V2_TREASURY")));

        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        if (pk == 0) pk = vm.promptSecretUint("deploy wallet private key");

        vm.startBroadcast(pk);
        BuybackTreasuryHoly treasury = new BuybackTreasuryHoly(
            IFactory(factory), IFeeEscrow(escrow), LaunchSeeder(payable(seeder)), IERC20(usdg), team,
            live.quoteRegistry(), live.marketIssuer(), holy, cow
        );
        vm.stopBroadcast();

        (address c, address n) = treasury.official();
        require(c == holy && n == cow, "official is not HOLY in COW");
        require(treasury.teamWallet() == team, "team wallet");
        require(treasury.defaultMinRateToCounterX96() == live.defaultMinRateToCounterX96(), "floor differs from the live treasury");
        console.log("BuybackTreasuryHoly", address(treasury));
        console.log("official coin", c);
        console.log("official name", n);
        console.log("team wallet", treasury.teamWallet());
        console.log("burn share bps", treasury.buybackShareBps());
    }
}
