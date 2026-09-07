// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PositionManager} from "v4-periphery/src/PositionManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "v4-periphery/src/interfaces/external/IWETH9.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {HookMine} from "../script/lib/HookMine.sol";
import {ManagedTickerHook} from "../src/ManagedTickerHook.sol";
import {ManagedTickerToken} from "../src/ManagedTickerToken.sol";
import {ManagedTickerDeployer} from "../src/ManagedTickerDeployer.sol";

import {Factory, FactoryInit} from "../src/Factory.sol";
import {LaunchDeployer} from "../src/LaunchDeployer.sol";
import {Token} from "../src/Token.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {LaunchLocker} from "../src/LaunchLocker.sol";
import {LaunchSeeder} from "../src/LaunchSeeder.sol";
import {ILaunchSeeder} from "../src/interfaces/ILaunchSeeder.sol";
import {LaunchAndBuyRouter} from "../src/LaunchAndBuyRouter.sol";
import {AnchorRegistry} from "../src/AnchorRegistry.sol";
import {BuybackVault} from "../src/BuybackVault.sol";
import {TickerLauncher} from "../src/TickerLauncher.sol";
import {CoinQuoteLauncher} from "../src/mode3/CoinQuoteLauncher.sol";
import {IFeeEscrow} from "../src/interfaces/IFeeEscrow.sol";
import {LaunchConfig, TokenParams, Socials, FeePolicy, LaunchedToken} from "../src/Types.sol";
import {MockERC20} from "./mocks/MockUSDG.sol";
import {MockFeed} from "./mocks/MockFeed.sol";
import {StockQuoteLauncher} from "../src/mode4/StockQuoteLauncher.sol";
import {MarketQuoteLauncher} from "../src/mode5/MarketQuoteLauncher.sol";
import {IUniswapV3Factory} from "../src/interfaces/IUniswapV3PoolMinimal.sol";
import {MockV3Factory} from "./mocks/MockV3Factory.sol";
import {MockV3Pool} from "./mocks/MockV3Pool.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {WETH} from "solmate/src/tokens/WETH.sol";
import {V4Seeder} from "../src/libraries/V4Seeder.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

