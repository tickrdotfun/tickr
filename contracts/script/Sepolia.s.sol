// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {MockERC20} from "../test/mocks/MockUSDG.sol";
import {MockFeed} from "../test/mocks/MockFeed.sol";
import {V4Seeder} from "../src/libraries/V4Seeder.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";
import {DeployStack} from "./DeployStack.sol";

/// @dev A Stock Token stand-in: an ERC-20 that answers `uiMultiplier()`, which is how the real ones are told apart.
contract RehearsalStock is MockERC20 {
    constructor(string memory n, string memory s) MockERC20(n, s, 18) {}

    function uiMultiplier() external pure returns (uint256) {
        return 1e18;
    }
}

/// @dev Holds the ETH and USDG for the ETH/USDG pool and mints its position from inside a contract, because the
/// seeder library reads its own balances and a script contract is not allowed to. Whatever is left goes back.
contract RehearsalSeeder {
    function seed(
        IPositionManager posm,
        IAllowanceTransfer permit2,
        PoolKey memory key,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0,
        uint256 amount1,
        address owner
    ) external payable {
        V4Seeder.seedRange(posm, permit2, key, sqrtPriceX96, tickLower, tickUpper, amount0, amount1, owner);
        uint256 left = address(this).balance;
        if (left > 0) payable(owner).transfer(left);
        uint256 t1 = IERC20(Currency.unwrap(key.currency1)).balanceOf(address(this));
        if (t1 > 0) IERC20(Currency.unwrap(key.currency1)).transfer(owner, t1);
    }

    receive() external payable {}
}

