// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {MarketTickerLauncher} from "../src/market/MarketTickerLauncher.sol";
import {FeeSettings} from "../src/market/FeeSettings.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {LaunchConfig} from "../src/Types.sol";

/// @notice Adds fixed-inventory name markets to a stack that is already deployed, without redeploying it.
///
/// The module is two contracts and two owner calls. Nothing existing changes: coins already launched keep their
/// wrapper names, their pools and their fees, because a launch config is frozen into a coin when it launches.
/// What this adds is a second way to launch, available only once its config is enabled.
///
/// Reads `deployments/<chainid>.json` for the stack it is joining, so the same script serves Sepolia and
/// Robinhood Chain. The issuer's market parameters default to the values the live issuer already uses and can
/// each be overridden by environment variable for a rehearsal.
///
/// **What makes the module live is registrar authorisation, not the launch config.** The factory's only gate on
/// `launchTokenWithPair` is `registrars[msg.sender]`; the launch config id is a parameter the caller chooses.
/// So an authorised launcher can launch on ANY enabled config, including production config 0 at 100 bps, no
/// matter what config this script added. `run()` therefore never authorises the registrar. It deploys the two
/// contracts and adds a disabled config, and that is genuinely inert: nothing can launch through it.
///
/// `activate()` is the deliberate second step that enables the config and authorises the registrar. Run it only
/// when the module is meant to be live on that chain.
contract DeployMarket is Script {
    using stdJson for string;

    /// @dev Refuses to do anything on a chain the caller did not name. A deploy script that merely prints the
    /// chain it found will happily broadcast to the wrong one when an RPC url is stale or copied from another
    /// terminal. EXPECTED_CHAIN is required, and must match.
    function _requireChain() internal view {
        uint256 expected = vm.envUint("EXPECTED_CHAIN");
        require(
            expected == block.chainid,
            string.concat(
                "wrong chain: EXPECTED_CHAIN=", vm.toString(expected), " but the rpc is ", vm.toString(block.chainid)
            )
        );
    }

    function run() external {
        _requireChain();
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory rec = vm.readFile(path);
        address factory = rec.readAddress(".factory");
        address poolManager = rec.readAddress(".poolManager");
        address posm = rec.readAddress(".positionManager");
        address permit2 = rec.readAddress(".permit2");
        address usdg = rec.readAddress(".usdg");

        // the market's shape. defaults are what the live issuer runs; a rehearsal may scale them down
        address counter = vm.envOr("MARKET_COUNTER", usdg);
        uint256 supply = vm.envOr("MARKET_SUPPLY", uint256(500_000_000e6));
        uint24 fee = uint24(vm.envOr("MARKET_FEE", uint256(500)));
        int24 spacing = int24(uint24(vm.envOr("MARKET_SPACING", uint256(10))));
        int24 width = int24(uint24(vm.envOr("MARKET_WIDTH", uint256(30))));

        console.log("chain", block.chainid);
        console.log("factory", factory);
        console.log("counter", counter);
        console.log("supply", supply);

        // a rehearsal can pass the throwaway key in the environment; a real deploy is prompted for, so no
        // launch key ever reaches a command line or a shell history
        uint256 deployPk = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployPk == 0) deployPk = vm.promptSecretUint("deploy wallet private key");
        address deployer = vm.addr(deployPk);

        // the issuer names the launcher that will own it: the deploy wallet's next address but one
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);

        vm.startBroadcast(deployPk);
        MarketTickerDeployer issuer = new MarketTickerDeployer(
            predicted,
            IERC20(counter),
            IPoolManager(poolManager),
            IPositionManager(posm),
            IAllowanceTransfer(permit2),
            supply,
            fee,
            spacing,
            width
        );
        MarketTickerLauncher launcher = new MarketTickerLauncher(IFactory(factory), issuer);
        vm.stopBroadcast();
        require(address(launcher) == predicted, "the launcher did not land where the issuer expects it");

        console.log("marketTickerDeployer", address(issuer));
        console.log("marketTickerLauncher", address(launcher));

        _write(path, address(issuer), address(launcher));

        // deliberately NOT authorised here. the module cannot launch anything until activate() runs.
        console.log("");
        console.log("deployed and inert. the launcher is NOT a registrar, so no launch can go through it.");
        console.log("run activate() when this chain is meant to go live.");
    }

    /// @notice The deliberate switch: enable the 82 bps config and authorise the launcher, in that order.
    ///
    /// Separate from `run()` because authorisation is what makes the module reachable at all. Once the launcher
    /// is a registrar it can launch on any enabled config, so this is the step that changes what the chain can do.
    function activate() external {
        _requireChain();
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory rec = vm.readFile(path);
        address factory = rec.readAddress(".factory");
        address launcher = vm.envAddress("MARKET_LAUNCHER");

        uint256 ownerPk = vm.envOr("OWNER_KEY", uint256(0));
        if (ownerPk == 0) ownerPk = vm.promptSecretUint("factory owner private key");
        require(vm.addr(ownerPk) == IFactory(factory).owner(), "that key is not the factory owner");

        LaunchConfig memory base = IFactory(factory).getLaunchConfig(0);
        uint256 id = IFactory(factory).launchConfigCount();

        vm.startBroadcast(ownerPk);
        // both are owner-only and outside IFactory's read interface, so they go by signature
        (bool okAdd,) = factory.call(
            abi.encodeWithSignature(
                "addLaunchConfig((uint256,uint256,uint256,int24,bool))",
                LaunchConfig({
                    supply: base.supply,
                    baseFeeBps: FeeSettings.BASE_FEE_BPS,
                    phantomQuote: base.phantomQuote,
                    tickSpacing: base.tickSpacing,
                    enabled: true
                })
            )
        );
        require(okAdd, "addLaunchConfig failed");
        (bool okReg,) = factory.call(abi.encodeWithSignature("setRegistrar(address,bool)", launcher, true));
        require(okReg, "setRegistrar failed");
        vm.stopBroadcast();

        console.log("launch config id", id);
        console.log("registrar authorised", launcher);
        console.log("NOTE: an authorised launcher may also launch on config 0. that is the factory's design.");
    }

    /// @dev The record gains the two addresses; every other field is copied through unchanged.
    function _write(string memory path, address issuer, address launcher) internal {
        string memory j = "market";
        vm.serializeAddress(j, "marketTickerDeployer", issuer);
        string memory out = vm.serializeAddress(j, "marketTickerLauncher", launcher);
        console.log("add these two fields to", path);
        console.log(out);
    }
}
