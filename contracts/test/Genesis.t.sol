// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {TokenParams} from "../src/Types.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Genesis, as the script does it: FUN invented, TICKR launched under it with a 2% creator tax, the disclosed 5% bought
/// in the same transaction, sized by a throwaway simulation, and exactly that share handed to the treasury wallet.
contract GenesisTest is BaseTest {
    address treasury = makeAddr("treasury");

    function _params() internal view returns (TokenParams memory p) {
        (,, bytes32 expected,) = tickers.previewLaunch("FUN", 0);
        p = defaultParams(address(0), 200);
        p.name = "tickr";
        p.symbol = "TICKR";
        p.creatorFeeRecipient = treasury;
        p.expectedEconomics = expected;
        p.salt = keccak256("genesis");
    }

    /// one attempt, thrown away: `eth` into dollars, every dollar into the launch-and-buy
    function _attempt(uint256 eth, uint256 fees) internal returns (uint256 usdgGot, uint256 out) {
        uint256 s = vm.snapshotState();
        uint256 before = usdg.balanceOf(creator);
        vm.startPrank(creator);
        seeder.swapExactIn{value: eth}(ethUsdgKey, true, eth, 0, creator);
        usdgGot = usdg.balanceOf(creator) - before;
        usdg.approve(address(tickers), usdgGot);
        (,,, out) = tickers.launchAndBuy{value: fees}("FUN", _params(), 0, usdgGot, 0);
        vm.stopPrank();
        vm.revertToState(s);
    }

    function test_genesis_buysFivePercent_withTwoPercentTax() public {
        uint256 fees = LAUNCH_FEE + tickers.NEW_TICKER_FEE();
        uint256 target = (SUPPLY * 500) / 10_000;
        vm.deal(creator, 100 ether);
        // the search the script runs: the ETH whose dollars buy the share
        uint256 lo = 0.0005 ether;
        uint256 hi = 2 ether;
        for (uint256 i; i < 20; i++) {
            uint256 mid = (lo + hi) / 2;
            (, uint256 out) = _attempt(mid, fees);
            if (out < target) lo = mid;
            else hi = mid;
        }
        (uint256 usdgIn, uint256 coins) = _attempt(hi, fees);
        assertGe(coins, target, "the sized buy reaches the share");
        // the real thing: swap with a margin, launch and buy in one transaction, exactly the share to the treasury
        uint256 ethSwap = (hi * 10_500) / 10_000;
        vm.startPrank(creator);
        seeder.swapExactIn{value: ethSwap}(ethUsdgKey, true, ethSwap, usdgIn, creator);
        usdg.approve(address(tickers), usdgIn);
        (, address tickr,, uint256 got) = tickers.launchAndBuy{value: fees}("FUN", _params(), 0, usdgIn, (target * 99) / 100);
        IERC20(tickr).transfer(treasury, got < target ? got : target);
        vm.stopPrank();
        assertEq(factory.getLaunchedToken(tickr).creatorTaxBps, 200, "a 2% creator tax");
        assertEq(factory.getLaunchedToken(tickr).poolFee, 30_000, "a 3% pool fee, 1% base plus the tax");
        assertEq(factory.creatorFeeRecipientOf(tickr), treasury, "the tax goes to the treasury wallet");
        assertEq(IERC20(tickr).balanceOf(treasury), target, "exactly five percent of supply at the treasury");
        assertEq(IERC20(tickr).balanceOf(Token(tickr).DEAD()), 0, "the launcher's own buy paid no snipe tax");
        assertTrue(got >= target && got - target < target / 1_000, "the search overshoots by crumbs at most");
    }
}
