// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployStack} from "./DeployStack.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

/// @notice forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --verify
/// env: PRIVATE_KEY (deployer, becomes owner unless OWNER is set), PROTOCOL_FEE_RECIPIENT (defaults to deployer)
contract Deploy is Script, DeployStack {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = vm.envOr("OWNER", deployer);
        address feeRecipient = vm.envOr("PROTOCOL_FEE_RECIPIENT", deployer);
        require(block.chainid == 4663, "run against Robinhood Chain");
        require(RH_POOL_MANAGER.code.length > 0 && RH_POSITION_MANAGER.code.length > 0, "v4 not found");
        require(CREATE2_DEPLOYER.code.length > 0, "CREATE2 proxy not found: the guard hook cannot be mined");
        require(PERMIT2.code.length > 0, "Permit2 not found");
        {
            // the ticker fee becomes dollars through this exact pool; without it no name can be invented
            PoolKey memory ethUsdg = PoolKey(Currency.wrap(address(0)), Currency.wrap(RH_USDG), ETH_USDG_FEE, ETH_USDG_TICK_SPACING, IHooks(address(0)));
            (uint160 sqrtP,,,) = IPoolManager(RH_POOL_MANAGER).getSlot0(ethUsdg.toId());
            require(sqrtP != 0, "ETH/USDG pool (fee 100, spacing 1) not initialized");
            require(IPoolManager(RH_POOL_MANAGER).getLiquidity(ethUsdg.toId()) > 0, "ETH/USDG pool has no liquidity");
        }
        // market quotes (any token with a v3 pool) stay off until the depth check is stronger than a same-block read
        bool marketQuotes = vm.envOr("ENABLE_MARKET_QUOTES", false);

        vm.startBroadcast(pk);
        // deploy with the deployer as owner so configuration can happen in the same run, then hand over
        Stack memory s = _deployStack(
            deployer,
            CREATE2_DEPLOYER,
            deployer,
            feeRecipient,
            IPoolManager(RH_POOL_MANAGER),
            IPositionManager(RH_POSITION_MANAGER),
            IAllowanceTransfer(PERMIT2),
            RH_USDG
        );
        _configureStack(s, RH_USDG);
        if (!marketQuotes) s.factory.setRegistrar(address(s.marketQuote), false);
        if (owner != deployer) {
            s.factory.transferOwnership(owner);
            s.registry.transferOwnership(owner);
            s.buybackVault.transferOwnership(owner);
            s.coinQuote.transferOwnership(owner);
            s.stockQuote.transferOwnership(owner);
            s.marketQuote.transferOwnership(owner);
            console.log("Ownership offered to", owner, "- accept with acceptOwnership() on each contract");
        }
        vm.stopBroadcast();

        string memory j = "deployment";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "startBlock", block.number);
        vm.serializeAddress(j, "factory", address(s.factory));
        vm.serializeAddress(j, "chartGuardHook", address(s.chartHook));
        vm.serializeAddress(j, "feeEscrow", address(s.escrow));
        vm.serializeAddress(j, "launchLocker", address(s.locker));
        vm.serializeAddress(j, "launchDeployer", address(s.launchDeployer));
        vm.serializeAddress(j, "launchSeeder", address(s.seeder));
        vm.serializeAddress(j, "buybackVault", address(s.buybackVault));
        vm.serializeAddress(j, "buybackTreasury", address(s.treasury));
        vm.serializeAddress(j, "anchorRegistry", address(s.registry));
        vm.serializeAddress(j, "launchAndBuyRouter", address(s.router));
        vm.serializeAddress(j, "tickerLauncher", address(s.tickers));
        vm.serializeAddress(j, "coinQuoteLauncher", address(s.coinQuote));
        vm.serializeAddress(j, "stockQuoteLauncher", address(s.stockQuote));
        vm.serializeAddress(j, "marketQuoteLauncher", marketQuotes ? address(s.marketQuote) : address(0)); // zero hides the mode on the site
        vm.serializeAddress(j, "v3Factory", RH_V3_FACTORY);
        vm.serializeAddress(j, "zapRouter", address(s.zap));
        vm.serializeAddress(j, "poolManager", RH_POOL_MANAGER);
        vm.serializeAddress(j, "positionManager", RH_POSITION_MANAGER);
        vm.serializeAddress(j, "permit2", PERMIT2);
        vm.serializeAddress(j, "usdg", RH_USDG);
        string memory out = vm.serializeAddress(j, "weth", RH_WETH);
        vm.writeJson(out, vm.envOr("DEPLOY_RECORD", string.concat("deployments/", vm.toString(block.chainid), ".json")));
        console.log("factory", address(s.factory));
        console.log("router", address(s.router));
        console.log("tickers", address(s.tickers));
        console.log("coinQuote", address(s.coinQuote));
    }
}
