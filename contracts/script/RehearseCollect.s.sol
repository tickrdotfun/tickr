// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IWETH9} from "v4-periphery/src/interfaces/external/IWETH9.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {IQuoteKind} from "../src/market/IQuoteKind.sol";
import {MarketZapRouter} from "../src/market/MarketZapRouter.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {QuoteRegistry} from "../src/market/QuoteRegistry.sol";
import {BuybackTreasuryV2} from "../src/market/BuybackTreasuryV2.sol";
import {QuoteConverter} from "../src/market/QuoteConverter.sol";
import {FeeSettings} from "../src/market/FeeSettings.sol";

interface ILockerLike {
    function collectFees(address token) external returns (uint256 quoteOut, uint256 coinOut);
}

/// @notice Trade the fresh coin, collect its fees, then collect the treasury. Nobody registers the name and
/// nobody sets a rate floor for it: if the allocation happens, it happened on its own.
contract RehearseCollect is Script {
    using stdJson for string;

    function run() external {
        require(vm.envUint("EXPECTED_CHAIN") == block.chainid, "wrong chain");
        string memory rec = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        address factory = rec.readAddress(".factory");
        address usdg = rec.readAddress(".usdg");
        address locker = rec.readAddress(".launchLocker");

        MarketTickerDeployer issuer = MarketTickerDeployer(vm.envAddress("MARKET_ISSUER"));
        QuoteRegistry registry = QuoteRegistry(vm.envAddress("MARKET_REGISTRY"));
        BuybackTreasuryV2 treasury = BuybackTreasuryV2(payable(vm.envAddress("MARKET_TREASURY")));
        address name = vm.envAddress("MARKET_NAME");
        address coin = vm.envAddress("COIN");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);

        vm.startBroadcast(pk);
        MarketZapRouter router = new MarketZapRouter(
            IFactory(factory), IPoolManager(rec.readAddress(".poolManager")),
            IWETH9(rec.readAddress(".weth")), IQuoteKind(address(registry))
        );

        MarketZapRouter.Hop[] memory path = new MarketZapRouter.Hop[](3);
        path[0] = MarketZapRouter.Hop({
            kind: 0,
            key: PoolKey(Currency.wrap(address(0)), Currency.wrap(usdg), 100, 1, IHooks(address(0))),
            pool: address(0)
        });
        path[1] = MarketZapRouter.Hop({kind: 0, key: issuer.keyFor(name), pool: address(0)});
        path[2] = MarketZapRouter.Hop({kind: 0, key: IFactory(factory).poolKeyOf(coin), pool: address(0)});

        uint256 got = router.zapBuy{value: 0.004 ether}(
            MarketZapRouter.ZapParams({
                token: coin, tokenIn: address(0), amountIn: 0, path: path,
                minTokensOut: 1, recipient: me, deadline: block.timestamp + 900
            })
        );
        console.log("bought", got);

        MarketZapRouter.Hop[] memory back = new MarketZapRouter.Hop[](3);
        back[0] = path[2];
        back[1] = path[1];
        back[2] = path[0];
        IERC20(coin).approve(address(router), got);
        router.zapSell(
            MarketZapRouter.ZapSellParams({
                token: coin, amountIn: got, path: back, tokenOut: address(0),
                minOut: 1, recipient: me, deadline: block.timestamp + 900
            })
        );

        (uint256 quoteOut,) = ILockerLike(locker).collectFees(coin);
        console.log("locker collected, in name units:", quoteOut);

        address[] memory names = new address[](1);
        names[0] = name;
        QuoteConverter.Terms[] memory t = new QuoteConverter.Terms[](1);
        t[0] = QuoteConverter.Terms({
            minOutPerInX96: FeeSettings.MIN_RATE_NAME_TO_COUNTER_X96,
            deadline: block.timestamp + 600
        });
        (uint256 total, uint256 toTeam, uint256 earmarked) = treasury.collect(names, t);
        vm.stopBroadcast();

        console.log("=== TREASURY COLLECT ===");
        console.log("total  ", total);
        console.log("team   ", toTeam);
        console.log("earmark", earmarked);
        console.log("registry kindOf(name) AFTER the collect:");
        console.log(uint256(registry.kindOf(name)));
        console.log("name left in the treasury:", IERC20(name).balanceOf(address(treasury)));
        console.log("name sent to the team wallet:", IERC20(name).balanceOf(treasury.teamWallet()));
    }
}
