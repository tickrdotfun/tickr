// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fork} from "./Fork.sol";
import {console} from "forge-std/console.sol";

interface ILocker {
    function collectFees(address token) external returns (uint256 quoteOut, uint256 coinOut);
    function pendingFees(address token) external view returns (uint256 quoteOut, uint256 coinOut);
}

interface ITreasury {
    function collect(address[] calldata tokens) external returns (uint256 usdgTotal, uint256 toTeam, uint256 earmarked);
    function buy() external;
    function earmarkedUsdg() external view returns (uint256);
    function nextBuyAt() external view returns (uint256);
}

/// @notice The keeper's three calls, run on a fork with the keeper's own wallet funded.
///
/// On the live chain all three refuse before sending, because the wallet cannot afford the gas. That hides
/// whatever else may be wrong with them: an estimate against an account with no balance fails for that reason
/// alone. Funding the same account on a fork separates "cannot pay" from "would not work".
contract KeeperCycleForkTest is Test {
    address constant KEEPER = 0xE5dCf1B0eFb89A9F5D681318620120dA59537E1e;
    address constant LOCKER = 0xDfD29cB10Ff0491CdF7896F75e54f4357F4a42b8;
    address constant TREASURY = 0x60C1276ff7fEB5bC15f6f05C23D9de12fa0E72BA;
    address constant TICKR = 0x51d553Efd2E8D772AEe6d602A9ea26C56c9a6942;
    address constant FUN = 0xF9d30A05A63d795e3eF37b34143f33b2cBEf0f14;

    bool forked;

    function setUp() public {
        forked = Fork.select();
        if (forked) vm.deal(KEEPER, 1 ether); // adequately funded, which the live wallet is not
    }

    function test_fork_theKeepersThreeCallsWithGasToSpend() public {
        if (!forked) return;
        console.log("keeper balance on the fork (wei):");
        console.log(KEEPER.balance);

        (uint256 pq, uint256 pc) = ILocker(LOCKER).pendingFees(TICKR);
        console.log("pendingFees(TICKR): quote / coin");
        console.log(pq);
        console.log(pc);

        // 1. collectFees
        uint256 g = gasleft();
        vm.prank(KEEPER);
        try ILocker(LOCKER).collectFees(TICKR) returns (uint256 q, uint256 c) {
            console.log("collectFees OK, gas / quote / coin:");
            console.log(g - gasleft());
            console.log(q);
            console.log(c);
        } catch (bytes memory err) {
            console.log("collectFees REVERTED:");
            console.logBytes(err);
        }

        // 2. treasury.collect
        address[] memory names = new address[](1);
        names[0] = FUN;
        g = gasleft();
        vm.prank(KEEPER);
        try ITreasury(TREASURY).collect(names) returns (uint256 total, uint256 team, uint256 ear) {
            console.log("treasury.collect OK, gas / total / team / earmarked:");
            console.log(g - gasleft());
            console.log(total);
            console.log(team);
            console.log(ear);
        } catch (bytes memory err) {
            console.log("treasury.collect REVERTED:");
            console.logBytes(err);
        }

        // 3. treasury.buy
        console.log("earmarked / nextBuyAt / now:");
        console.log(ITreasury(TREASURY).earmarkedUsdg());
        console.log(ITreasury(TREASURY).nextBuyAt());
        console.log(block.timestamp);
        g = gasleft();
        vm.prank(KEEPER);
        try ITreasury(TREASURY).buy() {
            console.log("treasury.buy OK, gas:");
            console.log(g - gasleft());
        } catch (bytes memory err) {
            console.log("treasury.buy REVERTED:");
            console.logBytes(err);
        }
    }
}
