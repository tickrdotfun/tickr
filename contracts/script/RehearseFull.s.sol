// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {TokenParams, Socials, LaunchConfig} from "../src/Types.sol";
import {MarketTickerLauncher} from "../src/market/MarketTickerLauncher.sol";
import {QuoteRegistry} from "../src/market/QuoteRegistry.sol";
import {IQuoteKind} from "../src/market/IQuoteKind.sol";

interface ILaunchDeployerLike {
    function predictToken(address initiator, TokenParams calldata params, uint256 supply) external view returns (address);
}

/// @notice Creates a fresh name and its first coin through createAndLaunch, and prints what the registry knows
/// about the name afterwards: nothing. The onboarding happens later, during the treasury's first collect.
contract RehearseFull is Script {
    using stdJson for string;

    function run() external {
        require(vm.envUint("EXPECTED_CHAIN") == block.chainid, "wrong chain");
        string memory rec = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        address factory = rec.readAddress(".factory");
        address launchDeployer = rec.readAddress(".launchDeployer");

        MarketTickerLauncher launcher = MarketTickerLauncher(vm.envAddress("MARKET_LAUNCHER"));
        QuoteRegistry registry = QuoteRegistry(vm.envAddress("MARKET_REGISTRY"));
        uint256 cfg = vm.envUint("CONFIG_ID");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);

        LaunchConfig memory c = IFactory(factory).getLaunchConfig(cfg);
        require(c.baseFeeBps == 82 && c.enabled, "config is not the enabled 82 bps one");

        bytes32 nameSalt = keccak256(abi.encodePacked("FULLREHEARSE", block.timestamp));
        address predicted = launcher.predictName(nameSalt, "FULL", 6);

        TokenParams memory p = TokenParams({
            name: "FULLA", symbol: "FULLA", logo: "", description: "",
            socials: Socials("", "", "", "", ""), creatorFeeRecipient: address(0), creatorTaxBps: 0,
            buybackEnabled: true, expectedEconomics: launcher.previewEconomics(cfg, predicted), salt: bytes32(0)
        });
        for (uint256 i = 1; i < 200_000; ++i) {
            p.salt = bytes32(i);
            if (ILaunchDeployerLike(launchDeployer).predictToken(me, p, c.supply) < predicted) break;
        }

        uint256 fee = IFactory(factory).launchFee();
        vm.startBroadcast(pk);
        (address name, address coin,) = launcher.createAndLaunch{value: fee}(nameSalt, "FULL", 6, p, cfg);
        vm.stopBroadcast();
        require(name == predicted, "the name did not land where predicted");
        require(coin < name, "the coin must sort below its name");

        console.log("name", name);
        console.log("coin", coin);
        console.log("registry kindOf(name) BEFORE any collect:");
        console.log(uint256(registry.kindOf(name)));
        console.log("registry provenanceOf(name):");
        console.log(uint256(registry.provenanceOf(name)));
    }
}
