// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseTest} from "./Base.t.sol";
import {Token} from "../src/Token.sol";
import {TokenParams, PairEconomics} from "../src/Types.sol";
import {TickerLauncher} from "../src/TickerLauncher.sol";
import {TickerToken} from "../src/TickerToken.sol";
import {LaunchLocker} from "../src/LaunchLocker.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {FeePolicy} from "../src/Types.sol";
import {MockFeeToken} from "./mocks/MockFeeToken.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {V4Seeder} from "../src/libraries/V4Seeder.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";

/// The audit round: the club pots stay put, the factory is born closed, a club change cannot brick inventing
/// names, a wrapper mints what it received, the locker takes mints only, names are letters and digits, and the
/// zap trades a coin through its own pool and nothing else.
contract AuditRoundTest is BaseTest {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    function _inventAndFund(string memory name) internal returns (address ticker, address coin) {
        uint256 fee = LAUNCH_FEE + tickers.NEW_TICKER_FEE();
        (,, bytes32 expected,) = tickers.previewLaunch(name, 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        vm.prank(creator);
        (ticker, coin,) = tickers.launch{value: fee}(name, p, 0);
        pastTheWindow();
        // a buy in the ticker and a collection, so the club holds a pot in the ticker
        vm.startPrank(alice);
        usdg.approve(ticker, 2_000e6);
        TickerToken(ticker).mint(2_000e6, alice);
        IERC20(ticker).approve(address(seeder), 2_000e6);
        PoolKey memory key = factory.poolKeyOf(coin);
        seeder.swapExactIn(key, Currency.unwrap(key.currency0) == ticker, 2_000e6, 0, alice);
        vm.stopPrank();
        locker.collectFees(coin);
    }

    function test_club_launchAndBuyCannotTakeTheClubPots() public {
        (address ticker,) = _inventAndFund("CLUBB");
        uint256 pot = IERC20(ticker).balanceOf(address(tickers));
        assertGt(pot, 0, "the club holds a pot in the ticker");
        // bob launches a second coin under the name with a one-unit first buy
        (,, bytes32 expected,) = tickers.previewLaunch("CLUBB", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        p.salt = keccak256("bob");
        vm.startPrank(bob);
        usdg.approve(address(tickers), 1);
        tickers.launchAndBuy{value: LAUNCH_FEE}("CLUBB", p, 0, 1, 0);
        vm.stopPrank();
        assertEq(IERC20(ticker).balanceOf(address(tickers)), pot, "the pot did not move");
        assertEq(IERC20(ticker).balanceOf(bob), 0, "bob got nothing that was not his");
    }

    function test_club_changingTheClubDoesNotBrickInventingNames() public {
        vm.prank(owner);
        factory.setFeeClub(bob); // an EOA, the worst case
        uint256 fee = LAUNCH_FEE + tickers.NEW_TICKER_FEE();
        (,, bytes32 expected,) = tickers.previewLaunch("STILL", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        vm.prank(creator);
        (address ticker, address coin,) = tickers.launch{value: fee}("STILL", p, 0);
        assertTrue(tickers.isTicker(ticker));
        assertTrue(seeder.hasChartPool(ticker), "the dollar pool opened through the ticker launcher, club or no club");
        assertTrue(factory.getLaunchedToken(coin).exists);
    }

    function test_wrapper_mintsWhatItReceived_neverUnderBacked() public {
        MockFeeToken fusd = new MockFeeToken();
        TickerToken w = new TickerToken("Wrapped", "WRAP", IERC20(address(fusd)));
        fusd.mint(alice, 1_000e6);
        vm.startPrank(alice);
        fusd.approve(address(w), 1_000e6);
        w.mint(1_000e6, alice);
        vm.stopPrank();
        assertEq(w.totalSupply(), 980e6, "credited what arrived, not what was asked");
        assertEq(w.totalSupply(), fusd.balanceOf(address(w)), "fully backed");
        vm.prank(alice);
        w.redeem(980e6, alice);
        assertEq(w.totalSupply(), 0);
    }

    function test_locker_refusesSomebodysOwnPosition() public {
        (Token t,) = launchNative(creator);
        PoolKey memory key = factory.poolKeyOf(address(t));
        buy(t, address(this), 1 ether);
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        uint256 coins = t.balanceOf(address(this)) / 2;
        bool tokenIs0 = Currency.unwrap(key.currency0) == address(t);
        (uint256 a0, uint256 a1) = tokenIs0 ? (coins, uint256(0.2 ether)) : (uint256(0.2 ether), coins);
        vm.deal(address(this), address(this).balance + 1 ether);
        (uint256 id,,) = V4Seeder.seedFullRange(posm, permit2, key, sqrtP, a0, a1, address(this));
        vm.expectRevert(LaunchLocker.NotAMint.selector);
        IERC721(address(posm)).safeTransferFrom(address(this), address(locker), id);
        assertEq(IERC721(address(posm)).ownerOf(id), address(this), "still mine");
    }

    function test_names_lettersAndDigitsOnly_twelveAtMost() public {
        uint256 fee = LAUNCH_FEE + tickers.NEW_TICKER_FEE();
        TokenParams memory p = defaultParams(address(0), 0);
        string[3] memory bad = ["BAN ANA", unicode"BÄNANA", "THIRTEENCHARS"];
        for (uint256 i; i < 3; i++) {
            vm.prank(creator);
            vm.expectRevert();
            tickers.launch{value: fee}(bad[i], p, 0);
        }
        (,, bytes32 expected,) = tickers.previewLaunch("OK42", 0);
        p.expectedEconomics = expected;
        vm.prank(creator);
        (address ticker,,) = tickers.launch{value: fee}("OK42", p, 0);
        assertTrue(tickers.isTicker(ticker));
    }

    function test_zap_tradesOnlyThroughTheCoinsOwnPool() public {
        (Token t,) = launchNative(creator);
        // a buy whose last hop is the ETH/USDG pool, which merely does not output the coin: refused
        ZapRouter.Hop[] memory path = new ZapRouter.Hop[](1);
        path[0] = ZapRouter.Hop({kind: 0, key: ethUsdgKey, pool: address(0)});
        vm.prank(bob);
        vm.expectRevert(ZapRouter.BadPath.selector);
        zap.zapBuy{value: 0.1 ether}(ZapRouter.ZapParams({token: address(t), tokenIn: address(0), amountIn: 0, path: path, minTokensOut: 0, recipient: bob, deadline: vm.getBlockTimestamp() + 1 hours}));
        // a foreign hookless pool that does output the coin is refused too
        MockFeeTokenFree other = new MockFeeTokenFree();
        PoolKey memory foreign = _key(address(t), address(other), 3000, 60);
        poolManager.initialize(foreign, uint160(1 << 96));
        path[0] = ZapRouter.Hop({kind: 0, key: foreign, pool: address(0)});
        other.mint(bob, 1e18);
        vm.startPrank(bob);
        other.approve(address(zap), 1e18);
        vm.expectRevert(ZapRouter.BadPath.selector);
        zap.zapBuy(ZapRouter.ZapParams({token: address(t), tokenIn: address(other), amountIn: 1e18, path: path, minTokensOut: 0, recipient: bob, deadline: vm.getBlockTimestamp() + 1 hours}));
        vm.stopPrank();
        // the coin's own pool works
        path[0] = ZapRouter.Hop({kind: 0, key: factory.poolKeyOf(address(t)), pool: address(0)});
        vm.prank(bob);
        uint256 got = zap.zapBuy{value: 0.1 ether}(ZapRouter.ZapParams({token: address(t), tokenIn: address(0), amountIn: 0, path: path, minTokensOut: 0, recipient: bob, deadline: vm.getBlockTimestamp() + 1 hours}));
        assertGt(got, 0);
    }


    function test_coinSymbol_lettersAndDigitsOnly() public {
        TokenParams memory p = defaultParams(address(0), 0);
        p.symbol = "NVDA ";
        vm.prank(creator);
        vm.expectRevert();
        factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        p.symbol = unicode"NVDΑ"; // a Greek alpha
        vm.prank(creator);
        vm.expectRevert();
        factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        p.symbol = "MEME42";
        vm.prank(creator);
        (address t,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        assertTrue(factory.getLaunchedToken(t).exists);
    }

    function test_economicsPin_coversTheSplitAndTheFee() public {
        TokenParams memory p = defaultParams(address(0), 0); // pinned to the current policy and fee
        vm.prank(owner);
        factory.setLaunchFee(LAUNCH_FEE + 1);
        vm.prank(creator);
        vm.expectRevert(IFactory.LaunchEconomicsMismatch.selector);
        factory.launchToken{value: LAUNCH_FEE + 1}(p, 0, address(0));
        vm.prank(owner);
        factory.setLaunchFee(LAUNCH_FEE);
        FeePolicy memory pol = FeePolicy({protocolFeeRecipient: protocolFees, creatorShareBps: 5_000, clubShareBps: 1_000, protocolShareBps: 4_000, buybackBurnBps: 0, club: address(0), hookFeeBps: 100, maxInternalPriceImpactBps: 300});
        vm.prank(owner);
        factory.setFeePolicy(pol);
        vm.prank(creator);
        vm.expectRevert(IFactory.LaunchEconomicsMismatch.selector);
        factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        // a fresh preview matches again
        p = defaultParams(address(0), 0);
        vm.prank(creator);
        (address t,) = factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        assertEq(factory.getLaunchFeePolicy(t).creatorShareBps, 6_000, "the new split, with the club's part folded to the creator outside a ticker");
    }

    function test_zap_emptyPathIsABadPath() public {
        (Token t,) = launchNative(creator);
        ZapRouter.Hop[] memory none = new ZapRouter.Hop[](0);
        vm.prank(bob);
        vm.expectRevert(ZapRouter.BadPath.selector);
        zap.zapBuy{value: 0.1 ether}(ZapRouter.ZapParams({token: address(t), tokenIn: address(0), amountIn: 0, path: none, minTokensOut: 0, recipient: bob, deadline: vm.getBlockTimestamp() + 1 hours}));
    }


    function test_economicsPin_coversTheClub() public {
        (,, bytes32 expected,) = tickers.previewLaunch("CLUBX", 0);
        TokenParams memory p = defaultParams(address(0), 0);
        p.expectedEconomics = expected;
        uint256 fee = LAUNCH_FEE + tickers.NEW_TICKER_FEE();
        // the owner drops the club between the preview and the send: the terms would change, so the launch refuses
        vm.prank(owner);
        factory.setFeeClub(address(0));
        vm.prank(creator);
        vm.expectRevert(IFactory.LaunchEconomicsMismatch.selector);
        tickers.launch{value: fee}("CLUBX", p, 0);
        // a fresh preview carries the new terms and goes through, with the club's share folded to the creator
        (,, bytes32 again,) = tickers.previewLaunch("CLUBX", 0);
        p.expectedEconomics = again;
        vm.prank(creator);
        (, address t,) = tickers.launch{value: fee}("CLUBX", p, 0);
        assertEq(factory.getLaunchFeePolicy(t).club, address(0));
        assertEq(factory.getLaunchFeePolicy(t).creatorShareBps, 7_000);
    }

    function test_names_noEdgeOrDoubleSpaces_noControlCharacters() public {
        string[4] memory bad = ["NVIDIA ", " NVIDIA", "NVIDIA  Corp", "NVIDIA\tCorp"];
        for (uint256 i; i < 4; i++) {
            TokenParams memory p = defaultParams(address(0), 0);
            p.name = bad[i];
            vm.prank(creator);
            vm.expectRevert();
            factory.launchToken{value: LAUNCH_FEE}(p, 0, address(0));
        }
        // another script or an emoji cannot dress a name up as an official one: names are printable ASCII
        TokenParams memory emoji = defaultParams(address(0), 0);
        emoji.name = unicode"Bananas 🍌 on Robinhood";
        vm.prank(creator);
        vm.expectRevert();
        factory.launchToken{value: LAUNCH_FEE}(emoji, 0, address(0));
        TokenParams memory ok = defaultParams(address(0), 0);
        ok.name = "Bananas & Co. #1 (on Robinhood)";
        vm.prank(creator);
        (address t,) = factory.launchToken{value: LAUNCH_FEE}(ok, 0, address(0));
        assertTrue(factory.getLaunchedToken(t).exists);
    }

    function _key(address a, address b, uint24 fee, int24 spacing) internal pure returns (PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, spacing, IHooksZero.zero());
    }
}

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

library IHooksZero {
    function zero() internal pure returns (IHooks) {
        return IHooks(address(0));
    }
}

contract MockFeeTokenFree is ERC20 {
    constructor() ERC20("Other", "OTHR") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