/// @notice The dress rehearsal: the launch-day deploy on Sepolia's own Uniswap v4 and v3, wired exactly as
/// Deploy.s.sol wires it, with stand-ins only for what Sepolia lacks: USDG, the ETH/USDG pool, and Stock Tokens
/// with their feeds. Same ownership offer, same record shape, written to deployments/11155111.json.
///
/// forge script script/Sepolia.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --slow
/// env: PRIVATE_KEY (a throwaway), OWNER, PROTOCOL_FEE_RECIPIENT, ENABLE_MARKET_QUOTES, TESTER (optional wallet to fund)
contract Sepolia is Script, DeployStack {
    // Uniswap's Sepolia deployments, checked live: the position manager names this pool manager, the v3 factory
    // answers the fee table, WETH answers its symbol.
    address internal constant SEP_POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address internal constant SEP_POSITION_MANAGER = 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4;
    address internal constant SEP_WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address internal constant SEP_V3_FACTORY = 0x0227628f3F023bb0B980b67D528571c95c6DaC1c;
    /// @dev The stand-in dollar pool's price and depth. A quarter ETH within ten percent of the price holds up
    /// the way a far deeper full-range pool does, which is what the rehearsal buys need.
    uint256 internal constant USDG_PER_ETH = 4_000e6;
    uint256 internal constant POOL_ETH = 0.25 ether;
    int24 internal constant POOL_HALF_WIDTH = 950; // ticks, about ten percent either side

    function _weth() internal view override returns (address) {
        return SEP_WETH;
    }

    function _v3Factory() internal view override returns (address) {
        return SEP_V3_FACTORY;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = vm.envOr("OWNER", deployer);
        address feeRecipient = vm.envOr("PROTOCOL_FEE_RECIPIENT", deployer);
        address tester = vm.envOr("TESTER", address(0));
        require(block.chainid == 11155111, "run against Sepolia");
        require(SEP_POOL_MANAGER.code.length > 0 && SEP_POSITION_MANAGER.code.length > 0, "v4 not found");
        require(address(IPositionManager(SEP_POSITION_MANAGER).poolManager()) == SEP_POOL_MANAGER, "v4 pair mismatch");
        require(CREATE2_DEPLOYER.code.length > 0, "CREATE2 proxy not found: the guard hook cannot be mined");
        require(PERMIT2.code.length > 0, "Permit2 not found");
        bool marketQuotes = vm.envOr("ENABLE_MARKET_QUOTES", false);
        IPoolManager pm = IPoolManager(SEP_POOL_MANAGER);
        IPositionManager posm = IPositionManager(SEP_POSITION_MANAGER);

        vm.startBroadcast(pk);

        // 1. the dollar Sepolia lacks
        MockERC20 usdg = new MockERC20("Global Dollar", "USDG", 6);

        // 2. tickr itself, exactly as Deploy.s.sol does it: the deployer as owner so configuration happens in the same run
        Stack memory s = _deployStack(deployer, CREATE2_DEPLOYER, deployer, feeRecipient, pm, posm, IAllowanceTransfer(PERMIT2), address(usdg));
        _configureStack(s, address(usdg));
        if (!marketQuotes) s.factory.setRegistrar(address(s.marketQuote), false);

        // 3. three Stock Token stand-ins with feeds, registered the way RegisterStockTokens.s.sol registers the real ones
        string[3] memory syms = ["NVDA", "AAPL", "F"];
        string[3] memory names = ["NVIDIA", "Apple", "Ford Motor"];
        int256[3] memory usd = [int256(224_14000000), 328_80000000, 14_27000000];
        address[3] memory stocks;
        for (uint256 i; i < 3; i++) {
            string memory onChain = string.concat(names[i], unicode" • Robinhood Token");
            RehearsalStock t = new RehearsalStock(onChain, syms[i]);
            MockFeed f = new MockFeed(usd[i], 8, string.concat("Robinhood ", syms[i], " / USD"));
            s.registry.register(address(t), syms[i], "Robinhood Assets", 2, address(f));
            string[] memory rn = new string[](1);
            rn[0] = onChain;
            s.registry.reserveNames(rn, true);
            t.mint(deployer, 10_000e18);
            if (tester != address(0)) t.mint(tester, 10_000e18);
            stocks[i] = address(t);
        }

        // 4. the ETH/USDG pool, fee 0.01%, spacing 1: the key every dollar path converts through
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdg)), ETH_USDG_FEE, ETH_USDG_TICK_SPACING, IHooks(address(0)));
        uint256 usdSide = (USDG_PER_ETH * POOL_ETH) / 1 ether;
        uint160 sqrtP = PriceMath.sqrtPriceX96(usdSide, POOL_ETH);
        pm.initialize(key, sqrtP);
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtP);
        RehearsalSeeder rs = new RehearsalSeeder();
        usdg.mint(address(rs), usdSide * 2);
        rs.seed{value: POOL_ETH}(posm, IAllowanceTransfer(PERMIT2), key, sqrtP, tick - POOL_HALF_WIDTH, tick + POOL_HALF_WIDTH, POOL_ETH, usdSide * 2, deployer);

        // 5. money to play with
        usdg.mint(deployer, 100_000e6);
        if (tester != address(0)) usdg.mint(tester, 100_000e6);

        // 6. the handover, as on launch day
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
        vm.serializeAddress(j, "managedTickerHook", address(s.managedHook));
        vm.serializeAddress(j, "managedTickerDeployer", address(s.managedDeployer));
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
        vm.serializeAddress(j, "marketQuoteLauncherDeployed", address(s.marketQuote)); // the contract exists either way: ownership is accepted on it too
        vm.serializeAddress(j, "v3Factory", SEP_V3_FACTORY);
        vm.serializeAddress(j, "zapRouter", address(s.zap));
        vm.serializeAddress(j, "poolManager", SEP_POOL_MANAGER);
        vm.serializeAddress(j, "v4Quoter", address(0)); // no quoter wired on the testnet: the site falls back to its own estimate
        vm.serializeAddress(j, "positionManager", SEP_POSITION_MANAGER);
        vm.serializeAddress(j, "permit2", PERMIT2);
        vm.serializeAddress(j, "usdg", address(usdg));
        vm.serializeAddress(j, "stockNVDA", stocks[0]);
        vm.serializeAddress(j, "stockAAPL", stocks[1]);
        vm.serializeAddress(j, "stockF", stocks[2]);
        vm.serializeBool(j, "sepolia", true);
        string memory out = vm.serializeAddress(j, "weth", SEP_WETH);
        vm.writeJson(out, vm.envOr("DEPLOY_RECORD", string.concat("deployments/", vm.toString(block.chainid), ".json")));
        console.log("factory", address(s.factory));
        console.log("tickers", address(s.tickers));
        console.log("usdg   ", address(usdg));
    }
}
