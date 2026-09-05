// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Factory} from "../src/Factory.sol";
import {LaunchAndBuyRouter} from "../src/LaunchAndBuyRouter.sol";
import {TickerLauncher} from "../src/TickerLauncher.sol";
import {CoinQuoteLauncher} from "../src/mode3/CoinQuoteLauncher.sol";
import {MarketQuoteLauncher} from "../src/mode5/MarketQuoteLauncher.sol";
import {LaunchSeeder} from "../src/LaunchSeeder.sol";
import {LaunchLocker} from "../src/LaunchLocker.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {ITickerToken} from "../src/interfaces/ITickerToken.sol";
import {TokenParams, Socials, PairEconomics} from "../src/Types.sol";

/// @notice Demo launches for a fork or a devnet, after Genesis. Every coin has a pool from its first block.
/// env: PRIVATE_KEY. Reads deployments/<chainid>.json.
contract Seed is Script {
    using stdJson for string;

    uint24 internal constant FEE_ETH_USDG = 100;
    int24 internal constant TICK_ETH_USDG = 1;

    /// a liquid coin on Robinhood Chain with a v3 pool against WETH, used only when seeding a fork of the real chain
    address internal constant LIVE_CHAIN_TOKEN = 0x020bfC650A365f8BB26819deAAbF3E21291018b4;

    Factory factory;
    LaunchSeeder seeder;
    address me;
    /// @dev Every amount below is scaled by this, in basis points: 10,000 on a fork or a devnet with ETH to burn,
    /// a hundred or so on a public testnet where the deployer holds a fraction of an ETH.
    uint256 scaleBps;

    function _s(uint256 x) internal view returns (uint256) {
        return (x * scaleBps) / 10_000;
    }

    function run() external {
        string memory j = vm.readFile(string.concat(vm.projectRoot(), "/", vm.envOr("DEPLOY_RECORD", string.concat("deployments/", vm.toString(block.chainid), ".json"))));
        uint256 pk = vm.envUint("PRIVATE_KEY");
        me = vm.addr(pk);
        factory = Factory(payable(j.readAddress(".factory")));
        LaunchAndBuyRouter router = LaunchAndBuyRouter(payable(j.readAddress(".launchAndBuyRouter")));
        TickerLauncher tickers = TickerLauncher(j.readAddress(".tickerLauncher"));
        CoinQuoteLauncher coinQuote = CoinQuoteLauncher(j.readAddress(".coinQuoteLauncher"));
        MarketQuoteLauncher marketQuote = MarketQuoteLauncher(j.readAddress(".marketQuoteLauncher"));
        ZapRouter zap = ZapRouter(payable(j.readAddress(".zapRouter")));
        // the chain token a demo coin is priced in: the devnet's own MOON, or on a fork of the real chain a liquid coin that is already there
        address chainToken = vm.keyExistsJson(j, ".demoMoon") ? j.readAddress(".demoMoon") : LIVE_CHAIN_TOKEN;
        seeder = LaunchSeeder(payable(j.readAddress(".launchSeeder")));
        LaunchLocker locker = LaunchLocker(payable(j.readAddress(".launchLocker")));
        address usdg = j.readAddress(".usdg");
        uint256 fee = factory.launchFee();
        scaleBps = vm.envOr("SEED_SCALE_BPS", uint256(10_000));

        vm.startBroadcast(pk);

        // 1. CANDLE, priced in ETH, with a dev buy in the launch
        (address candle,,) = router.launchAndBuy{value: fee + _s(0.05 ether)}(
            _params("Candle", "CANDLE", "a candle, priced in ETH", factory.previewLaunchEconomics(0, address(0)), "candle"),
            0,
            address(0),
            _s(0.05 ether),
            0,
            me
        );
        console.log("  1 CANDLE eth pair, dev buy", candle);

        // 2. PAPER, priced in ETH, then bought hard through its pool
        (address paper,) = factory.launchToken{value: fee}(
            _params("Paper Hands", "PAPER", "paper, priced in ETH", factory.previewLaunchEconomics(0, address(0)), "paper"), 0, address(0)
        );
        _buy(paper, _s(1.5 ether));
        console.log("  2 PAPER eth pair, 1.5 ETH of buys", paper);

        // 3. dollars to invent tickers with, from the live ETH/USDG pool
        PoolKey memory ethUsdg = PoolKey(Currency.wrap(address(0)), Currency.wrap(usdg), FEE_ETH_USDG, TICK_ETH_USDG, IHooks(address(0)));
        seeder.swapExactIn{value: _s(2 ether)}(ethUsdg, true, _s(2 ether), 0, me);
        console.log("  3 usdg on hand", IERC20(usdg).balanceOf(me) / 1e6);

        // 4. BREAD, priced in BANANA. BANANA does not exist yet: inventing it opens its guarded dollar pool
        (,, bytes32 expected,) = tickers.previewLaunch("BANANA", 0);
        (address banana, address bread,) = tickers.launch{value: fee + tickers.NEW_TICKER_FEE()}(
            "BANANA", _params("Bread", "BREAD", "bread, priced in BANANA", expected, "bread"), 0
        );
        console.log("  4 BANANA invented, BREAD under it", banana, bread);

        // 5. a buy of BREAD: dollars become BANANA one for one, then BANANA buys in the pool
        _buyWithDollars(usdg, banana, bread, _s(1_500e6));
        console.log("  5 bought BREAD with 1500 BANANA");

        // 6. a second coin under BANANA, with a dev buy in dollars
        (,, expected,) = tickers.previewLaunch("BANANA", 0);
        IERC20(usdg).approve(address(tickers), _s(500e6));
        (, address split,,) = tickers.launchAndBuy{value: fee}("BANANA", _params("Split", "SPLIT", "a split, also priced in BANANA", expected, "split"), 0, _s(500e6), 0);
        console.log("  6 SPLIT under BANANA, 500 dollar dev buy", split);

        // 7. a coin priced in PAPER. Buying it means buying PAPER first
        (bytes32 exp2,,,) = coinQuote.previewLaunch(0, paper);
        (address diamond,) = coinQuote.launchWithCoinQuote{value: fee}(_params("Diamond", "DIAMOND", "diamond, priced in PAPER", exp2, "diamond"), 0, paper);
        console.log("  7 DIAMOND in PAPER", diamond);

        // 8. a second ticker with one coin under it, and some trading so fees exist to collect
        (,, expected,) = tickers.previewLaunch("KETCHUP", 0);
        (address ketchup, address fries,) = tickers.launch{value: fee + tickers.NEW_TICKER_FEE()}(
            "KETCHUP", _params("Fries", "FRIES", "fries, priced in KETCHUP", expected, "fries"), 0
        );
        _buyWithDollars(usdg, ketchup, fries, _s(300e6));
        locker.collectFees(bread);
        console.log("  8 KETCHUP ticker, FRIES under it; BREAD fees collected", ketchup, fries);

        // 9. a coin priced in a token with a market of its own, then bought with ETH through that token's v3 pool.
        //    only when the mode is on: the record carries a zero address when it is not
        if (address(marketQuote) != address(0)) {
            (bytes32 exp3,, MarketQuoteLauncher.Market memory m,,) = marketQuote.previewLaunch(0, chainToken);
            (address rocket,) = marketQuote.launchWithMarketQuote{value: fee}(
                _params("Rocket", "ROCKET", "rocket, priced in a coin with its own market", exp3, "rocket"), 0, chainToken
            );
            ZapRouter.Hop[] memory path = new ZapRouter.Hop[](2);
            PoolKey memory empty;
            path[0] = ZapRouter.Hop({kind: 1, key: empty, pool: m.pool});
            path[1] = ZapRouter.Hop({kind: 0, key: factory.poolKeyOf(rocket), pool: address(0)});
            zap.zapBuy{value: _s(0.02 ether)}(ZapRouter.ZapParams({token: rocket, tokenIn: address(0), amountIn: 0, path: path, minTokensOut: 0, recipient: me, deadline: block.timestamp + 1 hours}));
            console.log("  9 ROCKET priced in a chain token, bought with ETH through its pool", rocket);
        }

        vm.stopBroadcast();
    }

    function _params(string memory name, string memory symbol, string memory description, bytes32 expected, string memory salt)
        internal
        pure
        returns (TokenParams memory p)
    {
        p = TokenParams({
            name: name,
            symbol: symbol,
            logo: "",
            description: description,
            socials: Socials("", "", "", "", ""),
            creatorFeeRecipient: address(0),
            creatorTaxBps: 0,
            buybackEnabled: false,
            expectedEconomics: expected,
            salt: keccak256(bytes(salt))
        });
    }

    function _buy(address token, uint256 eth) internal {
        PoolKey memory key = factory.poolKeyOf(token);
        seeder.swapExactIn{value: eth}(key, Currency.unwrap(key.currency0) == address(0), eth, 0, me);
    }

    function _buyWithDollars(address usdg, address ticker, address token, uint256 amount) internal {
        IERC20(usdg).approve(ticker, amount);
        ITickerToken(ticker).mint(amount, me);
        IERC20(ticker).approve(address(seeder), amount);
        PoolKey memory key = factory.poolKeyOf(token);
        seeder.swapExactIn(key, Currency.unwrap(key.currency0) == ticker, amount, 0, me);
    }
}
