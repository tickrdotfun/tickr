// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {HookMine} from "./lib/HookMine.sol";

import {Factory, FactoryInit} from "../src/Factory.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {LaunchDeployer} from "../src/LaunchDeployer.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {LaunchLocker} from "../src/LaunchLocker.sol";
import {LaunchSeeder} from "../src/LaunchSeeder.sol";
import {ILaunchSeeder} from "../src/interfaces/ILaunchSeeder.sol";
import {ManagedTickerHook} from "../src/ManagedTickerHook.sol";
import {ManagedTickerDeployer} from "../src/ManagedTickerDeployer.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {LaunchAndBuyRouter} from "../src/LaunchAndBuyRouter.sol";
import {AnchorRegistry} from "../src/AnchorRegistry.sol";
import {BuybackVault} from "../src/BuybackVault.sol";
import {BuybackTreasury} from "../src/BuybackTreasury.sol";
import {IFeeEscrow} from "../src/interfaces/IFeeEscrow.sol";
import {TickerLauncher} from "../src/TickerLauncher.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CoinQuoteLauncher} from "../src/mode3/CoinQuoteLauncher.sol";
import {StockQuoteLauncher} from "../src/mode4/StockQuoteLauncher.sol";
import {MarketQuoteLauncher} from "../src/mode5/MarketQuoteLauncher.sol";
import {IUniswapV3Factory} from "../src/interfaces/IUniswapV3PoolMinimal.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {IWETH9} from "v4-periphery/src/interfaces/external/IWETH9.sol";
import {LaunchConfig, FeePolicy} from "../src/Types.sol";

