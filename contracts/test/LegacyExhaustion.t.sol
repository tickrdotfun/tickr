// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fork} from "./Fork.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {ISeederLike} from "../src/market/QuoteConverter.sol";

/// @notice What the PRODUCTION router really returns when a fixed-inventory market is exhausted.
///
/// The market module ships without the exhaustion pre-check, because the site trades through the deployed
/// ZapRouter at 0xeB3E56b1…ffe4 and that contract is not being redeployed. So the question is not what our new
/// router would have said; it is what the live one actually says, byte for byte, and whether the site can turn
/// those bytes into something a person can act on.
///
/// This captures the raw revert data. `web/scripts/tests/legacyExhaustion.test.cjs` feeds the same bytes to the
/// production error path and asserts the sentence a user would read.
contract LegacyExhaustionForkTest is Test {
    address constant LIVE_ZAP_ROUTER = 0xeB3E56b10C58e1149Ae38B65E0B28A90cC33ffe4;
    address constant MARKET_DEPLOYER = 0x0F72C545Bd455DB7184F5B0eA4725f5AA8494418;
    address constant SEEDER = 0x3733576410312D34B53F90cFE513B0D0995aB6Ca;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    bool forked;

    function setUp() public {
        forked = Fork.select();
    }

    function test_fork_whatTheLiveRouterSaysWhenAMarketIsEmpty() public {
        if (!forked) return;
        MarketTickerDeployer live = MarketTickerDeployer(MARKET_DEPLOYER);
        MarketTickerDeployer small = new MarketTickerDeployer(
            address(this), IERC20(USDG), ISeederLike(SEEDER).poolManager(), live.posm(), live.permit2(),
            200e6, live.fee(), live.spacing(), live.width()
        );
        (address name,) = small.create(keccak256("EMPTYLIVE"), "EMPTYLIVE", 6);
        PoolKey memory key = small.keyFor(name);
        IPoolManager pm = ISeederLike(SEEDER).poolManager();

        // drain it with v4's own helper, which tolerates the partial fill our routers refuse
        PoolSwapTest swapper = new PoolSwapTest(pm);
        bool buyIsZeroForOne = Currency.unwrap(key.currency0) == USDG;
        deal(USDG, address(this), 1_000_000e6);
        IERC20(USDG).approve(address(swapper), type(uint256).max);
        swapper.swap(
            key,
            SwapParams({
                zeroForOne: buyIsZeroForOne,
                amountSpecified: -int256(500_000e6),
                sqrtPriceLimitX96: buyIsZeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        (uint160 spot,,,) = StateLibrary.getSlot0(pm, PoolIdLibrary.toId(key));
        console.log("drained, spot sqrtPriceX96:");
        console.log(spot);

        // now swap into the empty side through the pool manager the way the live router would
        vm.expectRevert();
        pm.unlock(abi.encode(key, buyIsZeroForOne));

        // and capture the raw bytes by calling the manager directly
        try this.probe(pm, key, buyIsZeroForOne) {
            revert("the drained market accepted a swap");
        } catch (bytes memory data) {
            console.log("RAW REVERT DATA from the live pool manager:");
            console.logBytes(data);
            require(data.length >= 4, "no selector");
            bytes4 sel;
            assembly { sel := mload(add(data, 32)) }
            console.log("selector:");
            console.logBytes4(sel);
            // the js test hardcodes these bytes, so assert them here: if Uniswap ever changes this error, this
            // fails and says the interface fixture is stale, rather than the site quietly showing a selector again
            assertEq(sel, bytes4(0x7c9c6e8f), "PriceLimitAlreadyExceeded(uint160,uint160)");
            assertEq(
                data,
                hex"7c9c6e8f00000000000000000000000000000000000000000000000000000001000276a400000000000000000000000000000000000000000000000000000001000276a4",
                "the exact bytes web/scripts/tests/legacyExhaustion.test.cjs asserts against"
            );
        }
    }

    function probe(IPoolManager pm, PoolKey memory key, bool zeroForOne) external {
        pm.unlock(abi.encode(key, zeroForOne));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        (PoolKey memory key, bool zeroForOne) = abi.decode(raw, (PoolKey, bool));
        IPoolManager pm = ISeederLike(SEEDER).poolManager();
        pm.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(1_000e6),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        return "";
    }
}
