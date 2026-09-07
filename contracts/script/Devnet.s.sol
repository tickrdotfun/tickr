// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PositionManager} from "v4-periphery/src/PositionManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "v4-periphery/src/interfaces/external/IWETH9.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {WETH} from "solmate/src/tokens/WETH.sol";
import {MockERC20} from "../test/mocks/MockUSDG.sol";
import {MockFeed} from "../test/mocks/MockFeed.sol";
import {MockV3Factory} from "../test/mocks/MockV3Factory.sol";
import {MockV3Pool} from "../test/mocks/MockV3Pool.sol";
import {V4Seeder} from "../src/libraries/V4Seeder.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";
import {DeployStack} from "./DeployStack.sol";

/// @dev A Stock Token stand-in: an ERC-20 that also answers `uiMultiplier()`, which is how the real ones are told
/// apart from ordinary tokens.
contract DevStock is MockERC20 {
    constructor(string memory n, string memory s) MockERC20(n, s, 18) {}

    function uiMultiplier() external pure returns (uint256) {
        return 1e18;
    }
}

/// @dev Holds the ETH and USDG for the ETH/USDG pool and mints the position from inside a contract, because the
/// seeder library reads its own balances and a script contract is not allowed to.
contract DevSeeder {
    function seed(
        IPositionManager posm,
        IAllowanceTransfer permit2,
        PoolKey memory key,
        uint160 sqrtPriceX96,
        uint256 amount0,
        uint256 amount1,
        address owner
    ) external payable {
        V4Seeder.seedFullRange(posm, permit2, key, sqrtPriceX96, amount0, amount1, owner);
        // whatever the position did not take goes back to the deployer
        uint256 left = address(this).balance;
        if (left > 0) payable(owner).transfer(left);
        uint256 t1 = IERC20(Currency.unwrap(key.currency1)).balanceOf(address(this));
        if (t1 > 0) IERC20(Currency.unwrap(key.currency1)).transfer(owner, t1);
    }

    receive() external payable {}
}

