// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {V4Seeder} from "../src/libraries/V4Seeder.sol";
import {ILaunchSeeder} from "../src/interfaces/ILaunchSeeder.sol";
import {ManagedTickerToken} from "../src/ManagedTickerToken.sol";

/// @notice Holds the tokens for the three steps of one liquidity add, then hands the position and every leftover to
/// the owner. A script contract cannot read its own balances, so the work lives here, as in the rehearsal seeder.
contract LpHelper {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    receive() external payable {}

    /// @param ethIn ETH to turn into dollars, then into the name, and place below the price (sells land on it)
    /// @param coinIn coins already transferred here, placed above the price (buys land on them); zero for dollars only
    /// @param nameIn dollars of the name already transferred here, added to whatever `ethIn` produces
    /// @param bandTicks how far the band reaches on each side of the price, in ticks (about 1,823 per 20%)
    function add(
        ILaunchSeeder seeder,
        IPoolManager pm,
        IPositionManager posm,
        IAllowanceTransfer permit2,
        PoolKey memory ethUsdg,
        PoolKey memory namePool,
        PoolKey memory coinPool,
        uint256 ethIn,
        uint256 coinIn,
        uint256 nameIn,
        int24 bandTicks,
        address owner
    ) external payable returns (uint256 tokenId, uint256 usedCoin, uint256 usedName) {
        require(msg.value == ethIn, "value");
        address usdg = Currency.unwrap(ethUsdg.currency1);
        address name = Currency.unwrap(coinPool.currency1);
        // 1. ETH -> dollars, 2. dollars -> the name, through its own pool
        uint256 nameGot = nameIn;
        if (ethIn > 0) {
            uint256 dollars = seeder.swapExactIn{value: ethIn}(ethUsdg, true, ethIn, 1, address(this));
            IERC20(usdg).approve(address(seeder), dollars);
            bool usdgIs0 = Currency.unwrap(namePool.currency0) == usdg;
            nameGot += seeder.swapExactIn(namePool, usdgIs0, dollars, 1, address(this));
        }
        // 3. the band around the price; ticks aligned to the pool's spacing
        (, int24 tick,,) = pm.getSlot0(coinPool.toId());
        int24 sp = coinPool.tickSpacing;
        int24 at = (tick / sp) * sp;
        if (tick < 0 && at != tick) at -= sp; // floor, not truncation, for a negative tick
        // a one-sided band sits entirely on its side of the price: coins only above it (buys land on them), dollars
        // only below it (sells land on them); with both, the band straddles the price
        int24 lower;
        int24 upper;
        if (coinIn > 0 && nameGot == 0) {
            lower = at + sp;
            upper = at + bandTicks;
        } else if (coinIn == 0) {
            lower = at - bandTicks;
            upper = at;
        } else {
            lower = at - bandTicks;
            upper = at + bandTicks;
        }
        lower = (lower / sp) * sp;
        upper = (upper / sp) * sp;
        (uint160 sqrtP,,,) = pm.getSlot0(coinPool.toId());
        (tokenId, usedCoin, usedName) = V4Seeder.seedRange(posm, permit2, coinPool, sqrtP, lower, upper, coinIn, nameGot, owner);
        console.log("  position id", tokenId);
        console.logInt(int256(lower));
        console.logInt(int256(upper));
        console.log("  placed: coin", usedCoin, "name", usedName);
        // leftovers go back to the owner
        uint256 c = IERC20(Currency.unwrap(coinPool.currency0)).balanceOf(address(this));
        if (c > 0) IERC20(Currency.unwrap(coinPool.currency0)).transfer(owner, c);
        uint256 n = IERC20(name).balanceOf(address(this));
        if (n > 0) IERC20(name).transfer(owner, n);
        uint256 u = IERC20(usdg).balanceOf(address(this));
        if (u > 0) IERC20(usdg).transfer(owner, u);
        if (address(this).balance > 0) payable(owner).transfer(address(this).balance);
    }
}

/// @notice A concentrated position on the official coin's pool, the ordinary kind that trackers count and that
/// keeps a large trade from moving the price: dollars below the price, coins above it. Anyone may add liquidity to
/// a tickr pool; this is one way to do it in one broadcast.
///
/// env: LP_ETH (wei, dollars side), LP_COIN (wei of the coin held by the broadcaster, buy side; 0 for dollars only),
///      BAND_BPS (default 2000: twenty percent each side), LP_OWNER (who receives the position; default the broadcaster)
/// forge script script/AddLiquidity.s.sol --tc AddLiquidity --rpc-url $RPC --broadcast --slow
contract AddLiquidity is Script {
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
        uint256 ethIn = vm.envOr("LP_ETH", uint256(0));
        uint256 coinIn = vm.envOr("LP_COIN", uint256(0));
        uint256 nameIn = vm.envOr("LP_NAME", uint256(0));
        uint256 bandBps = vm.envOr("BAND_BPS", uint256(2_000));
        address owner = vm.envOr("LP_OWNER", me);
        require(ethIn > 0 || coinIn > 0 || nameIn > 0, "nothing to add");
        require(coin < name, "the coin must be currency0"); // TICKR sorts below FUN by construction

        PoolKey memory ethUsdg;
        (ethUsdg.currency0, ethUsdg.currency1, ethUsdg.fee, ethUsdg.tickSpacing, ethUsdg.hooks) = seeder.ethUsdgKey();
        PoolKey memory namePool = ManagedTickerToken(name).poolKey();
        PoolKey memory coinPool = PoolKey({currency0: Currency.wrap(coin), currency1: Currency.wrap(name), fee: 30_000, tickSpacing: 10, hooks: IHooks(address(0))});
        // ticks per side: ln(1 + bps/10000) / ln(1.0001); 2,000 bps is 1,823 ticks
        int24 bandTicks = int24(int256((bandBps * 10_000) / 10_970)); // ln(1 + bps/1e4) / ln(1.0001), close enough for a band this size: 2,000 bps is 1,823 ticks
        console.log("  band", bandBps, "bps ->", uint256(int256(bandTicks)));

        vm.startBroadcast(pk);
        LpHelper h = new LpHelper();
        if (coinIn > 0) IERC20(coin).transfer(address(h), coinIn);
        if (nameIn > 0) IERC20(name).transfer(address(h), nameIn);
        (uint256 id, uint256 usedCoin, uint256 usedName) = h.add{value: ethIn}(seeder, pm, posm, permit2, ethUsdg, namePool, coinPool, ethIn, coinIn, nameIn, bandTicks, owner);
        vm.stopBroadcast();
        console.log("  liquidity added: position", id, "coin placed", usedCoin);
        console.log("  name placed", usedName, "owner", owner);
    }
}
