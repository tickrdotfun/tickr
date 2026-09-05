// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {TickerLauncher} from "../../src/TickerLauncher.sol";
import {LaunchSeeder} from "../../src/LaunchSeeder.sol";
import {TokenParams} from "../../src/Types.sol";

/// @dev Runs one sizing attempt as the deployer, in the simulation only. It lives outside the script contract so
/// that a failing attempt can be caught: a probe the dollar pool cannot absorb reverts, and must count as too much.
contract GenesisSizer {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev `eth` into dollars, every dollar into the launch-and-buy, as the deployer.
    function attempt(
        LaunchSeeder seeder,
        TickerLauncher tickers,
        address usdg,
        PoolKey memory ethUsdg,
        TokenParams memory p,
        uint256 fees,
        uint256 eth,
        address me
    ) external returns (uint256 usdgGot, uint256 out) {
        uint256 before = IERC20(usdg).balanceOf(me);
        vm.prank(me);
        seeder.swapExactIn{value: eth}(ethUsdg, true, eth, 0, me);
        usdgGot = IERC20(usdg).balanceOf(me) - before;
        vm.prank(me);
        IERC20(usdg).approve(address(tickers), usdgGot);
        vm.prank(me);
        (,,, out) = tickers.launchAndBuy{value: fees}("FUN", p, 0, usdgGot, 0);
    }
}
