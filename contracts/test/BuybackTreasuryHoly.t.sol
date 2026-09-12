// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Fork} from "./Fork.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {IFeeEscrow} from "../src/interfaces/IFeeEscrow.sol";
import {LaunchSeeder} from "../src/LaunchSeeder.sol";
import {LaunchLocker} from "../src/LaunchLocker.sol";
import {IQuoteKind} from "../src/market/IQuoteKind.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {QuoteConverter} from "../src/market/QuoteConverter.sol";
import {BuybackTreasuryHoly} from "../src/market/BuybackTreasuryHoly.sol";

/// @notice The HOLY treasury against the live chain: the same wiring the deploy uses, the live HOLY/COW pool,
/// the live escrow and locker. Run with FORK_RPC set.
contract BuybackTreasuryHolyForkTest is Test {
    address constant FACTORY = 0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f;
    address constant ESCROW = 0xCf706542a17ee6C0Cc9595E3f49d9131aF3331ba;
    address constant SEEDER = 0x3733576410312D34B53F90cFE513B0D0995aB6Ca;
    address constant LOCKER = 0xDfD29cB10Ff0491CdF7896F75e54f4357F4a42b8;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant QUOTE_REGISTRY = 0x771D559712C7580D19432F83a3a7EB7C6dffBDCF;
    address constant MARKET_ISSUER = 0x384fE3D736583597A1fc345758462933455A9516;
    address constant HOLY = 0x49f39Ce9bEBC9047DF7266B55D98e46c84526942;
    address constant COW = 0xF3b977f5b0c3F03eb265D1b26BF0F8961c1bE4f7;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address constant TEAM = address(0x7EA1);

    BuybackTreasuryHoly t;
    bool forked;

    function setUp() public {
        if (!Fork.select()) return;
        forked = true;
        t = new BuybackTreasuryHoly(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            IQuoteKind(QUOTE_REGISTRY), MarketTickerDeployer(MARKET_ISSUER), HOLY, COW
        );
    }

    function toCounter() internal view returns (QuoteConverter.Terms memory) {
        return QuoteConverter.Terms({minOutPerInX96: t.defaultMinRateToCounterX96(), deadline: block.timestamp + 600});
    }

    function fromCounter() internal view returns (QuoteConverter.Terms memory) {
        return QuoteConverter.Terms({minOutPerInX96: t.defaultMinRateFromCounterX96(), deadline: block.timestamp + 600});
    }

    function test_constructorRefusesACoinNotPricedInTheName() public {
        if (!forked) return;
        vm.expectRevert(abi.encodeWithSelector(BuybackTreasuryHoly.NotACoin.selector, COW));
        new BuybackTreasuryHoly(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            IQuoteKind(QUOTE_REGISTRY), MarketTickerDeployer(MARKET_ISSUER), COW, HOLY
        );
    }

    function test_fork_officialIsHolyInCow() public view {
        if (!forked) return;
        (address c, address n) = t.official();
        assertEq(c, HOLY);
        assertEq(n, COW);
    }

    /// @notice The quote side: COW in, dollars out, half to the team and half earmarked; then a buy that turns
    /// earmarked dollars into COW, COW into HOLY, and HOLY into nothing.
    function test_fork_collectConvertsCowAndBuyBurnsHoly() public {
        if (!forked) return;
        deal(COW, address(t), 1_000e6);
        address[] memory tokens = new address[](1);
        tokens[0] = COW;
        QuoteConverter.Terms[] memory terms = new QuoteConverter.Terms[](1);
        terms[0] = toCounter();
        (uint256 usdgTotal, uint256 toTeam, uint256 earmarked) = t.collect(tokens, terms);
        assertGt(usdgTotal, 900e6, "a thousand COW is about a thousand dollars");
        assertEq(toTeam + earmarked, usdgTotal);
        assertEq(IERC20(USDG).balanceOf(TEAM), toTeam);
        assertEq(t.earmarkedUsdg(), earmarked);

        uint256 deadBefore = IERC20(HOLY).balanceOf(DEAD);
        (uint256 usdgIn, uint256 holyOut) = t.buy(fromCounter());
        assertGt(usdgIn, 0);
        assertGt(holyOut, 0);
        assertEq(IERC20(HOLY).balanceOf(DEAD) - deadBefore, holyOut, "what was bought was burned");
        assertEq(t.earmarkedUsdg(), earmarked - usdgIn, "the buy came out of the earmark");
        assertEq(t.totalTickrBurned(), holyOut);
        assertEq(IERC20(COW).balanceOf(address(t)), 0, "no COW left behind");
    }

    /// @notice The coin side: HOLY credited to the treasury in the escrow is claimed and burned, never converted
    /// and never forwarded.
    function test_fork_burnCoinClaimsTheEscrowAndBurns() public {
        if (!forked) return;
        address anyone = address(0xA11CE);
        deal(HOLY, anyone, 5_000_000e18);
        vm.startPrank(anyone);
        IERC20(HOLY).approve(ESCROW, 5_000_000e18);
        IFeeEscrow(ESCROW).creditToken(address(t), HOLY, 5_000_000e18);
        vm.stopPrank();
        assertEq(t.pendingCoin(), 5_000_000e18);

        uint256 deadBefore = IERC20(HOLY).balanceOf(DEAD);
        uint256 burned = t.burnCoin();
        assertEq(burned, 5_000_000e18);
        assertEq(IERC20(HOLY).balanceOf(DEAD) - deadBefore, 5_000_000e18);
        assertEq(t.totalCoinBurned(), 5_000_000e18);
        assertEq(t.pendingCoin(), 0);
        assertEq(IERC20(HOLY).balanceOf(TEAM), 0, "the team never sees the coin");
        assertEq(t.burnCoin(), 0, "nothing twice");
    }

    /// @notice The live route, end to end: the creator hands the recipient role to the treasury, trades happen,
    /// the locker splits the fees, and the treasury's share of both sides reaches it and leaves as dollars and ash.
    function test_fork_asCreatorRecipientTheLockerSplitReachesIt() public {
        if (!forked) return;
        address creator = IFactory(FACTORY).creatorFeeRecipientOf(HOLY);
        vm.prank(creator);
        IFactory(FACTORY).transferCreatorFeeRecipient(HOLY, address(t));
        assertEq(IFactory(FACTORY).creatorFeeRecipientOf(HOLY), address(t));

        // settle whatever the pool already owes, so what follows is only what this test's trades earn
        LaunchLocker(payable(LOCKER)).collectFees(HOLY);
        uint256 holyBefore = IFeeEscrow(ESCROW).balanceOfToken(address(t), HOLY);
        uint256 cowBefore = IFeeEscrow(ESCROW).balanceOfToken(address(t), COW);

        // a buyer: dollars' worth of COW into the HOLY pool
        PoolKey memory key = IFactory(FACTORY).poolKeyOf(HOLY);
        bool cowIs0 = Currency.unwrap(key.currency0) == COW;
        address buyer = address(0xB0B);
        deal(COW, buyer, 200e6);
        vm.startPrank(buyer);
        IERC20(COW).approve(SEEDER, 200e6);
        LaunchSeeder(payable(SEEDER)).swapExactInBounded(
            key, cowIs0, 200e6, 0, buyer, cowIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        );
        // and a sale of some of it back, so the coin side earns too
        uint256 got = IERC20(HOLY).balanceOf(buyer);
        IERC20(HOLY).approve(SEEDER, got / 2);
        LaunchSeeder(payable(SEEDER)).swapExactInBounded(
            key, !cowIs0, got / 2, 0, buyer, !cowIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        );
        vm.stopPrank();

        LaunchLocker(payable(LOCKER)).collectFees(HOLY);
        uint256 holyGained = IFeeEscrow(ESCROW).balanceOfToken(address(t), HOLY) - holyBefore;
        uint256 cowGained = IFeeEscrow(ESCROW).balanceOfToken(address(t), COW) - cowBefore;
        assertGt(holyGained, 0, "the creator's share of the coin side is credited to the treasury");
        assertGt(cowGained, 0, "and the creator's share of the quote side");

        uint256 deadBefore = IERC20(HOLY).balanceOf(DEAD);
        t.burnCoin();
        assertGe(IERC20(HOLY).balanceOf(DEAD) - deadBefore, holyGained, "the coin side is burned");

        address[] memory tokens = new address[](1);
        tokens[0] = COW;
        QuoteConverter.Terms[] memory terms = new QuoteConverter.Terms[](1);
        terms[0] = toCounter();
        (uint256 usdgTotal,,) = t.collect(tokens, terms);
        assertGt(usdgTotal, 0, "the quote side became dollars");
        assertEq(IFeeEscrow(ESCROW).balanceOfToken(address(t), COW), 0);
    }
}
