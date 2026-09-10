// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IFeeEscrow} from "../src/interfaces/IFeeEscrow.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {LaunchSeeder} from "../src/LaunchSeeder.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {MarketTickerLauncher} from "../src/market/MarketTickerLauncher.sol";
import {QuoteRegistry, ITickerLauncherLike} from "../src/market/QuoteRegistry.sol";
import {BuybackTreasuryV2} from "../src/market/BuybackTreasuryV2.sol";

/// @notice The whole market module: issuer, launcher, quote registry and treasury. Deploys only.
///
/// Four contracts, no owner calls, nothing authorised and no fee policy changed. The module cannot launch and
/// cannot receive a fee until `DeployMarket.activate()` and a `setFeePolicy` are run as their own step.
contract DeployMarketFull is Script {
    using stdJson for string;

    function run() external {
        require(vm.envUint("EXPECTED_CHAIN") == block.chainid, "wrong chain");
        string memory rec = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        address factory = rec.readAddress(".factory");
        address usdg = rec.readAddress(".usdg");
        address legacy = rec.readAddress(".tickerLauncher");
        address escrow = rec.readAddress(".feeEscrow");
        address seeder = rec.readAddress(".launchSeeder");

        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        if (pk == 0) pk = vm.promptSecretUint("deploy wallet private key");
        address deployer = vm.addr(pk);
        address team = vm.envAddress("TEAM_WALLET");

        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);

        vm.startBroadcast(pk);
        MarketTickerDeployer issuer = new MarketTickerDeployer(
            predicted,
            IERC20(vm.envOr("MARKET_COUNTER", usdg)),
            IPoolManager(rec.readAddress(".poolManager")),
            IPositionManager(rec.readAddress(".positionManager")),
            IAllowanceTransfer(rec.readAddress(".permit2")),
            vm.envOr("MARKET_SUPPLY", uint256(500_000_000e6)),
            uint24(vm.envOr("MARKET_FEE", uint256(500))),
            int24(uint24(vm.envOr("MARKET_SPACING", uint256(10)))),
            int24(uint24(vm.envOr("MARKET_WIDTH", uint256(30))))
        );
        MarketTickerLauncher launcher = new MarketTickerLauncher(IFactory(factory), issuer);
        require(address(launcher) == predicted, "the launcher did not land where the issuer expects it");

        QuoteRegistry registry = new QuoteRegistry(ITickerLauncherLike(legacy), issuer, usdg);
        BuybackTreasuryV2 treasury = new BuybackTreasuryV2(
            IFactory(factory), IFeeEscrow(escrow), LaunchSeeder(payable(seeder)), IERC20(usdg), team,
            registry, issuer
        );
        vm.stopBroadcast();

        console.log("marketTickerDeployer", address(issuer));
        console.log("marketTickerLauncher", address(launcher));
        console.log("quoteRegistry", address(registry));
        console.log("buybackTreasuryV2", address(treasury));
        console.log("defaultMinRateToCounterX96", treasury.defaultMinRateToCounterX96());
        console.log("");
        console.log("deployed and inert: not a registrar, not the fee recipient, no config added.");
    }
}
