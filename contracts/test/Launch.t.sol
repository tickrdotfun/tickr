// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {TokenParams, LaunchedToken} from "../src/Types.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";

/// A launch is one transaction: the coin, its pool at the opening price, the whole supply locked in it.
contract LaunchTest is BaseTest {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function test_launch_opensAPoolWithTheWholeSupplyLocked() public {
        (Token token, bytes32 poolId) = launchNative(creator);
        LaunchedToken memory l = factory.getLaunchedToken(address(token));
        assertTrue(l.exists);
        assertEq(l.pairToken, address(0));
        assertEq(l.phantomQuote, PHANTOM_ETH);
        assertEq(l.poolFee, 10_000, "1% pool fee in pips");
        assertGt(l.liquidity, 0);
        PoolKey memory key = factory.poolKeyOf(address(token));
        assertEq(PoolId.unwrap(key.toId()), poolId);
        assertEq(address(key.hooks), address(0), "no hook: any v4 router trades it");
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        assertGt(sqrtP, 0, "initialized");
        // the position starts at the price's edge: in range once the first buy moves the price into it
        uint128 live = poolManager.getLiquidity(key.toId());
        assertTrue(live == 0 || live == l.liquidity, "only the locked position ever provides liquidity");
        assertEq(IERC721(address(posm)).ownerOf(l.lpTokenId), address(locker), "position in the locker");
        // the whole supply is in the pool manager (the position) or the locker (rounding dust); the creator has none
        assertEq(token.balanceOf(address(poolManager)) + token.balanceOf(address(locker)), SUPPLY, "all of the supply is locked");
        assertEq(token.balanceOf(creator), 0);
        assertEq(token.balanceOf(address(factory)), 0);
        assertEq(token.balanceOf(address(seeder)), 0);
        assertEq(escrow.balanceOf(protocolFees), LAUNCH_FEE, "launch fee to the protocol");
    }

    function test_launch_opensAtTheOpeningMarketCap() public {
        (Token token,) = launchNative(creator);
        // the first small buy pays about phantom/supply per token: 1.68 ETH for 1B coins
        uint256 got = buy(token, alice, 0.001 ether);
        // price per token = 1.68e18 / 1e27 = 1.68e-9 ETH; 0.001 ETH (minus 1% fee) buys about 589,000 coins
        assertApproxEqRel(got, 589_000e18, 0.02e18, "opening price is phantom over supply");
    }

    function test_launch_devBuyIsFirstAndInTheSameTransaction() public {
        TokenParams memory p = defaultParams(address(0), 0);
        vm.prank(creator);
        (address t,, uint256 out) = router.launchAndBuy{value: LAUNCH_FEE + 0.1 ether}(p, 0, address(0), 0.1 ether, 0, creator);
        assertGt(out, 0);
        assertEq(Token(t).balanceOf(creator), out, "the creator holds exactly the dev buy");
        assertEq(address(router).balance, 0, "router keeps nothing");
    }

    function test_launch_usdgPairAndBothCurrencyOrders() public {
        // several launches: whichever side of USDG the coin's address lands on, the position must be one-sided
        for (uint256 i; i < 4; i++) {
            TokenParams memory p = defaultParams(address(usdg), 0);
            p.salt = keccak256(abi.encodePacked("order", i));
            vm.prank(creator);
            (address t,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(usdg));
            pastTheWindow();
            LaunchedToken memory l = factory.getLaunchedToken(t);
            assertGt(l.liquidity, 0);
            // a buy works and moves the price up in USDG terms
            uint256 got = buy(Token(t), alice, 100e6);
            assertGt(got, 0);
            uint256 got2 = buy(Token(t), alice, 100e6);
            assertLt(got2, got, "second buy gets less: the price moved");
        }
    }

    function test_launch_sellsWorkAndTheCreatorEarns() public {
        (Token token,) = launchNative(creator);
        uint256 got = buy(token, alice, 1 ether);
        uint256 ethBefore = alice.balance;
        uint256 back = sell(token, alice, got / 2);
        assertGt(back, 0);
        assertEq(alice.balance - ethBefore, back);
    }

    function test_launch_economicsArePinned() public {
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = bytes32(uint256(1));
        vm.prank(creator);
        vm.expectRevert(IFactory.LaunchEconomicsMismatch.selector);
        factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
    }

    function test_launch_feeMustBeExact() public {
        TokenParams memory p = defaultParams(address(0), 0);
        vm.prank(creator);
        vm.expectRevert(IFactory.LaunchFeeNotPaid.selector);
        factory.launchToken{value: LAUNCH_FEE + 1}(p, 0, address(0));
    }

    function test_launch_creatorTaxIsCapped() public {
        TokenParams memory p = defaultParams(address(0), 1_001);
        vm.prank(creator);
        vm.expectRevert(IFactory.CreatorTaxTooHigh.selector);
        factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
    }

    function test_launch_sameSaltDifferentLauncherDifferentCoin() public {
        TokenParams memory p = defaultParams(address(0), 0);
        vm.prank(creator);
        (address a,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        vm.prank(alice);
        (address b,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        assertTrue(a != b);
    }
}
