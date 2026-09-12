// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {Fork} from "./Fork.sol";
import {V1Withdrawal, Runner} from "../script/WithdrawV1.s.sol";
import {BuybackTreasuryV2} from "../src/market/BuybackTreasuryV2.sol";

interface IERC721Like {
    function ownerOf(uint256) external view returns (address);
    function transferFrom(address, address, uint256) external;
}

/// @notice The v1 withdrawal exactly as the script runs it, against the live positions: the owner hands the two
/// positions over, the runner burns them, burns the coin, redeems the dollars and puts them into the HOLY treasury.
contract WithdrawV1ForkTest is Test {
    address constant POSM = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address constant TICKR = 0x51d553Efd2E8D772AEe6d602A9ea26C56c9a6942;
    address constant FUN = 0xF9d30A05A63d795e3eF37b34143f33b2cBEf0f14;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant TREASURY = 0x29d6427dc78b9B405DFAA118A9D634cE4CEf73f4;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// the wallet the owner hands the positions to and that runs the withdrawal: on the day, the deployer
    address constant BURNER = address(0xB0B);

    function test_fork_theTwoPositionsBecomeAshAndDollarsInTheTreasury() public {
        if (!Fork.select()) return;
        uint256[] memory ids = new uint256[](2);
        ids[0] = 2135484;
        ids[1] = 2139558;
        // whoever holds the positions hands them to the wallet that will run the withdrawal
        for (uint256 i; i < 2; i++) {
            address holder = IERC721Like(POSM).ownerOf(ids[i]);
            if (holder != BURNER) {
                vm.prank(holder);
                IERC721Like(POSM).transferFrom(holder, BURNER, ids[i]);
            }
        }

        uint256 deadBefore = IERC20(TICKR).balanceOf(DEAD);
        uint256 supplyBefore = IERC20(FUN).totalSupply();
        uint256 treasuryUsdgBefore = IERC20(USDG).balanceOf(TREASURY);
        uint256 earmarkBefore = BuybackTreasuryV2(payable(TREASURY)).earmarkedUsdg();
        uint256 burnerUsdg = IERC20(USDG).balanceOf(BURNER);
        uint256 burnerTickr = IERC20(TICKR).balanceOf(BURNER);

        vm.startPrank(BURNER);
        Runner r = new Runner();
        IERC721Like(POSM).transferFrom(BURNER, address(r), ids[0]);
        IERC721Like(POSM).transferFrom(BURNER, address(r), ids[1]);
        V1Withdrawal.Out memory o = r.go(IPositionManager(POSM), ids, TICKR, FUN, USDG, TREASURY);
        vm.stopPrank();

        assertGt(o.tickrBurned, 150_000_000e18, "about 151.5M TICKR came out");
        assertEq(IERC20(TICKR).balanceOf(DEAD) - deadBefore, o.tickrBurned, "all of it burned");
        assertGt(o.funRedeemed, 200e6, "a couple of hundred dollars of FUN");
        assertEq(supplyBefore - IERC20(FUN).totalSupply(), o.funRedeemed, "the FUN was redeemed, not kept");
        assertEq(o.usdgSent, o.funRedeemed, "a dollar for a dollar");
        // the treasury counted them: what it holds beyond the earmark went to the team, the rest was earmarked
        uint256 earmarkGain = BuybackTreasuryV2(payable(TREASURY)).earmarkedUsdg() - earmarkBefore;
        assertGt(earmarkGain, 0);
        assertLe(earmarkGain, o.usdgSent);
        assertEq(IERC20(USDG).balanceOf(TREASURY) - treasuryUsdgBefore, earmarkGain, "the treasury keeps only the earmark");
        // the runner and the burner keep nothing
        assertEq(IERC20(TICKR).balanceOf(address(r)), 0);
        assertEq(IERC20(FUN).balanceOf(address(r)), 0);
        assertEq(IERC20(USDG).balanceOf(address(r)), 0);
        assertEq(IERC20(USDG).balanceOf(BURNER), burnerUsdg);
        assertEq(IERC20(TICKR).balanceOf(BURNER), burnerTickr);
        vm.expectRevert();
        IERC721Like(POSM).ownerOf(ids[0]);
    }
}
