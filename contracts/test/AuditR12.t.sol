// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {TickerToken} from "../src/TickerToken.sol";
import {BuybackTreasury} from "../src/BuybackTreasury.sol";
import {ILaunchSeeder} from "../src/interfaces/ILaunchSeeder.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {IFeeEscrow} from "../src/interfaces/IFeeEscrow.sol";
import {TokenParams, FeePolicy} from "../src/Types.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/src/libraries/FixedPoint96.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {MockERC20} from "./mocks/MockUSDG.sol";
import {NarrowLP} from "./AuditR11.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// The r12 audit round: the plain swap's minimum is a quantity a cut-short fill cannot satisfy, the bounded swap's is a
/// price held on what the pool took; the treasury turns ETH into dollars at most once per interval.
contract AuditR12Test is BaseTest {
    address team = makeAddr("team");

    /// A pool that runs dry: one narrow position between USDG and a mock, so a swap bigger than it stops short.
    function _narrowPool() internal returns (PoolKey memory key, bool usdgIs0, MockERC20 foo, NarrowLP lp) {
        foo = new MockERC20("Foo", "FOO", 6);
        usdgIs0 = address(usdg) < address(foo);
        key = PoolKey(Currency.wrap(usdgIs0 ? address(usdg) : address(foo)), Currency.wrap(usdgIs0 ? address(foo) : address(usdg)), 3000, 60, IHooks(address(0)));
        poolManager.initialize(key, uint160(FixedPoint96.Q96)); // one for one
        lp = new NarrowLP(poolManager);
        usdg.mint(address(lp), 1_000e6);
        foo.mint(address(lp), 1_000e6);
        // a thousand of each in a band two spacings wide on either side of the price
        uint160 sl = TickMath.getSqrtPriceAtTick(-120);
        uint160 su = TickMath.getSqrtPriceAtTick(120);
        uint256 l0 = FullMath.mulDiv(FullMath.mulDiv(1_000e6, uint160(FixedPoint96.Q96), FixedPoint96.Q96), su, su - uint160(FixedPoint96.Q96));
        uint256 l1 = FullMath.mulDiv(1_000e6, FixedPoint96.Q96, uint160(FixedPoint96.Q96) - sl);
        lp.add(key, -120, 120, uint128((l0 < l1 ? l0 : l1) * 99 / 100));
    }

    function test_r12_plainSwapMinimumIsAQuantity() public {
        (PoolKey memory key, bool usdgIs0, MockERC20 foo,) = _narrowPool();
        usdg.mint(alice, 5_000e6);
        uint256 start = usdg.balanceOf(alice);
        // a swap far bigger than the band: the pool runs dry and the seeder refunds the rest
        uint256 snap = vm.snapshotState();
        vm.startPrank(alice);
        usdg.approve(address(seeder), 5_000e6);
        uint256 out = seeder.swapExactIn(key, usdgIs0, 5_000e6, 0, alice);
        vm.stopPrank();
        uint256 refunded = usdg.balanceOf(alice) - (start - 5_000e6);
        vm.revertToState(snap);
        assertGt(refunded, 0, "the pool ran dry: part of the input came back");
        assertEq(foo.balanceOf(alice), 0);
        // a minimum set for the whole input, at the price the pool gave, is more than a cut-short fill delivers
        uint256 minForAll = out + 1;
        vm.startPrank(alice);
        usdg.approve(address(seeder), 5_000e6);
        vm.expectRevert(ILaunchSeeder.Slippage.selector);
        seeder.swapExactIn(key, usdgIs0, 5_000e6, minForAll, alice);
        assertEq(foo.balanceOf(alice), 0, "nothing moved");
        assertEq(usdg.balanceOf(alice), start, "and nothing was taken");
        // the bounded swap, asked for the same minimum for the whole input, holds it pro rata on what the pool took
        uint256 got = seeder.swapExactInBounded(key, usdgIs0, 5_000e6, minForAll, alice, usdgIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
        vm.stopPrank();
        assertEq(got, out, "the same fill, accepted as the price it is");
        assertEq(usdg.balanceOf(alice), start - 5_000e6 + refunded, "the rest refunded");
    }

    function test_r12_treasury_ethConversionOncePerInterval() public {
        BuybackTreasury treasury = new BuybackTreasury(IFactory(address(factory)), IFeeEscrow(address(escrow)), seeder, IERC20(address(usdg)), team);
        vm.deal(address(this), 10 ether);
        escrow.credit{value: 1 ether}(address(treasury));
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdg);
        treasury.collect(tokens);
        assertEq(address(treasury).balance, 0, "the first collect converts");
        assertEq(treasury.lastEthAt(), vm.getBlockTimestamp());
        escrow.credit{value: 1 ether}(address(treasury));
        uint256 teamBefore = usdg.balanceOf(team);
        treasury.collect(tokens);
        assertEq(address(treasury).balance, 1 ether, "inside the interval the ETH waits");
        assertEq(usdg.balanceOf(team), teamBefore, "and nothing was converted");
        vm.warp(vm.getBlockTimestamp() + treasury.MIN_INTERVAL());
        treasury.collect(tokens);
        assertEq(address(treasury).balance, 0, "after the interval it converts");
        assertGt(usdg.balanceOf(team), teamBefore);
    }
}
