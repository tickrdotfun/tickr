// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {MockERC20} from "./mocks/MockUSDG.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ManagedTickerToken} from "../src/ManagedTickerToken.sol";
import {ManagedTickerHook} from "../src/ManagedTickerHook.sol";
import {HookMine} from "../script/lib/HookMine.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {MockV4Router} from "v4-periphery/test/mocks/MockV4Router.sol";
import {V4Quoter} from "v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "v4-periphery/src/interfaces/IV4Quoter.sol";
import {IV4Router} from "v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";

/// The reference's market suite, ported as it was written: sustained demand then a full sell in both currency orders,
/// exact output, a full direct redemption after pool buys, a tiny move then a large sell, protocol fees on the pool
/// with full redemption after them, and a maintenance fault that must roll back whole. The one difference from the
/// reference: the hook is the shared production one, registered by its issuer (this test) before the wrapper opens.
/// Local coverage of the mechanism, not public router or indexer approval. The trader starts with a million mock
/// USDG; the protocol receives only the one USDG maintenance donation; there is no funded ten thousand USDG position,
/// uncirculated issuer inventory supplies the ask.
contract ManagedTickerMarketTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;
    IPoolManager internal manager;
    MockERC20 internal usd;
    ManagedTickerToken internal bang;
    ManagedTickerHook internal hook;
    MockV4Router internal router;
    V4Quoter internal quoter;
    PoolKey internal key;
    address internal trader = makeAddr("managed-normal-trader");
    uint256 internal successfulBuys;
    uint256 internal successfulSells;
    uint256 internal successfulDirectMints;
    uint256 internal successfulDirectRedemptions;

    function _setup(bool wrapper0) internal {
        manager = IPoolManager(address(new PoolManager(address(this))));
        usd = new MockERC20("Local USDG", "USDG", 6);
        bytes memory args =
            abi.encode("BANG - TEST ONLY", "BANG", IERC20(address(usd)), manager, address(this), 10_000e6);
        bytes32 initHash = keccak256(abi.encodePacked(type(ManagedTickerToken).creationCode, args));
        bytes32 salt;
        for (uint256 i;; ++i) {
            salt = bytes32(i);
            address predicted = vm.computeCreate2Address(salt, initHash, address(this));
            if ((predicted < address(usd)) == wrapper0) break;
        }
        bang = new ManagedTickerToken{salt: salt}(
            "BANG - TEST ONLY", "BANG", IERC20(address(usd)), manager, address(this), 10_000e6
        );
        uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;
        (, bytes32 hookSalt) = HookMine.find(
            address(this),
            flags,
            keccak256(abi.encodePacked(type(ManagedTickerHook).creationCode, abi.encode(manager, address(this))))
        );
        hook = new ManagedTickerHook{salt: hookSalt}(manager, address(this));
        hook.register(bang);
        usd.mint(address(this), 1e6);
        usd.approve(address(bang), 1e6);
        bang.initialize(address(hook), 1e6);
        router = new MockV4Router(manager);
        quoter = new V4Quoter(manager);
        key = bang.poolKey();
        usd.mint(trader, 1_000_000e6);
        vm.startPrank(trader);
        usd.approve(address(router), type(uint256).max);
        usd.approve(address(bang), type(uint256).max);
        bang.approve(address(router), type(uint256).max);
        vm.stopPrank();
        assertEq(Currency.unwrap(key.currency0) == address(bang), wrapper0);
        assertLe(address(bang).code.length, 24_576);
        assertLe(address(hook).code.length, 24_576);
        assertGt(bang.totalSupply(), 9_999e6, "issuer ask inventory actually exists");
        assertLt(bang.circulatingSupply(), 100, "only conservative rounding dust starts circulating");
        _solvent();
    }

    function _state() internal view returns (bytes32) {
        (uint256 b, uint256 c) = bang.accounting();
        (uint160 sqrtP, int24 tick, uint24 protocolFee, uint24 lpFee) = manager.getSlot0(key.toId());
        return keccak256(
            abi.encode(
                b,
                c,
                bang.totalSupply(),
                bang.balanceOf(trader),
                usd.balanceOf(trader),
                bang.maintenanceCount(),
                bang.maintenanceSkipped(),
                bang.measuredMaintenanceLoss(),
                sqrtP,
                tick,
                protocolFee,
                lpFee
            )
        );
    }

    function _swap(bool buying, bool exactIn, uint256 amount) internal returns (uint256 paid, uint256 received) {
        // Explicitly marks an already-settled boundary between simulated EOA transactions.
        // Public routing support for repeated bridge visits in one transaction is not claimed.
        bang.checkpoint();
        bool zeroForOne =
            buying ? Currency.unwrap(key.currency0) == address(usd) : Currency.unwrap(key.currency0) == address(bang);
        IV4Quoter.QuoteExactSingleParams memory qp =
            IV4Quoter.QuoteExactSingleParams(key, zeroForOne, uint128(amount), "");
        bytes32 stateBefore = _state();
        uint256 quote;
        if (exactIn) (quote,) = quoter.quoteExactInputSingle(qp);
        else (quote,) = quoter.quoteExactOutputSingle(qp);
        assertEq(_state(), stateBefore, "quote fully rolls back market, supply, fees and maintenance");
        assertGt(quote, 0);
        uint256 minimum = exactIn ? quote * 99 / 100 : amount;
        uint256 maximum = exactIn ? amount : quote * 101 / 100 + 2;
        assertGt(minimum, 0);
        bytes[] memory params = new bytes[](3);
        if (exactIn) {
            params[0] =
                abi.encode(IV4Router.ExactInputSingleParams(key, zeroForOne, uint128(amount), uint128(minimum), 0, ""));
        } else {
            params[0] = abi.encode(
                IV4Router.ExactOutputSingleParams(key, zeroForOne, uint128(amount), uint128(maximum), 0, "")
            );
        }
        Currency input = zeroForOne ? key.currency0 : key.currency1;
        Currency output = zeroForOne ? key.currency1 : key.currency0;
        params[1] = abi.encode(input, maximum);
        params[2] = abi.encode(output, minimum);
        bytes memory actions = abi.encode(
            abi.encodePacked(
                uint8(exactIn ? Actions.SWAP_EXACT_IN_SINGLE : Actions.SWAP_EXACT_OUT_SINGLE),
                uint8(Actions.SETTLE_ALL),
                uint8(Actions.TAKE_ALL)
            ),
            params
        );
        uint256 beforeIn = input.balanceOf(trader);
        uint256 beforeOut = output.balanceOf(trader);
        vm.prank(trader);
        router.executeActions(actions);
        paid = beforeIn - input.balanceOf(trader);
        received = output.balanceOf(trader) - beforeOut;
        assertEq(paid, exactIn ? amount : quote);
        assertEq(received, exactIn ? quote : amount);
        assertGe(received, minimum);
        assertLe(paid, maximum);
        if (buying) ++successfulBuys;
        else ++successfulSells;
        _solvent();
    }

    function _solvent() internal view {
        (uint256 b, uint256 c) = bang.accounting();
        assertGe(b, c, "all conservative external claims backed");
        assertGe(bang.usableBacking(), c, "all claims covered without withdrawing retained bridge principal");
        assertGe(c, bang.balanceOf(trader));
        assertEq(bang.reserve(), b);
        assertEq(bang.circulatingSupply(), c);
        assertFalse(manager.isUnlocked());
        assertEq(manager.getNonzeroDeltaCount(), 0);
        assertEq(manager.currencyDelta(address(bang), key.currency0), 0);
        assertEq(manager.currencyDelta(address(bang), key.currency1), 0);
        assertEq(bang.balanceOf(address(router)), 0);
        assertEq(usd.balanceOf(address(router)), 0);
    }

    function _sustained(bool wrapper0) internal {
        _setup(wrapper0);
        uint256 beforeUsd = usd.balanceOf(trader);
        for (uint256 i; i < 10; ++i) {
            _swap(true, true, 10_000e6);
        }
        uint256 holdings = bang.balanceOf(trader);
        assertGt(holdings, 99_000e6);
        assertEq(beforeUsd - usd.balanceOf(trader), 100_000e6);
        (, uint256 returned) = _swap(false, true, holdings);
        assertEq(bang.balanceOf(trader), 0);
        assertGt(returned, 99_000e6);
        assertEq(successfulBuys, 10);
        assertEq(successfulSells, 1);
        console2.log("MANAGED sustainedBuyCounterRaw", uint256(100_000e6));
        console2.log("MANAGED wrapperReceivedRaw", holdings);
        console2.log("MANAGED fullPoolExitCounterRaw", returned);
        console2.log("MANAGED maintenanceLossRaw", bang.measuredMaintenanceLoss());
    }

    function test_managedSustainedDemandCurrency0ThenAllPoolSell() public {
        _sustained(true);
    }

    function test_managedSustainedDemandCurrency1ThenAllPoolSell() public {
        _sustained(false);
    }

    function test_managedExactOutputBuyAndSell() public {
        _setup(true);
        _swap(true, false, 1_000e6);
        _swap(false, false, 500e6);
        assertEq(successfulBuys, 1);
        assertEq(successfulSells, 1);
    }

    function test_managedDirectRedeemAllActuallyOwnedCirculationAfterPoolBuys() public {
        _setup(false);
        for (uint256 i; i < 5; ++i) {
            _swap(true, true, 5_000e6);
        }
        uint256 amount = bang.balanceOf(trader);
        uint256 beforeUsd = usd.balanceOf(trader);
        vm.prank(trader);
        bang.redeem(amount, trader);
        ++successfulDirectRedemptions;
        assertEq(usd.balanceOf(trader) - beforeUsd, amount);
        assertEq(bang.balanceOf(trader), 0);
        assertLt(bang.circulatingSupply(), 100, "only unspendable conservatively counted dust remains");
        _solvent();
        _swap(true, true, 1_000e6);
    }

    function test_managedTinyPriceMoveThenDirectMintLargePoolSell() public {
        _setup(true);
        _swap(true, true, 10_000);
        vm.prank(trader);
        bang.mint(100_000e6, trader);
        ++successfulDirectMints;
        _solvent();
        (, uint256 received) = _swap(false, true, 100_000e6);
        assertGt(received, 99_900e6);
    }

    function test_managedNormalTradingWithNonzeroProtocolFees() public {
        _setup(false);
        manager.setProtocolFeeController(address(this));
        manager.setProtocolFee(key, uint24(1000 | (1000 << 12)));
        _swap(true, true, 5_000e6);
        _swap(false, true, bang.balanceOf(trader));
        assertGt(manager.protocolFeesAccrued(Currency.wrap(address(usd))), 0);
        _solvent();
    }

    function _directRedeemWithProtocolFees(bool wrapper0) internal {
        _setup(wrapper0);
        manager.setProtocolFeeController(address(this));
        manager.setProtocolFee(key, uint24(1000 | (1000 << 12)));
        _swap(true, true, 5_000e6);
        _swap(false, true, bang.balanceOf(trader) / 4);
        _swap(true, false, 2_000e6);
        vm.prank(trader);
        bang.mint(1_000e6, trader);
        uint256 amount = bang.balanceOf(trader);
        uint256 beforeUsd = usd.balanceOf(trader);
        vm.prank(trader);
        bang.redeem(amount, trader);
        assertEq(usd.balanceOf(trader) - beforeUsd, amount, "all actual holder claims redeemed into real counter");
        assertEq(bang.balanceOf(trader), 0);
        uint256 protocolClaims = manager.protocolFeesAccrued(Currency.wrap(address(bang)));
        assertGt(protocolClaims, 0, "protocol owns real wrapper fees from the prior sell");
        assertApproxEqAbs(
            bang.circulatingSupply(), protocolClaims, 100, "protocol-held receipts remain backed external claims"
        );
        _solvent();
        manager.collectProtocolFees(trader, Currency.wrap(address(bang)), 0);
        assertEq(bang.balanceOf(trader), protocolClaims);
        beforeUsd = usd.balanceOf(trader);
        vm.prank(trader);
        bang.redeem(protocolClaims, trader);
        assertEq(usd.balanceOf(trader) - beforeUsd, protocolClaims, "protocol fee holder can redeem every receipt too");
        assertLt(bang.circulatingSupply(), 100);
        _solvent();
        _swap(true, true, 1_000e6);
    }

    function test_managedFullDirectRedemptionAfterProtocolFeesCurrency0() public {
        _directRedeemWithProtocolFees(true);
    }

    function test_managedFullDirectRedemptionAfterProtocolFeesCurrency1() public {
        _directRedeemWithProtocolFees(false);
    }

    function _ownedPositionLiquidity() internal view returns (bytes32) {
        (uint128 lower,,) = manager.getPositionInfo(key.toId(), address(bang), -2, 0, bytes32(uint256(1)));
        (uint128 upper,,) = manager.getPositionInfo(key.toId(), address(bang), 0, 2, bytes32(uint256(2)));
        (uint128 retained,,) = manager.getPositionInfo(key.toId(), address(bang), -2, 2, bytes32(uint256(3)));
        return keccak256(abi.encode(lower, upper, retained));
    }

    function _injectLocalMaintenanceTransferFailure() internal {
        // DEFENSIVE LOCAL FAULT INJECTION ONLY. Maintenance uses counter.transfer(toPM).
        // Normal router payment uses transferFrom, while PM withdrawals transfer to the
        // wrapper; neither is matched by this exact selector/destination prefix.
        vm.mockCallRevert(
            address(usd),
            abi.encodeWithSelector(IERC20.transfer.selector, address(manager)),
            abi.encodeWithSignature("Error(string)", "LOCAL_TEST_MAINTENANCE_TRANSFER_FAILURE")
        );
    }

    function test_managedMaintenanceFaultFallsBackToHealthyExistingLiquidity() public {
        _setup(true);
        _swap(true, true, 1_000e6);
        bang.checkpoint();
        bytes32 positionsBefore = _ownedPositionLiquidity();
        uint256 supplyBefore = bang.totalSupply();
        uint256 idleCounterBefore = usd.balanceOf(address(bang));
        uint256 idleInventoryBefore = bang.balanceOf(address(bang));
        uint256 maintenanceBefore = bang.maintenanceCount();
        uint256 skippedBefore = bang.maintenanceSkipped();
        uint256 lossBefore = bang.measuredMaintenanceLoss();
        (uint160 priceBefore,,,) = manager.getSlot0(key.toId());
        _injectLocalMaintenanceTransferFailure();
        // The helper proves quote rollback, actual exact input/output, positive minimum,
        // backing and zero unpaid deltas. Quoting and execution see the same local fault.
        (uint256 paid, uint256 received) = _swap(true, true, 500e6);
        vm.clearMockedCalls();
        assertEq(paid, 500e6);
        assertGt(received, 499e6);
        assertEq(bang.maintenanceCount(), maintenanceBefore, "failed maintenance never commits");
        assertEq(bang.maintenanceSkipped(), skippedBefore + 1, "only executed fallback persists, not quote");
        assertEq(bang.measuredMaintenanceLoss(), lossBefore, "failed maintenance costs roll back");
        assertEq(bang.totalSupply(), supplyBefore, "temporary issuer mints roll back");
        assertEq(usd.balanceOf(address(bang)), idleCounterBefore, "owned idle cash restored");
        assertEq(bang.balanceOf(address(bang)), idleInventoryBefore, "owned idle inventory restored");
        assertEq(_ownedPositionLiquidity(), positionsBefore, "all three original position liquidities restored");
        (uint160 priceAfter,,,) = manager.getSlot0(key.toId());
        assertGt(priceAfter, priceBefore, "the successful ordinary buy genuinely moves price");
        _solvent();
        console2.log("MANAGED_FALLBACK actualCounterPaidRaw", paid);
        console2.log("MANAGED_FALLBACK actualWrapperReceivedRaw", received);
    }

    function test_managedMaintenanceFaultRejectsOrderBeyondExistingLiquidity() public {
        _setup(true);
        _swap(true, true, 1_000e6);
        bang.checkpoint();
        uint256 amount = 12_000e6;
        assertGt(bang.inventoryCapacity(), amount, "normal rebuild could supply the requested order");
        bytes32 beforeState = _state();
        bytes32 positionsBefore = _ownedPositionLiquidity();
        uint256 idleCounterBefore = usd.balanceOf(address(bang));
        uint256 idleInventoryBefore = bang.balanceOf(address(bang));
        bool zeroForOne = Currency.unwrap(key.currency0) == address(usd);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(IV4Router.ExactInputSingleParams(key, zeroForOne, uint128(amount), 1, 0, ""));
        params[1] = abi.encode(Currency.wrap(address(usd)), amount);
        params[2] = abi.encode(Currency.wrap(address(bang)), uint256(1));
        bytes memory actions = abi.encode(
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL)),
            params
        );
        _injectLocalMaintenanceTransferFailure();
        vm.prank(trader);
        (bool ok, bytes memory reason) = address(router).call(abi.encodeCall(router.executeActions, (actions)));
        vm.clearMockedCalls();
        assertFalse(ok, "fallback must not silently partially fill an oversized normal order");
        assertGt(reason.length, 0);
        assertEq(_state(), beforeState, "failed ordinary order rolls back amounts, fees, price and counters");
        assertEq(_ownedPositionLiquidity(), positionsBefore);
        assertEq(usd.balanceOf(address(bang)), idleCounterBefore);
        assertEq(bang.balanceOf(address(bang)), idleInventoryBefore);
        _solvent();
        // The same funded order executes normally after the local fault is removed.
        (, uint256 received) = _swap(true, true, amount);
        assertGt(received, 11_990e6);
    }

    function testFuzz_managedStatefulOrdinarySequence(uint80 seed) public {
        _setup(seed & 1 == 0);
        for (uint256 i; i < 24; ++i) {
            uint256 sample = uint256(keccak256(abi.encode(seed, i)));
            uint256 amount = 1e6 + sample % 1_000e6;
            uint256 holding = bang.balanceOf(trader);
            uint256 action = sample % 4;
            if (action == 0 || holding == 0) {
                _swap(true, true, amount);
            } else if (action == 1) {
                _swap(false, true, holding / 2 + 1);
            } else if (action == 2) {
                vm.prank(trader);
                bang.mint(amount, trader);
                ++successfulDirectMints;
            } else {
                vm.prank(trader);
                bang.redeem(holding / 2 + 1, trader);
                ++successfulDirectRedemptions;
            }
            _solvent();
        }
        assertGt(successfulBuys + successfulSells + successfulDirectMints + successfulDirectRedemptions, 20);
        assertGt(successfulBuys, 0, "stateful coverage is not all failed operations");
    }
}
