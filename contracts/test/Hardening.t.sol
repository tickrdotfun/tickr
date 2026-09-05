// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {TokenParams, Socials, LaunchedToken} from "../src/Types.sol";
import {LaunchSeeder} from "../src/LaunchSeeder.sol";
import {LaunchLocker} from "../src/LaunchLocker.sol";
import {LaunchDeployer} from "../src/LaunchDeployer.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";
import {V4Seeder} from "../src/libraries/V4Seeder.sol";
import {MockERC20} from "./mocks/MockUSDG.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PriceMathHarness {
    function sq(uint256 a1, uint256 a0) external pure returns (uint160) {
        return PriceMath.sqrtPriceX96(a1, a0);
    }
}

/// The hardening round: squatting, third-party liquidity, a hostile club, both token orders on a six-decimal
/// quote, refunds of what a pool did not take, metadata caps, the locker's receiver, and the token's surface.
contract HardeningTest is BaseTest {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function _key(address a, address b, uint24 fee, int24 spacing) internal pure returns (PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, spacing, IHooks(address(0)));
    }

    // ---------------------------------------------------------------- squat

    function test_launch_refusesAPoolSomeoneOpenedFirst_andANewSaltSucceeds() public {
        TokenParams memory p = defaultParams(address(0), 0);
        address predicted = deployer.predictToken(creator, p, SUPPLY);
        // a stranger opens the exact key the launch would use
        poolManager.initialize(_key(predicted, address(0), 10_000, 10), uint160(1 << 96));
        vm.prank(creator);
        vm.expectRevert(LaunchSeeder.PoolAlreadyExists.selector);
        factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        // a new salt is a new address and a new key
        p.salt = keccak256("another");
        vm.prank(creator);
        (address t,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        assertTrue(factory.getLaunchedToken(t).exists);
        assertTrue(t != predicted);
    }

    // ---------------------------------------------------------------- third-party liquidity

    function test_launch_strangerCanAddLiquidityFromDayOne_withoutTouchingTheLaunchPosition() public {
        (Token t,) = launchNative(creator);
        LaunchedToken memory l = factory.getLaunchedToken(address(t));
        PoolKey memory key = factory.poolKeyOf(address(t));
        // the stranger buys some coins, then adds a full-range position of their own
        buy(t, address(this), 1 ether);
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        uint256 coins = t.balanceOf(address(this)) / 2;
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(t);
        (uint256 a0, uint256 a1) = tokenIs0 ? (coins, uint256(0.2 ether)) : (uint256(0.2 ether), coins);
        vm.deal(address(this), address(this).balance + 1 ether);
        (uint256 id,,) = V4Seeder.seedFullRange(posm, permit2, key, sqrtP, a0, a1, address(this));
        assertGt(id, 0, "the stranger holds a position of their own");
        assertEq(posm.getPositionLiquidity(l.lpTokenId), l.liquidity, "the launch position is untouched");
        assertGt(poolManager.getLiquidity(key.toId()), l.liquidity, "the pool is deeper");
        // trading still works both ways
        uint256 got = buy(t, bob, 0.1 ether);
        assertGt(got, 0);
        assertGt(sell(t, bob, got / 2), 0);
    }

    // ---------------------------------------------------------------- hostile club

    function test_club_aClubThatIsNotAContract_neverBlocksALaunch() public {
        vm.prank(owner);
        factory.setFeeClub(bob); // an EOA
        // a USDG launch: the club probe finds no contract and the club's share is the creator's
        (Token t,) = launchPair(creator, address(usdg));
        assertEq(factory.getLaunchFeePolicy(address(t)).clubShareBps, 0);
        assertEq(factory.getLaunchFeePolicy(address(t)).club, address(0));
        buy(t, alice, 100e6);
        (uint256 q,) = locker.collectFees(address(t));
        assertGt(q, 0, "collection works with a broken club on the factory");
    }

    function test_club_isFrozenAtLaunch_aLaterClubChangeTouchesNoExistingLaunch() public {
        uint256 fee = LAUNCH_FEE + tickers.NEW_TICKER_FEE();
        (,, bytes32 expected,) = tickers.previewLaunch("CLUB", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        vm.prank(creator);
        (address ticker, address t,) = tickers.launch{value: fee}("CLUB", p, 0);
        assertEq(factory.getLaunchFeePolicy(t).club, address(tickers), "the club is written into the policy");
        // the owner points the factory at an EOA afterwards
        vm.prank(owner);
        factory.setFeeClub(bob);
        // a buy in the ticker, then a collection: the club slice goes to the frozen club, the launcher
        vm.startPrank(alice);
        usdg.approve(ticker, 1_000e6);
        (bool ok,) = ticker.call(abi.encodeWithSignature("mint(uint256,address)", 1_000e6, alice));
        require(ok, "mint");
        IERC20(ticker).approve(address(seeder), 1_000e6);
        PoolKey memory key = factory.poolKeyOf(t);
        seeder.swapExactIn(key, Currency.unwrap(key.currency0) == ticker, 1_000e6, 0, alice);
        vm.stopPrank();
        uint256 clubBefore = IERC20(ticker).balanceOf(address(tickers));
        (uint256 q,) = locker.collectFees(t);
        assertGt(q, 0);
        assertGt(IERC20(ticker).balanceOf(address(tickers)), clubBefore, "the frozen club was paid, not the EOA");
        assertEq(IERC20(ticker).balanceOf(bob), 0);
    }

    // ---------------------------------------------------------------- both orders, six decimals, tiny phantom

    function test_launch_sixDecimalQuoteAtATinyPhantom_worksInBothCurrencyOrders() public {
        vm.prank(owner);
        factory.setPairTokenEconomics(address(usdg), 1e6); // one dollar against a billion coins
        bool did0;
        bool did1;
        for (uint256 i; i < 64 && !(did0 && did1); i++) {
            TokenParams memory p = defaultParams(address(usdg), 0);
            p.salt = keccak256(abi.encode("order", i));
            address predicted = deployer.predictToken(creator, p, SUPPLY);
            bool coinIs0 = predicted < address(usdg);
            if ((coinIs0 && did0) || (!coinIs0 && did1)) continue;
            vm.prank(creator);
            (address t,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(usdg));
            LaunchedToken memory l = factory.getLaunchedToken(t);
            assertGt(l.liquidity, 0);
            assertEq(l.phantomQuote, 1e6);
            // a buy of one dollar takes a good part of the supply at that opening
            uint256 got = buy(Token(t), alice, 1e6);
            assertGt(got, SUPPLY / 4, "one dollar buys a big slice of a one-dollar cap");
            if (coinIs0) did0 = true;
            else did1 = true;
        }
        assertTrue(did0 && did1, "both orders launched");
    }

    function test_priceMath_steepRatiosUseTheQ128Path() public {
        PriceMathHarness h = new PriceMathHarness();
        // supply against a few raw units of a six-decimal quote: ratio 1e21, beyond the Q192 path
        uint160 root = h.sq(1e27, 1e6);
        uint256 back = FullMath.mulDiv(root, root, 1 << 192);
        assertApproxEqRel(back, 1e21, 1e-9 ether, "price round-trips");
        // the shallow direction still uses full precision
        uint160 root2 = h.sq(1e6, 1e27);
        uint256 back2 = FullMath.mulDiv(uint256(root2) * root2, 1e30, 1 << 192); // the price times 1e30: 1e-21 * 1e30
        assertApproxEqRel(back2, 1e9, 1e-6 ether);
        vm.expectRevert(bytes("PriceMath: zero"));
        h.sq(0, 1);
    }

    // ---------------------------------------------------------------- refunds

    function test_seeder_refundsWhatANarrowPoolCannotTake_erc20() public {
        MockERC20 other = new MockERC20("Other", "OTHER", 18);
        PoolKey memory key = _key(address(wild), address(other), 3000, 60);
        poolManager.initialize(key, uint160(1 << 96));
        wild.mint(address(this), 1_000e18);
        other.mint(address(this), 1_000e18);
        V4Seeder.seedRange(posm, permit2, key, uint160(1 << 96), -600, 600, 1_000e18, 1_000e18, address(this));
        bool wildIs0 = Currency.unwrap(key.currency0) == address(wild);
        wild.mint(alice, 5_000e18);
        uint256 before = wild.balanceOf(alice);
        vm.startPrank(alice);
        wild.approve(address(seeder), 5_000e18);
        uint256 out = seeder.swapExactIn(key, wildIs0, 5_000e18, 0, alice);
        vm.stopPrank();
        assertGt(out, 900e18, "the pool paid out nearly all it had");
        uint256 spent = before - wild.balanceOf(alice);
        assertLt(spent, 5_000e18, "only what the pool took was spent");
        assertGt(spent, 0);
        assertEq(wild.balanceOf(address(seeder)), 0, "nothing stays in the seeder");
    }

    function test_seeder_refundsWhatANarrowPoolCannotTake_native() public {
        PoolKey memory key = _key(address(0), address(wild), 3000, 60);
        poolManager.initialize(key, uint160(1 << 96));
        wild.mint(address(this), 10e18);
        vm.deal(address(this), address(this).balance + 10 ether);
        V4Seeder.seedRange(posm, permit2, key, uint160(1 << 96), -600, 600, 10 ether, 10e18, address(this));
        uint256 before = alice.balance;
        vm.prank(alice);
        uint256 out = seeder.swapExactIn{value: 50 ether}(key, true, 50 ether, 0, alice);
        assertGt(out, 9e18);
        uint256 spent = before - alice.balance;
        assertLt(spent, 50 ether, "the ETH the pool did not take came back");
        assertEq(address(seeder).balance, 0);
    }

    // ---------------------------------------------------------------- caps, receiver, surface

    function test_deployer_capsMetadata_andRefusesEmptyNames() public {
        TokenParams memory p = defaultParams(address(0), 0);
        p.name = string(new bytes(65));
        vm.prank(creator);
        vm.expectRevert(LaunchDeployer.MetadataTooLong.selector);
        factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        p = defaultParams(address(0), 0);
        p.symbol = "";
        vm.prank(creator);
        vm.expectRevert(LaunchDeployer.EmptyMetadata.selector);
        factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        p = defaultParams(address(0), 0);
        p.socials.website = string(new bytes(257));
        vm.prank(creator);
        vm.expectRevert(LaunchDeployer.MetadataTooLong.selector);
        factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
    }

    function test_locker_takesPositionsOnlyFromThePositionManager() public {
        vm.prank(alice);
        vm.expectRevert(LaunchLocker.NotPositionManager.selector);
        locker.onERC721Received(alice, alice, 1, "");
    }

    function test_token_hasNoOwner_andAnEscapedContractURI() public {
        TokenParams memory p = defaultParams(address(0), 0);
        p.description = "say \"hi\" \\ now\nplease";
        vm.prank(creator);
        (address t,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        assertEq(Token(t).owner(), address(0));
        string memory uri = Token(t).contractURI();
        assertTrue(_contains(uri, "data:application/json;utf8,{\"name\":\"Test Meme\""));
        assertTrue(_contains(uri, "say \\\"hi\\\" \\\\ now\\u000aplease"));
        assertTrue(_contains(uri, "\"image\":\"ipfs://logo\""));
    }

    function _contains(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i; i + n.length <= h.length; i++) {
            bool ok = true;
            for (uint256 j; j < n.length && ok; j++) ok = h[i + j] == n[j];
            if (ok) return true;
        }
        return false;
    }
}