/// @dev Deploys the whole stack against a fresh PoolManager / Permit2 / PositionManager, mirroring the deploy script.
abstract contract BaseTest is Test, DeployPermit2 {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 constant LAUNCH_FEE = 0.0005 ether;
    uint256 constant SUPPLY = 1_000_000_000e18;
    uint256 constant PHANTOM_ETH = 1.68 ether;
    uint256 constant THRESHOLD_ETH = 4.2 ether;
    uint256 constant PHANTOM_USDG = 3_236e6;
    uint256 constant THRESHOLD_USDG = 8_090e6;

    address owner = makeAddr("owner");
    address protocolFees = makeAddr("protocolFees");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address operator = makeAddr("operator");

    IPoolManager poolManager;
    IAllowanceTransfer permit2;
    PositionManager posm;
    PoolSwapTest swapRouter;

    AnchorRegistry registry;
    FeeEscrow escrow;
    LaunchLocker locker;
    BuybackVault buybackVault;
    LaunchDeployer deployer;
    LaunchSeeder seeder;
    ManagedTickerHook managedHook;
    ManagedTickerDeployer managedDeployer;
    Factory factory;
    LaunchAndBuyRouter router;
    TickerLauncher tickers;
    CoinQuoteLauncher coinQuote;
    MockERC20 usdg;
    MockERC20 nvda;
    MockFeed usdgFeed;
    MockFeed nvdaFeed;
    StockQuoteLauncher stockQuote;
    MarketQuoteLauncher marketQuote;
    MockV3Factory v3Factory;
    MockERC20 wild;
    MockV3Pool wildPool;
    ZapRouter zap;
    WETH weth;
    PoolKey ethUsdgKey;

    function setUp() public virtual {
        poolManager = IPoolManager(address(new PoolManager(address(this))));
        permit2 = IAllowanceTransfer(deployPermit2());
        posm = new PositionManager(poolManager, permit2, 100_000, IPositionDescriptor(address(0)), IWETH9(address(0)));
        swapRouter = new PoolSwapTest(poolManager);
        usdg = new MockERC20("USDG", "USDG", 6);
        nvda = new MockERC20("NVDA Stock Token", "NVDA", 18);
        // Feeds report 8 decimals on this chain: USDG at $1.00, NVDA at $224.01.
        usdgFeed = new MockFeed(1e8, 8, "USDG / USD");
        nvdaFeed = new MockFeed(224_01000000, 8, "Robinhood NVDA / USD");

        registry = new AnchorRegistry(owner);
        escrow = new FeeEscrow();
        buybackVault = new BuybackVault(owner);

        // locker -> deployer -> executor -> factory
        uint64 n = vm.getNonce(address(this));
        address executorPred = vm.computeCreateAddress(address(this), n + 2);
        address factoryPred = vm.computeCreateAddress(address(this), n + 3);
        locker = new LaunchLocker(posm, poolManager, factoryPred);
        deployer = new LaunchDeployer(factoryPred);
        seeder = new LaunchSeeder(factoryPred, poolManager, posm, permit2, address(locker), address(usdg), 100, 1);
        require(address(seeder) == executorPred, "fixture: seeder prediction");
        factory = new Factory(
            FactoryInit({
                owner: owner,
                feeEscrow: address(escrow),
                launchDeployer: address(deployer),
                launchSeeder: address(seeder),
                launchLocker: address(locker),
                buybackVault: address(buybackVault),
                anchorRegistry: address(registry),
                launchFee: LAUNCH_FEE,
                maxCreatorTaxBps: 1_000,
                defaultPolicy: FeePolicy({
                    protocolFeeRecipient: protocolFees,
                    creatorShareBps: 5_000, // of the 1% trade fee: creator 50%, ticker club 10%, protocol 40%
                    clubShareBps: 1_000,
                    protocolShareBps: 4_000,
                    buybackBurnBps: 0,
                    club: address(0),
                    hookFeeBps: 100,
                    maxInternalPriceImpactBps: 300
                })
            })
        );
        assertEq(address(factory), factoryPred, "factory prediction");
        assertFalse(factory.launchEnabled(), "a factory is born closed; genesis opens it");

        router = new LaunchAndBuyRouter(factory, ILaunchSeeder(address(seeder)));
        coinQuote = new CoinQuoteLauncher(owner, factory, poolManager, registry, ILaunchSeeder(address(seeder)));
        {
            // the one hook every ticker's dollar pool runs behind (CREATE2, mined flags), bound to the launcher that follows it
            address tickersPred = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
            uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;
            (, bytes32 hookSalt) = HookMine.find(address(this), flags, keccak256(abi.encodePacked(type(ManagedTickerHook).creationCode, abi.encode(poolManager, tickersPred))));
            managedHook = new ManagedTickerHook{salt: hookSalt}(poolManager, tickersPred);
            managedDeployer = new ManagedTickerDeployer(tickersPred, IERC20(address(usdg)), poolManager, 10_000e6);
            tickers = new TickerLauncher(factory, registry, IERC20(address(usdg)), ILaunchSeeder(address(seeder)), poolManager, managedHook, managedDeployer);
            require(address(tickers) == tickersPred, "fixture: ticker launcher prediction");
        }
        // One USD target for every Stock Token, converted through each asset's own feed.
        stockQuote = new StockQuoteLauncher(owner, factory, registry, ILaunchSeeder(address(seeder)), 8_090e8, 1 days);
        weth = new WETH();
        zap = new ZapRouter(factory, poolManager, IWETH9(address(weth)));
        // A token with a market on the chain, but nothing to do with tickr: a v3 pool against WETH at one to one,
        // holding six WETH, above the five WETH floor.
        v3Factory = new MockV3Factory();
        marketQuote = new MarketQuoteLauncher(owner, factory, registry, IUniswapV3Factory(address(v3Factory)), address(weth), address(usdg), ILaunchSeeder(address(seeder)), 5 ether, 15_000e6);
        wild = new MockERC20("Wild Token", "WILD", 18);
        wildPool = new MockV3Pool(address(weth), address(wild), 3000, 1e18);
        v3Factory.set(address(weth), address(wild), 3000, address(wildPool));
        // enough active liquidity that five WETH fit inside the launcher's price band
        wildPool.setLiquidity(300e18);
        vm.deal(address(this), address(this).balance + 10 ether);
        weth.deposit{value: 6 ether}();
        weth.transfer(address(wildPool), 6 ether);
        wild.mint(address(wildPool), 6e18);
        wild.mint(alice, 1_000e18);
        wild.mint(bob, 1_000e18);

        // An ETH/USDG pool at 2,000 USDG per ETH, so zaps can hop ETH -> USDG -> anything quoted in USDG.
        ethUsdgKey = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdg)), 100, 1, IHooks(address(0)));
        uint160 ethUsdgSqrtP = PriceMath.sqrtPriceX96(2_000_000e6, 1000 ether);
        poolManager.initialize(ethUsdgKey, ethUsdgSqrtP);
        usdg.mint(address(this), 2_000_000e6);
        vm.deal(address(this), address(this).balance + 1000 ether);
        V4Seeder.seedFullRange(posm, permit2, ethUsdgKey, ethUsdgSqrtP, 1000 ether, 2_000_000e6, address(this));

        vm.startPrank(owner);
        factory.addLaunchConfig(
            LaunchConfig({
                supply: SUPPLY,
                baseFeeBps: 100,
                phantomQuote: PHANTOM_ETH,
                tickSpacing: 10,
                enabled: true
            })
        );
        registry.register(address(usdg), "USDG", "Global Dollar Network", 1, address(usdgFeed));
        registry.register(address(nvda), "NVDA", "Robinhood Assets", 2, address(nvdaFeed));
        string[] memory names = new string[](1);
        names[0] = "NVDA Stock Token";
        registry.reserveNames(names, true);
        factory.setPairTokenEconomics(address(usdg), PHANTOM_USDG);
        factory.setPairTokenEconomics(address(nvda), 10e18);
        factory.setRegistrar(address(router), true);
        factory.setRegistrar(address(tickers), true);
        factory.setFeeClub(address(tickers));
        factory.setTickerLauncher(address(tickers));
        factory.setLaunchEnabled(true); // the factory is born closed; the fixture opens it as genesis would
        factory.setRegistrar(address(coinQuote), true);
        factory.setRegistrar(address(stockQuote), true);
        factory.setRegistrar(address(marketQuote), true);
        marketQuote.setTargetRaise(address(0), 1 ether);
        marketQuote.setTargetRaise(address(usdg), 2_000e6);
        coinQuote.setTargetRaise(address(0), 1 ether);
        coinQuote.setTargetRaise(address(usdg), 2_000e6);
        vm.stopPrank();

        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        usdg.mint(alice, 1_000_000e6);
        usdg.mint(bob, 1_000_000e6);
        usdg.mint(creator, 1_000_000e6);
        nvda.mint(alice, 1_000e18);
        nvda.mint(bob, 1_000e18);
    }

    receive() external payable {}

    // ---------------------------------------------------------------- helpers

    function defaultParams(address pairToken, uint16 creatorTax) internal view returns (TokenParams memory p) {
        p = TokenParams({
            name: "Test Meme",
            symbol: "MEME",
            logo: "ipfs://logo",
            description: "a test meme",
            socials: Socials("x", "tg", "dc", "web", "fc"),
            creatorFeeRecipient: address(0),
            creatorTaxBps: creatorTax,
            buybackEnabled: false,
            expectedEconomics: factory.previewLaunchEconomics(0, pairToken),
            salt: keccak256(abi.encode(vm.getBlockTimestamp(), pairToken, creatorTax))
        });
    }

    /// the coin's first five seconds tax every buy but the launcher's own, and its first three blocks cap every
    /// wallet but the launcher's; most tests want the plain coin after both
    function pastTheWindow() internal {
        vm.warp(vm.getBlockTimestamp() + 6);
        vm.roll(vm.getBlockNumber() + 3);
    }

    /// past the protected blocks but still inside the snipe window's first second: the tax alone
    function pastTheBlocks() internal {
        vm.roll(vm.getBlockNumber() + 3);
    }

    /// @dev A salt whose coin sorts below `ticker`, as every coin under a ticker must; the site grinds the same way.
    function saltUnder(address who, TokenParams memory p, address ticker) internal view returns (bytes32 salt) {
        salt = p.salt;
        for (uint256 i; i < 256; i++) {
            p.salt = salt;
            if (deployer.predictToken(who, p, factory.getLaunchConfig(0).supply) < ticker) return salt;
            salt = keccak256(abi.encode(salt, i));
        }
        revert("fixture: no salt under the ticker");
    }

    function launchNative(address who) internal returns (Token token, bytes32 poolId) {
        TokenParams memory p = defaultParams(address(0), 0);
        vm.prank(who);
        (address t, bytes32 id) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        pastTheWindow();
        return (Token(t), id);
    }

    function launchPair(address who, address pair) internal returns (Token token, bytes32 poolId) {
        TokenParams memory p = defaultParams(pair, 0);
        vm.prank(who);
        (address t, bytes32 id) = factory.launchToken{value: LAUNCH_FEE}(p, 0, pair);
        pastTheWindow();
        return (Token(t), id);
    }

    /// Buy `token` with `amount` of its pair through the seeder's plain swap.
    function buy(Token token, address who, uint256 amount) internal returns (uint256 out) {
        PoolKey memory key = factory.poolKeyOf(address(token));
        address pair = factory.getLaunchedToken(address(token)).pairToken;
        bool zeroForOne = Currency.unwrap(key.currency0) == pair;
        vm.startPrank(who);
        if (pair == address(0)) {
            out = seeder.swapExactIn{value: amount}(key, zeroForOne, amount, 0, who);
        } else {
            IERC20(pair).approve(address(seeder), amount);
            out = seeder.swapExactIn(key, zeroForOne, amount, 0, who);
        }
        vm.stopPrank();
    }

    /// Sell `amount` of `token` for its pair through the seeder's plain swap.
    function sell(Token token, address who, uint256 amount) internal returns (uint256 out) {
        PoolKey memory key = factory.poolKeyOf(address(token));
        bool zeroForOne = Currency.unwrap(key.currency0) == address(token);
        vm.startPrank(who);
        token.approve(address(seeder), amount);
        out = seeder.swapExactIn(key, zeroForOne, amount, 0, who);
        vm.stopPrank();
    }

    function poolSwap(PoolKey memory key, address who, bool zeroForOne, int256 amountSpecified, uint256 value)
        internal
    {
        vm.startPrank(who);
        if (!key.currency0.isAddressZero()) IERC20(Currency.unwrap(key.currency0)).approve(address(swapRouter), type(uint256).max);
        if (!key.currency1.isAddressZero()) IERC20(Currency.unwrap(key.currency1)).approve(address(swapRouter), type(uint256).max);
        swapRouter.swap{value: value}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? 4295128739 + 1 : 1461446703485210103287273052203988822378723970342 - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }
}
