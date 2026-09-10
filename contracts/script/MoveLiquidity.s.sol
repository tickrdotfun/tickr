// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {ILaunchSeeder} from "../src/interfaces/ILaunchSeeder.sol";
import {ManagedTickerToken} from "../src/ManagedTickerToken.sol";
import {LpHelper} from "./AddLiquidity.s.sol";

interface IERC721Owner {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice Moves a position the broadcaster owns to a new band from the current price up: burn it, take the coins
/// (and any dollars it earned, which go to the owner), place the coins again with LpHelper, position to the owner.
/// env: LP_TOKEN_ID, BAND_BPS (default 5000), LP_OWNER
contract MoveLiquidity is Script {
    using stdJson for string;

    function run() external {
        string memory j = vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        ILaunchSeeder seeder = ILaunchSeeder(j.readAddress(".launchSeeder"));
        IPoolManager pm = IPoolManager(j.readAddress(".poolManager"));
        IPositionManager posm = IPositionManager(j.readAddress(".positionManager"));
        IAllowanceTransfer permit2 = IAllowanceTransfer(j.readAddress(".permit2"));
        address coin = j.readAddress(".genesisToken");
        address name = j.readAddress(".genesisTicker");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        uint256 tokenId = vm.envUint("LP_TOKEN_ID");
        uint256 bandBps = vm.envOr("BAND_BPS", uint256(5_000));
        address owner = vm.envOr("LP_OWNER", me);
        require(IERC721Owner(address(posm)).ownerOf(tokenId) == me, "not the owner of that position");

        PoolKey memory ethUsdg;
        (ethUsdg.currency0, ethUsdg.currency1, ethUsdg.fee, ethUsdg.tickSpacing, ethUsdg.hooks) = seeder.ethUsdgKey();
        PoolKey memory namePool = ManagedTickerToken(name).poolKey();
        PoolKey memory coinPool = PoolKey({currency0: Currency.wrap(coin), currency1: Currency.wrap(name), fee: 30_000, tickSpacing: 10, hooks: IHooks(address(0))});
        int24 bandTicks = int24(int256((bandBps * 10_000) / 10_970));

        uint256 coinBefore = IERC20(coin).balanceOf(me);
        uint256 nameBefore = IERC20(name).balanceOf(me);
        vm.startBroadcast(pk);
        // 1. burn the position and take both sides
        bytes memory actions = abi.encodePacked(uint8(Actions.BURN_POSITION), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(coinPool.currency0, coinPool.currency1, me);
        posm.modifyLiquidities(abi.encode(actions, params), block.timestamp + 600);
        uint256 coins = IERC20(coin).balanceOf(me) - coinBefore;
        uint256 dollars = IERC20(name).balanceOf(me) - nameBefore;
        console.log("  withdrawn: coin", coins, "name", dollars);
        // 2. what it earned in the name goes to the owner; the coins go back in, higher
        if (dollars > 0) IERC20(name).transfer(owner, dollars);
        LpHelper h = new LpHelper();
        IERC20(coin).transfer(address(h), coins);
        (uint256 id, uint256 usedCoin,) = h.add(seeder, pm, posm, permit2, ethUsdg, namePool, coinPool, 0, coins, 0, bandTicks, owner);
        vm.stopBroadcast();
        console.log("  placed again: coin", usedCoin, "band bps", bandBps);
        console.log("  new position (id read before the mint, may be later)", id);
    }
}
