// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {TickerToken} from "../src/TickerToken.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {TokenParams} from "../src/Types.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// One transaction from ETH to any coin, through its pool and whatever pools lead to it, and back.
contract ZapTest is BaseTest {
    function _v4(PoolKey memory key) internal pure returns (ZapRouter.Hop memory) {
        return ZapRouter.Hop({kind: 0, key: key, pool: address(0)});
    }

    function _wrapHop(address ticker) internal pure returns (ZapRouter.Hop memory h) {
        PoolKey memory none;
        return ZapRouter.Hop({kind: 2, key: none, pool: ticker});
    }

    function _buyParams(address token, address tokenIn, uint256 amountIn, ZapRouter.Hop[] memory path, address to)
        internal
        view
        returns (ZapRouter.ZapParams memory)
    {
        return ZapRouter.ZapParams({token: token, tokenIn: tokenIn, amountIn: amountIn, path: path, minTokensOut: 0, recipient: to, deadline: vm.getBlockTimestamp() + 1 hours});
    }

    function test_zap_ethIntoAnEthCoin_isOneHop() public {
        (Token token,) = launchNative(creator);
        ZapRouter.Hop[] memory path = new ZapRouter.Hop[](1);
        path[0] = _v4(factory.poolKeyOf(address(token)));
        vm.prank(alice);
        uint256 out = zap.zapBuy{value: 1 ether}(_buyParams(address(token), address(0), 0, path, alice));
        assertGt(out, 0);
        assertEq(token.balanceOf(alice), out);
        assertEq(address(zap).balance, 0, "the zap keeps nothing");
    }

    function test_zap_ethIntoACoinUnderAnInventedTicker() public {
        (,, bytes32 expected,) = tickers.previewLaunch("BANANA", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        uint256 value = LAUNCH_FEE + tickers.NEW_TICKER_FEE();
        vm.prank(creator);
        (address banana, address bread,) = tickers.launch{value: value}("BANANA", p, 0);
        pastTheWindow();
        // ETH -> USDG (the live pool) -> BANANA (wrap, one for one) -> BREAD (its pool)
        ZapRouter.Hop[] memory path = new ZapRouter.Hop[](3);
        path[0] = _v4(ethUsdgKey);
        path[1] = _wrapHop(banana);
        path[2] = _v4(factory.poolKeyOf(bread));
        vm.prank(alice);
        uint256 out = zap.zapBuy{value: 0.5 ether}(_buyParams(bread, address(0), 0, path, alice));
        assertGt(out, 0);
        assertEq(Token(bread).balanceOf(alice), out);
        assertEq(IERC20(banana).balanceOf(address(zap)), 0);
        assertEq(usdg.balanceOf(address(zap)), 0);
        // and back to ETH: BREAD -> BANANA -> USDG (unwrap) -> ETH
        ZapRouter.Hop[] memory back = new ZapRouter.Hop[](3);
        back[0] = _v4(factory.poolKeyOf(bread));
        back[1] = _wrapHop(banana);
        back[2] = _v4(ethUsdgKey);
        uint256 ethBefore = alice.balance;
        vm.startPrank(alice);
        Token(bread).approve(address(zap), out);
        uint256 got = zap.zapSell(ZapRouter.ZapSellParams({token: bread, amountIn: out, path: back, tokenOut: address(0), minOut: 0, recipient: alice, deadline: vm.getBlockTimestamp() + 1 hours}));
        vm.stopPrank();
        assertGt(got, 0);
        assertEq(alice.balance - ethBefore, got);
        assertEq(Token(bread).balanceOf(alice), 0);
    }

    function test_zap_previewMatchesExecution() public {
        (Token token,) = launchNative(creator);
        ZapRouter.Hop[] memory path = new ZapRouter.Hop[](1);
        path[0] = _v4(factory.poolKeyOf(address(token)));
        ZapRouter.ZapParams memory p = _buyParams(address(token), address(0), 0, path, alice);
        uint256 previewed;
        vm.prank(alice);
        try zap.previewZap{value: 1 ether}(p) {
            revert("preview must revert");
        } catch (bytes memory reason) {
            (, previewed) = abi.decode(_strip(reason), (uint256, uint256));
        }
        vm.prank(alice);
        uint256 out = zap.zapBuy{value: 1 ether}(p);
        assertEq(out, previewed, "what the preview said is what the buy got");
    }

    function test_zap_badPathReverts() public {
        (Token token,) = launchNative(creator);
        (Token other,) = launchNative(alice);
        ZapRouter.Hop[] memory path = new ZapRouter.Hop[](1);
        path[0] = _v4(factory.poolKeyOf(address(other)));
        vm.prank(alice);
        vm.expectRevert(ZapRouter.BadPath.selector);
        zap.zapBuy{value: 1 ether}(_buyParams(address(token), address(0), 0, path, alice));
    }

    function test_zap_expiredReverts() public {
        (Token token,) = launchNative(creator);
        ZapRouter.Hop[] memory path = new ZapRouter.Hop[](1);
        path[0] = _v4(factory.poolKeyOf(address(token)));
        ZapRouter.ZapParams memory p = _buyParams(address(token), address(0), 0, path, alice);
        p.deadline = vm.getBlockTimestamp() - 1;
        vm.prank(alice);
        vm.expectRevert(ZapRouter.Expired.selector);
        zap.zapBuy{value: 1 ether}(p);
    }

    function _strip(bytes memory reason) internal pure returns (bytes memory data) {
        // the Preview(uint256,uint256) error: skip the 4 byte selector
        data = new bytes(reason.length - 4);
        for (uint256 i; i < data.length; i++) {
            data[i] = reason[i + 4];
        }
    }

    /// The coin under a ticker can sort after its wrapper (currency1). A fresh one, never bought, opens with its
    /// position at the price's edge: the first buy, through the zap, must still fill.
    function test_zap_freshCoinThatSortsAfterItsWrapper_firstBuyThroughTheZap() public {
        (,, bytes32 expected,) = tickers.previewLaunch("BANANA", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        uint256 value = LAUNCH_FEE + tickers.NEW_TICKER_FEE();
        vm.prank(creator);
        (address banana,,) = tickers.launch{value: value}("BANANA", p, 0);
        pastTheWindow();
        // launch coins under BANANA until one sorts after the wrapper
        address coin;
        for (uint256 i; i < 12 && coin == address(0); i++) {
            (,, bytes32 e,) = tickers.previewLaunch("BANANA", 0);
            TokenParams memory q = defaultParams(address(0), 0);
            q.expectedEconomics = e;
            q.salt = keccak256(abi.encodePacked("c1-hunt", i));
            vm.prank(alice);
            (, address t,) = tickers.launch{value: LAUNCH_FEE}("BANANA", q, 0);
        pastTheWindow();
            if (t > banana) coin = t;
        }
        assertTrue(coin != address(0), "found a coin that is currency1");
        ZapRouter.Hop[] memory path = new ZapRouter.Hop[](3);
        path[0] = _v4(ethUsdgKey);
        path[1] = _wrapHop(banana);
        path[2] = _v4(factory.poolKeyOf(coin));
        vm.prank(bob);
        uint256 out = zap.zapBuy{value: 0.2 ether}(_buyParams(coin, address(0), 0, path, bob));
        assertGt(out, 0, "the first buy of a currency1 coin fills through the zap");
    }
}