/// @notice A self-contained tickr on a plain anvil: the real contracts, plus local stand-ins for everything the
/// chain provides (Uniswap v4, USDG, WETH, a few Stock Tokens with feeds). Nothing here talks to the public RPC,
/// so it never goes stale. The CREATE2 proxy and Permit2 are planted at their canonical addresses by devnet.sh
/// before this runs, so the deploy path is byte for byte the mainnet one.
///
/// env: PRIVATE_KEY (deployer, becomes owner), TESTER (optional wallet to fund with USDG and Stock Tokens)
contract Devnet is Script, DeployStack {
    address internal devWeth;
    address internal devV3Factory;
    address internal devMoon;

    function _v3Factory() internal view override returns (address) {
        return devV3Factory;
    }

    function _weth() internal view override returns (address) {
        return devWeth;
    }


    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        address tester = vm.envOr("TESTER", address(0));
        // any chain id works; devnet.sh picks one no wallet has built in, so a transaction can never be routed elsewhere
        require(CREATE2_DEPLOYER.code.length > 0, "plant the CREATE2 proxy first (devnet.sh does)");
        require(PERMIT2.code.length > 0, "plant Permit2 first (devnet.sh does)");

        vm.startBroadcast(pk);

        // 1. the chain's own pieces, locally
        IPoolManager pm = IPoolManager(address(new PoolManager(me)));
        WETH weth = new WETH();
        devWeth = address(weth);
        IPositionManager posm = IPositionManager(
            address(new PositionManager(pm, IAllowanceTransfer(PERMIT2), 100_000, IPositionDescriptor(address(0)), IWETH9(address(weth))))
        );
        MockERC20 usdg = new MockERC20("Global Dollar", "USDG", 6);
        devV3Factory = address(new MockV3Factory());

        // 2. tickr itself, exactly as Deploy.s.sol does it
        Stack memory s = _deployStack(me, CREATE2_DEPLOYER, me, me, pm, posm, IAllowanceTransfer(PERMIT2), address(usdg));
        _configureStack(s, address(usdg));

        // 3. a few Stock Tokens with feeds, at recent prices, registered the way the real ones are
        string[5] memory syms = ["NVDA", "AAPL", "AMZN", "AMD", "F"];
        string[5] memory names = ["NVIDIA", "Apple", "Amazon", "Advanced Micro Devices", "Ford Motor"];
        int256[5] memory usd = [int256(224_14000000), 328_80000000, 259_03000000, 454_99000000, 14_27000000];
        for (uint256 i; i < 5; i++) {
            string memory onChain = string.concat(names[i], unicode" • Robinhood Token");
            DevStock t = new DevStock(onChain, syms[i]);
            MockFeed f = new MockFeed(usd[i], 8, string.concat("Robinhood ", syms[i], " / USD"));
            s.registry.register(address(t), syms[i], "Robinhood Assets", 2, address(f));
            string[] memory rn = new string[](1);
            rn[0] = onChain;
            s.registry.reserveNames(rn, true);
            t.mint(me, 10_000e18);
            if (tester != address(0)) t.mint(tester, 10_000e18);
        }

        // 4. an ETH/USDG pool, fee 0.01%, so the zap can hop ETH -> USDG -> anything priced in a dollar
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdg)), 100, 1, IHooks(address(0)));
        uint256 ethSide = 1000 ether;
        uint256 usdSide = 2_500_000e6; // 2,500 USDG per ETH
        uint160 sqrtP = PriceMath.sqrtPriceX96(usdSide, ethSide);
        pm.initialize(key, sqrtP);
        DevSeeder seeder = new DevSeeder();
        usdg.mint(address(seeder), usdSide);
        seeder.seed{value: ethSide}(posm, IAllowanceTransfer(PERMIT2), key, sqrtP, ethSide, usdSide, me);

        // 5. a token with a market of its own, nothing to do with tickr: MOON, in a v3 pool against WETH holding
        //    eight WETH at 250,000 MOON per ETH, so a launch can be priced in it
        {
            MockERC20 moon = new MockERC20("Moon", "MOON", 18);
            // price1e18 is token1 raw per token0 raw, scaled by 1e18
            uint256 px = address(weth) < address(moon) ? 250_000e18 : 1e36 / 250_000e18;
            MockV3Pool pool = new MockV3Pool(address(weth), address(moon), 3000, px);
            MockV3Factory(devV3Factory).set(address(weth), address(moon), 3000, address(pool));
            pool.setLiquidity(1e24);
            weth.deposit{value: 8 ether}();
            weth.transfer(address(pool), 8 ether);
            moon.mint(address(pool), 2_000_000e18);
            moon.mint(me, 5_000_000e18);
            if (tester != address(0)) moon.mint(tester, 5_000_000e18);
            devMoon = address(moon);
        }
        // 6. money to play with
        usdg.mint(me, 1_000_000e6);
        if (tester != address(0)) usdg.mint(tester, 1_000_000e6);

        vm.stopBroadcast();

        string memory j = "deployment";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "startBlock", block.number);
        vm.serializeAddress(j, "factory", address(s.factory));
        vm.serializeAddress(j, "managedTickerHook", address(s.managedHook));
        vm.serializeAddress(j, "managedTickerDeployer", address(s.managedDeployer));
        vm.serializeAddress(j, "universalRouter", address(0)); // no canonical router on a bare devnet: the scripts skip the activation buys
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
        vm.serializeAddress(j, "marketQuoteLauncher", address(s.marketQuote));
        vm.serializeAddress(j, "v3Factory", devV3Factory);
        vm.serializeAddress(j, "demoMoon", devMoon);
        vm.serializeAddress(j, "zapRouter", address(s.zap));
        vm.serializeAddress(j, "poolManager", address(pm));
        vm.serializeAddress(j, "positionManager", address(posm));
        vm.serializeAddress(j, "permit2", PERMIT2);
        vm.serializeAddress(j, "usdg", address(usdg));
        vm.serializeBool(j, "devnet", true);
        string memory out = vm.serializeAddress(j, "weth", address(weth));
        vm.writeJson(out, vm.envOr("DEPLOY_RECORD", string.concat("deployments/", vm.toString(block.chainid), ".json")));
        console.log("  devnet factory", address(s.factory));
        console.log("  devnet tickers", address(s.tickers));
        console.log("  devnet usdg   ", address(usdg));
    }
}
