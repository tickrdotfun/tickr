// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fork} from "./Fork.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";

/// @notice A market-quoted coin bought and sold through the router this release RETAINS.
///
/// The release ships no new router: the site trades through the ZapRouter already deployed at
/// 0xeB3E56b1…ffe4. Everything proved with `MarketZapRouter` is therefore beside the point for production, and
/// what matters is whether that deployed contract can walk a route through a fixed-inventory name at all.
///
/// It has no wrap hop to take here. A market name has no mint and no redeem, so the route is three ordinary v4
/// swaps, which is what the site's own route builder produces for a name of this kind. This buys and sells a
/// coin that is already live on chain 4663 to show the deployed router handles it unchanged.
contract ProductionRouterMarketForkTest is Test {
    address constant LIVE_ZAP_ROUTER = 0xeB3E56b10C58e1149Ae38B65E0B28A90cC33ffe4;
    address constant FACTORY = 0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f;
    address constant MARKET_DEPLOYER = 0x0F72C545Bd455DB7184F5B0eA4725f5AA8494418;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    // a live fixed-inventory name and a coin priced in it, both already on chain
    address constant TESTNAME = 0x4Dd89f107d9b8395237719FA9d621a7A5BC00c52;
    address constant PROBETWO = 0x151073687c3f5B569fdEC876bEb3DBcEF5F3Ac83;

    address trader = address(0xBEEF);
    bool forked;

    function setUp() public {
        forked = Fork.select();
    }

    function path() internal view returns (ZapRouter.Hop[] memory p) {
        p = new ZapRouter.Hop[](3);
        p[0] = ZapRouter.Hop({
            kind: 0,
            key: PoolKey(Currency.wrap(address(0)), Currency.wrap(USDG), 100, 1, IHooks(address(0))),
            pool: address(0)
        });
        p[1] = ZapRouter.Hop({kind: 0, key: MarketTickerDeployer(MARKET_DEPLOYER).keyFor(TESTNAME), pool: address(0)});
        p[2] = ZapRouter.Hop({kind: 0, key: IFactory(FACTORY).poolKeyOf(PROBETWO), pool: address(0)});
    }

    function test_fork_theDeployedRouterBuysAndSellsAMarketQuotedCoin() public {
        if (!forked) return;
        ZapRouter r = ZapRouter(payable(LIVE_ZAP_ROUTER));
        assertGt(LIVE_ZAP_ROUTER.code.length, 0, "the deployed router is the one under test");

        vm.deal(trader, 1 ether);
        uint256 ethBefore = trader.balance;

        vm.prank(trader);
        uint256 got = r.zapBuy{value: 0.01 ether}(
            ZapRouter.ZapParams({
                token: PROBETWO, tokenIn: address(0), amountIn: 0, path: path(),
                minTokensOut: 1, recipient: trader, deadline: block.timestamp + 300
            })
        );
        console.log("BUY  0.01 ETH ->");
        console.log(got);
        assertGt(got, 0, "the deployed router filled a buy through a fixed-inventory name");
        assertEq(IERC20(PROBETWO).balanceOf(trader), got, "and the coin reached the buyer");

        ZapRouter.Hop[] memory p = path();
        ZapRouter.Hop[] memory back = new ZapRouter.Hop[](3);
        back[0] = p[2];
        back[1] = p[1];
        back[2] = p[0];

        vm.startPrank(trader);
        IERC20(PROBETWO).approve(LIVE_ZAP_ROUTER, got);
        uint256 out = r.zapSell(
            ZapRouter.ZapSellParams({
                token: PROBETWO, amountIn: got, path: back, tokenOut: address(0),
                minOut: 1, recipient: trader, deadline: block.timestamp + 300
            })
        );
        vm.stopPrank();

        console.log("SELL all of it ->");
        console.log(out);
        assertGt(out, 0, "and it filled the sell back out to ether");
        assertEq(IERC20(PROBETWO).balanceOf(trader), 0, "the whole position was sold");
        assertEq(IERC20(TESTNAME).balanceOf(LIVE_ZAP_ROUTER), 0, "no name was stranded in the router");
        assertEq(IERC20(USDG).balanceOf(LIVE_ZAP_ROUTER), 0, "no dollars were stranded either");

        uint256 roundTripBps = ((0.01 ether - out) * 10_000) / 0.01 ether;
        console.log("round trip cost, bps:");
        console.log(roundTripBps);
        assertLt(roundTripBps, 1_000, "and the cost is a fee, not a failure");
        assertGt(trader.balance, ethBefore - 0.01 ether, "ether came back");
    }
}