/// @notice Shared deployment logic for the broadcast script and the fork test. Robinhood Chain constants live here.
abstract contract DeployStack {
    Vm internal constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Robinhood Chain (4663) canonical addresses, verified live against the chain.
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    /// @dev Uniswap's v4 quoter on Robinhood Chain: the site asks it for executable quotes; nothing on chain depends on it.
    address internal constant RH_V4_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    /// @notice Uniswap's canonical Universal Router on Robinhood Chain: the two activation buys go through it.
    address internal constant RH_UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;

    function _universalRouter() internal view virtual returns (address) {
        return RH_UNIVERSAL_ROUTER;
    }

    function _v4Quoter() internal view virtual returns (address) {
        return RH_V4_QUOTER;
    }
    address internal constant RH_POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant RH_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant RH_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant RH_V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    /// @dev A token needs a v3 pool holding this much WETH, or else this much USDG, to price a launch.
    uint256 internal constant MIN_DEPTH_WETH = 5 ether;
    uint256 internal constant MIN_DEPTH_USDG = 15_000e6;
    /// @dev Stock feeds print during market hours only: Friday's close must still count on Sunday evening.
    uint256 internal constant STOCK_MAX_STALENESS = 3 days;
    /// @dev The live ETH/USDG pool the ticker fee is converted through, and the spacing of every launch pool.
    uint24 internal constant ETH_USDG_FEE = 100;
    int24 internal constant ETH_USDG_TICK_SPACING = 1;
    int24 internal constant TICK_SPACING = 10;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint256 internal constant LAUNCH_FEE = 0.0005 ether;
    uint256 internal constant MAX_CREATOR_TAX_BPS = 200; // 2% on top of the 1% base; the contract cap is 10%
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant PHANTOM_ETH = 1.68 ether;
    uint256 internal constant THRESHOLD_ETH = 4.2 ether;
    uint256 internal constant PHANTOM_USDG = 3_236e6;
    uint256 internal constant THRESHOLD_USDG = 8_090e6;
    /// @dev Feeds report 8 decimals, so this is $8,090.
    uint256 internal constant STOCK_TARGET_RAISE_USD = 8_090e8;

    struct Stack {
        AnchorRegistry registry;
        FeeEscrow escrow;
        LaunchLocker locker;
        BuybackVault buybackVault;
        BuybackTreasury treasury;
        LaunchDeployer launchDeployer;
        LaunchSeeder seeder;
        ManagedTickerHook managedHook;
        ManagedTickerDeployer managedDeployer;
        Factory factory;
        LaunchAndBuyRouter router;
        TickerLauncher tickers;
        CoinQuoteLauncher coinQuote;
        StockQuoteLauncher stockQuote;
        MarketQuoteLauncher marketQuote;
        ZapRouter zap;
    }

    /// @dev The WETH the zap wraps through. Robinhood Chain's on a real deploy; a devnet overrides it with its own.
    function _weth() internal view virtual returns (address) {
        return RH_WETH;
    }

    /// @dev The Uniswap v3 factory market quotes are priced from. Robinhood Chain's on a real deploy; a devnet overrides it.
    function _v3Factory() internal view virtual returns (address) {
        return RH_V3_FACTORY;
    }

    /// @dev The ticker launcher and the two contracts bound to it before it exists: its hook and its wrapper deployer.
    /// Kept out of `_deployStack` so neither function holds too many variables for the compiler's stack.
    function _deployTickers(Stack memory s, address sender, address create2Deployer, IPoolManager pm, address usdg) internal {
        address tickersPred = VM.computeCreateAddress(sender, VM.getNonce(sender) + 2);
        uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;
        (, bytes32 hookSalt) = HookMine.find(create2Deployer, flags, keccak256(abi.encodePacked(type(ManagedTickerHook).creationCode, abi.encode(pm, tickersPred))));
        s.managedHook = new ManagedTickerHook{salt: hookSalt}(pm, tickersPred);
        s.managedDeployer = new ManagedTickerDeployer(tickersPred, IERC20(usdg), pm, 10_000e6);
        s.tickers = new TickerLauncher(s.factory, s.registry, IERC20(usdg), ILaunchSeeder(address(s.seeder)), pm, s.managedHook, s.managedDeployer);
        require(address(s.tickers) == tickersPred, "DeployStack: ticker launcher prediction");
    }

    /// @param sender the account whose nonce sequences the CREATE deployments (EOA in a script, test contract in tests)
    /// @param create2Deployer who executes `new{salt}` (CREATE2 proxy in a script, the test contract in tests)
    /// @param teamWallet where the team's slice of protocol revenue goes; the factory's own recipient is the treasury
    function _deployStack(
        address sender,
        address create2Deployer,
        address owner,
        address teamWallet,
        IPoolManager pm,
        IPositionManager posm,
        IAllowanceTransfer permit2,
        address usdg
    ) internal returns (Stack memory s) {
        s.registry = new AnchorRegistry(owner);
        s.escrow = new FeeEscrow();
        s.buybackVault = new BuybackVault(owner);

        // treasury -> locker -> launch deployer -> executor -> factory
        address executorPred = VM.computeCreateAddress(sender, VM.getNonce(sender) + 3);
        address factoryPred = VM.computeCreateAddress(sender, VM.getNonce(sender) + 4);
        // the protocol's share goes to the buyback treasury from the first launch on; the team is paid from there
        s.treasury = new BuybackTreasury(IFactory(factoryPred), IFeeEscrow(address(s.escrow)), LaunchSeeder(payable(executorPred)), IERC20(usdg), teamWallet);
        s.locker = new LaunchLocker(posm, pm, factoryPred);
        s.launchDeployer = new LaunchDeployer(factoryPred);
        s.seeder = new LaunchSeeder(factoryPred, pm, posm, permit2, address(s.locker), usdg, ETH_USDG_FEE, ETH_USDG_TICK_SPACING);
        require(address(s.seeder) == executorPred, "DeployStack: seeder prediction");
        s.factory = new Factory(
            FactoryInit({
                owner: owner,
                feeEscrow: address(s.escrow),
                launchDeployer: address(s.launchDeployer),
                launchSeeder: address(s.seeder),
                launchLocker: address(s.locker),
                buybackVault: address(s.buybackVault),
                anchorRegistry: address(s.registry),
                launchFee: LAUNCH_FEE,
                maxCreatorTaxBps: MAX_CREATOR_TAX_BPS,
                defaultPolicy: FeePolicy({
                    protocolFeeRecipient: address(s.treasury),
                    creatorShareBps: 5_000, // of the 1% trade fee: creator 50%, ticker club 10%, protocol 40%; no club, and the club's 10% is the creator's
                    clubShareBps: 1_000,
                    protocolShareBps: 4_000,
                    buybackBurnBps: 0,
                    club: address(0),
                    hookFeeBps: 100,
                    maxInternalPriceImpactBps: 300
                })
            })
        );
        require(address(s.factory) == factoryPred, "factory prediction");
        s.router = new LaunchAndBuyRouter(s.factory, ILaunchSeeder(address(s.seeder)));
        s.coinQuote = new CoinQuoteLauncher(owner, s.factory, pm, s.registry, ILaunchSeeder(address(s.seeder)));
        // the one hook every ticker's dollar pool runs behind (CREATE2, mined flags) and the wrapper deployer, both
        // bound to the launcher that follows them
        _deployTickers(s, sender, create2Deployer, pm, usdg);
        // One USD target for every Stock Token; each launch converts it through that asset's own Chainlink feed.
        s.stockQuote = new StockQuoteLauncher(owner, s.factory, s.registry, ILaunchSeeder(address(s.seeder)), STOCK_TARGET_RAISE_USD, STOCK_MAX_STALENESS);
        // Any token on the chain with a real market, priced from its deepest v3 pool against WETH or USDG.
        s.marketQuote = new MarketQuoteLauncher(owner, s.factory, s.registry, IUniswapV3Factory(_v3Factory()), _weth(), usdg, ILaunchSeeder(address(s.seeder)), MIN_DEPTH_WETH, MIN_DEPTH_USDG);
        // Buy any coin with ETH in one transaction, whatever it is quoted in.
        s.zap = new ZapRouter(s.factory, pm, IWETH9(_weth()));
    }

    /// @dev Owner-only configuration. Caller must be `owner` (or pranked as it).
    function _configureStack(Stack memory s, address usdg) internal {
        s.factory.addLaunchConfig(
            LaunchConfig({
                supply: SUPPLY,
                baseFeeBps: 100,
                phantomQuote: PHANTOM_ETH,
                tickSpacing: TICK_SPACING,
                enabled: true
            })
        );
        s.registry.reserveTicker("WETH", true);
        s.registry.register(usdg, "USDG", "Global Dollar Network", 1, address(0));
        s.factory.setPairTokenEconomics(usdg, PHANTOM_USDG);
        // Launches stay closed until the genesis launch has gone through. Only the deployer can launch until
        // then, so nobody can put a coin, or the FUN ticker, in front of the official one. Genesis opens them.
        s.factory.setLaunchEnabled(false);
        s.factory.setWhitelistedLauncher(s.factory.owner(), true);
        s.factory.setRegistrar(address(s.router), true);
        s.factory.setRegistrar(address(s.tickers), true);
        s.factory.setFeeClub(address(s.tickers));
        s.factory.setTickerLauncher(address(s.tickers));
        s.factory.setRegistrar(address(s.coinQuote), true);
        s.factory.setRegistrar(address(s.stockQuote), true);
        s.factory.setRegistrar(address(s.marketQuote), true);
        s.marketQuote.setTargetRaise(address(0), THRESHOLD_ETH);
        s.marketQuote.setTargetRaise(usdg, THRESHOLD_USDG);
        // A launch priced in another coin raises the equivalent of this much of that coin's base asset.
        s.coinQuote.setTargetRaise(address(0), THRESHOLD_ETH);
        s.coinQuote.setTargetRaise(usdg, THRESHOLD_USDG);
    }
}
