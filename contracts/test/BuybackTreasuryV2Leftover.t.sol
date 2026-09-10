// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {Fork} from "./Fork.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IQuoteKind} from "../src/market/IQuoteKind.sol";
import {QuoteRegistry, ITickerLauncherLike} from "../src/market/QuoteRegistry.sol";
import {QuoteConverter} from "../src/market/QuoteConverter.sol";
import {BuybackTreasuryV2} from "../src/market/BuybackTreasuryV2.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {ISeederLike} from "../src/market/QuoteConverter.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {IFeeEscrow} from "../src/interfaces/IFeeEscrow.sol";
import {LaunchSeeder} from "../src/LaunchSeeder.sol";
import {LaunchedToken} from "../src/Types.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

interface IPosLiq {
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
}

/// @dev A treasury whose official pair is the local fixture's, so the whole buy path runs against pools sized on
/// purpose rather than against whatever the live ones happen to hold.
contract FixtureTreasury is BuybackTreasuryV2 {
    address private immutable _coin;
    address private immutable _name;

    constructor(
        IFactory f, IFeeEscrow e, LaunchSeeder s, IERC20 u, address team, IQuoteKind r, MarketTickerDeployer m,
        address coin_, address name_
    ) BuybackTreasuryV2(f, e, s, u, team, r, m) {
        _coin = coin_;
        _name = name_;
    }

    function official() public view override returns (address, address) {
        return (_coin, _name);
    }
}

/// @dev The same treasury with the leftover's conversion replaced by one that fills only a fixed fraction.
///
/// A market that takes part of what it is offered is the one state the fixture below cannot produce. Inside a
/// single `buy()` the leftover is a subset of what that same buy just took out of the market at that same price,
/// and the bound is symmetric, so selling it back always fits. It could still arise against a market whose
/// liquidity is not one even position, so the accounting is written for it, and this seam is what proves it.
/// Only the conversion is replaced; the recording under test is the contract's own.
contract HalfFillingTreasury is FixtureTreasury {
    constructor(
        IFactory f, IFeeEscrow e, LaunchSeeder s, IERC20 u, address team, IQuoteKind r, MarketTickerDeployer m,
        address coin_, address name_
    ) FixtureTreasury(f, e, s, u, team, r, m, coin_, name_) {}

    function convertFixed(address token, uint256 amount, QuoteConverter.Terms calldata offered)
        external
        override
        returns (uint256 out, uint256 used)
    {
        require(msg.sender == address(this), "BuybackTreasuryV2: internal");
        (out, used) = QuoteConverter.toCounter(
            quoteRegistry, marketIssuer, ISeederLike(address(seeder)), address(usdg), token, amount / 4,
            MAX_IMPACT_BPS, _terms(token, true, offered)
        );
    }
}

/// @dev The same treasury with the two internal bounds opened up, so a test can work out for itself what the
/// buy is entitled to before watching it happen. Nothing is overridden; these only read.
contract InspectableTreasury is FixtureTreasury {
    constructor(
        IFactory f, IFeeEscrow e, LaunchSeeder s, IERC20 u, address team, IQuoteKind r, MarketTickerDeployer m,
        address coin_, address name_
    ) FixtureTreasury(f, e, s, u, team, r, m, coin_, name_) {}

    function sizeBuy()
        external
        view
        returns (PoolKey memory key, bool funIs0, uint256 minOut, uint256 sized, LaunchedToken memory l, uint160 limit)
    {
        (address coin_,) = official();
        return _sizeBuy(coin_);
    }

    function boundFor(PoolKey memory key, bool funIs0, LaunchedToken memory l, uint256 amountIn)
        external
        view
        returns (uint256 fits, uint256 minOut, uint160 limit)
    {
        return _boundFor(key, funIs0, l, amountIn);
    }

    /// @dev Just the name leg, so a test can learn how much name a given tranche buys without running the rest.
    function buyNameOnly(uint256 amount, QuoteConverter.Terms calldata offered) external returns (uint256 got) {
        (, address name_) = official();
        (got,) = QuoteConverter.fromCounter(
            quoteRegistry, marketIssuer, ISeederLike(address(seeder)), address(usdg), name_, amount,
            MAX_IMPACT_BPS, _terms(name_, false, offered)
        );
    }
}

/// @dev A treasury whose name leg hands back more name than the dollars that bought it, which is the one
/// condition that makes the coin pool's bound actually cap. No market can do that today: its range starts at
/// parity and it never sells a name below a dollar. The cap exists for a name that can, so this stands in for
/// one. The extra name is dealt in, so the treasury really holds what the leg says it does.
contract SubParNameTreasury is InspectableTreasury, StdCheats {
    uint256 public constant OVER_BPS = 30_000; // three times the dollars paid

    constructor(
        IFactory f, IFeeEscrow e, LaunchSeeder s, IERC20 u, address team, IQuoteKind r, MarketTickerDeployer m,
        address coin_, address name_
    ) InspectableTreasury(f, e, s, u, team, r, m, coin_, name_) {}

    function _toName(address fun, uint256 usdgIn, QuoteConverter.Terms calldata)
        internal
        override
        returns (uint256 got, uint256 usedCounter)
    {
        got = (usdgIn * OVER_BPS) / 10_000;
        usedCounter = usdgIn;
        deal(fun, address(this), IERC20(fun).balanceOf(address(this)) + got);
    }
}

/// @dev The leftover path end to end, on pools built for it: a name market deep enough to fill a whole tranche,
/// and a coin market far too small to absorb the name that tranche buys. The coin leg therefore fills partly and
/// hands the rest back, which is the state the live pools cannot reach because a buy is sized to the coin pool
/// before the name is ever bought.
contract BuybackTreasuryV2LeftoverForkTest is Test {
    address constant FACTORY = 0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f;
    address constant ESCROW = 0xCf706542a17ee6C0Cc9595E3f49d9131aF3331ba;
    address constant SEEDER = 0x3733576410312D34B53F90cFE513B0D0995aB6Ca;
    address constant LIVE_TICKER_LAUNCHER = 0x7f6c8bA781b5bDC499F2BA7501A2178508877649;
    address constant MARKET_DEPLOYER = 0x0F72C545Bd455DB7184F5B0eA4725f5AA8494418;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address constant TEAM = address(0x7EA1);
    uint256 constant Q96 = 1 << 96;

    MarketTickerDeployer dName;
    MarketTickerDeployer dCoin;
    QuoteRegistry reg;
    address name;
    address coin;
    address owner;
    bool forked;

    function setUp() public {
        if (!Fork.select()) return;
        forked = true;
        owner = IFactory(FACTORY).owner();
        _build(MarketTickerDeployer(MARKET_DEPLOYER).fee(), "LEFTOVER");
    }

    /// @dev A name market deep enough to fill a whole tranche, and a coin market priced in that name and far too
    /// small to absorb what the tranche buys. `nameFee` is the name market's own fee, which is what makes the
    /// dollars spent and the name received differ by a knowable amount.
    function _build(uint24 nameFee, string memory tag) internal {
        MarketTickerDeployer live = MarketTickerDeployer(MARKET_DEPLOYER);
        dName = new MarketTickerDeployer(
            address(this), IERC20(USDG), ISeederLike(SEEDER).poolManager(), live.posm(), live.permit2(),
            500_000_000e6, nameFee, live.spacing(), live.width()
        );
        (name,) = dName.create(keccak256(abi.encodePacked(tag, "NAME")), string.concat(tag, "NAME"), 6);

        dCoin = new MarketTickerDeployer(
            address(this), IERC20(name), ISeederLike(SEEDER).poolManager(), live.posm(), live.permit2(),
            200e6, live.fee(), live.spacing(), live.width()
        );
        (coin,) = dCoin.create(keccak256(abi.encodePacked(tag, "COIN")), string.concat(tag, "COIN"), 6);

        reg = new QuoteRegistry(ITickerLauncherLike(LIVE_TICKER_LAUNCHER), dName, USDG);
        reg.record(name);
        _mockCoinPool();
    }

    /// @dev The factory knows nothing about a locally made coin pool, so the two reads `_sizeBuy` makes are
    /// answered from the market itself. Everything else on the factory stays live.
    function _mockCoinPool() internal {
        MarketTickerDeployer.Market memory m = dCoin.market(coin);
        LaunchedToken memory l;
        l.token = coin;
        l.pairToken = name;
        l.poolFee = m.key.fee;
        l.tickSpacing = m.key.tickSpacing;
        l.tickLower = m.tickLower;
        l.tickUpper = m.tickUpper;
        l.liquidity = IPosLiq(address(dCoin.posm())).getPositionLiquidity(m.tokenId);
        l.lpTokenId = m.tokenId;
        l.exists = true;
        vm.mockCall(FACTORY, abi.encodeWithSelector(IFactory.getLaunchedToken.selector, coin), abi.encode(l));
        vm.mockCall(FACTORY, abi.encodeWithSelector(IFactory.poolKeyOf.selector, coin), abi.encode(m.key));
    }

    function terms(uint256 pct, uint256 ahead) internal view returns (QuoteConverter.Terms memory) {
        return QuoteConverter.Terms({minOutPerInX96: (Q96 * pct) / 100, deadline: block.timestamp + ahead});
    }

    function _treasury() internal returns (FixtureTreasury t) {
        t = new FixtureTreasury(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            reg, dName, coin, name
        );
        _policy(t, true, true);
    }

    /// @dev The two directions are separate settings in different units. `sellable` false leaves the name to
    /// counter direction unset, which is what a recovery that cannot be authorised looks like.
    function _policy(BuybackTreasuryV2 t, bool buyable, bool sellable) internal {
        vm.startPrank(owner);
        if (buyable) t.setMinRate(name, false, (Q96 * 50) / 100);
        if (sellable) t.setMinRate(name, true, (Q96 * 50) / 100);
        vm.stopPrank();
    }

    /// @dev Four hundred thousand dollars of revenue: half is earmarked, and a buy spends 5% of that.
    function _fund(BuybackTreasuryV2 t) internal {
        deal(USDG, address(t), 400_000e6);
        t.collect(new address[](0), new QuoteConverter.Terms[](0));
    }

    // ---------------------------------------------------------------- the fixture itself

    /// @notice The coin leg really does fill only partly: it takes what its pool can hold and hands the rest of
    /// the name straight back. Everything below rests on this. The sale direction is left unauthorised here so
    /// the leftover can be seen as it is, before any recovery touches it.
    function test_fork_theCoinLegFillsPartlyAndHandsTheRestBack() public {
        if (!forked) return;
        FixtureTreasury t = new FixtureTreasury(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            reg, dName, coin, name
        );
        _policy(t, true, false);
        _fund(t);
        t.buy(terms(50, 60));

        uint256 burned = IERC20(coin).balanceOf(DEAD);
        uint256 left = IERC20(name).balanceOf(address(t));
        console.log("coin burned / name handed back");
        console.log(burned);
        console.log(left);
        assertGt(burned, 0, "the coin leg did fill");
        assertGt(left, 0, "and it could not take everything");
        assertGt(left, burned * 5, "most of the name came back, which is what a leftover is");
    }

    // ---------------------------------------------------------------- full recovery

    /// @notice The leftover sells back completely, so nothing is left held and the dollars it returned are back
    /// in the earmark rather than counted as spent.
    function test_fork_aLeftoverSoldBackCompletelyLeavesNothingHeld() public {
        if (!forked) return;
        FixtureTreasury t = _treasury();
        _fund(t);
        uint256 earmarkBefore = t.earmarkedUsdg();
        (uint256 spent,) = t.buy(terms(50, 60));

        assertEq(IERC20(name).balanceOf(address(t)), 0, "no name stayed behind");
        assertEq(t.buybackHeld(name), 0, "so nothing is held for the buyback");
        assertEq(t.earmarkedUsdg(), earmarkBefore - spent, "and only what the coin cost left the earmark");
        assertLt(spent, earmarkBefore / 20 + 1, "which is less than the tranche, because most came back");
        assertEq(IERC20(name).balanceOf(TEAM), 0);
    }

    // ---------------------------------------------------------------- partial recovery

    /// @notice A recovery that fills only part of the leftover records the rest as the buyback's, rather than
    /// leaving it to be split as new revenue by the next collect.
    function test_fork_aPartlyRecoveredLeftoverRecordsTheRemainder() public {
        if (!forked) return;
        HalfFillingTreasury t = new HalfFillingTreasury(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            reg, dName, coin, name
        );
        _policy(t, true, true);
        _fund(t);
        t.buy(terms(50, 60));

        uint256 stillHere = IERC20(name).balanceOf(address(t));
        console.log("name still here / recorded as the buyback's");
        console.log(stillHere);
        console.log(t.buybackHeld(name));
        assertGt(stillHere, 0, "the conversion took only part of it");
        assertEq(t.buybackHeld(name), stillHere, "and every unit of the rest is recorded");
    }

    // ---------------------------------------------------------------- failure, then recovery later

    /// @notice A recovery that cannot happen at all leaves the whole leftover held, and a later collect turns it
    /// into dollars that go to the earmark whole. The team takes nothing from money that was already the
    /// buyback's, across a partial conversion and the one that finishes it.
    function test_fork_aFailedRecoveryIsRecoveredLaterAndStaysTheBuybacks() public {
        if (!forked) return;
        FixtureTreasury t = new FixtureTreasury(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            reg, dName, coin, name
        );
        _policy(t, true, false); // the sale direction is unauthorised, so the recovery inside buy cannot run
        _fund(t);
        t.buy(terms(50, 60));

        uint256 held = t.buybackHeld(name);
        assertGt(held, 0, "the whole leftover is held");
        assertEq(IERC20(name).balanceOf(address(t)), held, "and it is all still here");

        // the owner authorises the sale direction, and a first collect converts what the market will take
        _policy(t, false, true);
        uint256 teamBefore = IERC20(USDG).balanceOf(TEAM);
        address[] memory one = new address[](1);
        one[0] = name;
        QuoteConverter.Terms[] memory ts = new QuoteConverter.Terms[](1);
        ts[0] = terms(50, 60);

        (uint256 total, uint256 toTeam, uint256 earmarked) = t.collect(one, ts);
        console.log("held / converted / to team");
        console.log(held);
        console.log(total);
        console.log(toTeam);
        assertGt(total, 0, "it converted");
        assertEq(toTeam, 0, "the team took none of it");
        assertEq(earmarked, total, "all of it went back to the earmark");
        assertEq(IERC20(USDG).balanceOf(TEAM), teamBefore, "and the team wallet did not move");

        uint256 stillHeld = t.buybackHeld(name);
        assertEq(IERC20(name).balanceOf(address(t)), stillHeld, "what is recorded is what is here");
        assertLt(stillHeld, held, "and the converted part was drawn down");

        // whatever the market would not take stays the buyback's through a second attempt too
        if (stillHeld > 0) {
            (uint256 total2, uint256 toTeam2,) = t.collect(one, ts);
            assertEq(toTeam2, 0, "still none of it is the team's");
            assertLe(t.buybackHeld(name), stillHeld);
            console.log("second conversion");
            console.log(total2);
        }
    }

    /// @notice Fresh revenue arriving alongside a held leftover is still split normally. Holding a leftover must
    /// not turn the treasury's ordinary income into buyback money.
    function test_fork_freshRevenueBesideAHeldLeftoverIsStillSplit() public {
        if (!forked) return;
        FixtureTreasury t = new FixtureTreasury(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            reg, dName, coin, name
        );
        _policy(t, true, false);
        _fund(t);
        t.buy(terms(50, 60));
        assertGt(t.buybackHeld(name), 0);

        _policy(t, false, true);
        deal(USDG, address(t), IERC20(USDG).balanceOf(address(t)) + 10_000e6); // plain dollars, plain revenue
        uint256 teamBefore = IERC20(USDG).balanceOf(TEAM);
        address[] memory one = new address[](1);
        one[0] = name;
        QuoteConverter.Terms[] memory ts = new QuoteConverter.Terms[](1);
        ts[0] = terms(50, 60);
        (, uint256 toTeam,) = t.collect(one, ts);

        assertGt(toTeam, 0, "the team's share of the new dollars is still paid");
        assertEq(IERC20(USDG).balanceOf(TEAM) - teamBefore, toTeam);
        assertLe(toTeam, 5_000e6, "and it is only their share of the new dollars, not of the leftover");
    }

    // ---------------------------------------------------------------- the coin leg's minimum

    /// @notice The coin leg's minimum belongs to the name in hand, not to the dollars that bought it.
    ///
    /// The bounded swap holds a price, not a quantity: it divides the minimum by the amount it was handed. So a
    /// minimum kept from the dollars becomes a floor too high by exactly the name market's fee, and refuses a
    /// swap that ran at a perfectly good price. A tenth taken on the way in is enough to show it; at the live
    /// fee the two amounts are close enough that the mistake hides.
    function test_fork_theCoinMinimumFollowsTheNameActuallyReceived() public {
        if (!forked) return;
        _build(100_000, "FEEHEAVY"); // a tenth of the input, so a dollar buys distinctly less than a name
        FixtureTreasury t = _treasury();
        _fund(t);

        (uint256 spent,) = t.buy(terms(50, 60));
        uint256 burned = IERC20(coin).balanceOf(DEAD);
        console.log("dollars spent / coin burned");
        console.log(spent);
        console.log(burned);
        assertGt(burned, 0, "the buy went through on the name it actually held");
    }

    // ---------------------------------------------------------------- the minimum and the amount travel together

    /// @notice The amount handed to the seeder and the minimum handed with it are the pair the bound produced,
    /// and the rate that pair states survives a fill that stops short.
    ///
    /// This is what makes the minimum mean anything. The seeder holds a bounded swap to a price: it scales the
    /// minimum by the fraction of the input the pool actually took. Send it more input than the minimum was
    /// computed for and that fraction shrinks, so the floor shrinks with it, silently. The price limit still
    /// stops the pool, so nothing looks wrong; what is lost is the only check that sees the coin itself, which
    /// is what a launch window's snipe tax comes out of.
    function test_fork_theSubmittedAmountAndItsMinimumMatchAndHoldOnAPartialFill() public {
        if (!forked) return;
        InspectableTreasury t = new InspectableTreasury(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            reg, dName, coin, name
        );
        _policy(t, true, false); // no recovery, so what stays behind is the leftover exactly as the swap left it
        _fund(t);

        // work out, on a branch that is thrown away, what the buy is entitled to ask for
        uint256 snap = vm.snapshotState();
        (PoolKey memory key, bool funIs0,, uint256 sized, LaunchedToken memory l,) = t.sizeBuy();
        uint256 nameIn = t.buyNameOnly(sized, terms(50, 60));
        (uint256 fits, uint256 minOut, uint160 limit) = t.boundFor(key, funIs0, l, nameIn);
        vm.revertToState(snap);

        // the real buy must hand the seeder exactly that amount, with exactly that minimum
        vm.expectCall(
            SEEDER,
            abi.encodeWithSelector(LaunchSeeder.swapExactInBounded.selector, key, funIs0, fits, minOut, DEAD, limit)
        );
        t.buy(terms(50, 60));

        uint256 burned = IERC20(coin).balanceOf(DEAD);
        uint256 taken = nameIn - IERC20(name).balanceOf(address(t));
        console.log("name in hand / submitted / taken by the pool / coin burned");
        console.log(nameIn);
        console.log(fits);
        console.log(taken);
        console.log(burned);

        assertGt(taken, 0, "the pool took something");
        assertLt(taken, fits, "and stopped short of what was submitted, which is the case worth checking");
        // the seeder's own arithmetic, redone here: the floor for a fill that stopped short
        uint256 need = FullMath.mulDiv(minOut, taken, fits);
        assertGt(need, 0, "there is a floor at all");
        assertGe(burned, need, "the rate the bound decided on held on the part that filled");
        // the bound did not have to cap here, and by the design it never does: see the two tests below
        assertEq(fits, nameIn, "the whole of the name in hand was submitted");
    }

    /// @notice The bound caps, and what it hands back is a matched pair: asking it again for exactly the amount
    /// it capped to gives back that same amount and that same minimum. So submitting the pair it returned is
    /// submitting a minimum that belongs to the amount beside it.
    function test_fork_theBoundReturnsAnAmountAndAMinimumThatBelongTogether() public {
        if (!forked) return;
        InspectableTreasury t = new InspectableTreasury(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            reg, dName, coin, name
        );
        (PoolKey memory key, bool funIs0,,, LaunchedToken memory l,) = t.sizeBuy();

        uint256 far = 1_000_000_000e6; // far past anything the coin's pool could take within its impact ceiling
        (uint256 fits, uint256 minOut, uint160 limit) = t.boundFor(key, funIs0, l, far);
        assertGt(fits, 0);
        assertLt(fits, far, "the bound really does cap");

        (uint256 again, uint256 minAgain, uint160 limitAgain) = t.boundFor(key, funIs0, l, fits);
        assertEq(again, fits, "the capped amount is a fixed point of the bound");
        assertEq(minAgain, minOut, "and the minimum beside it is the one that belongs to it");
        assertEq(limitAgain, limit);
        console.log("bound caps at / minimum for it");
        console.log(fits);
        console.log(minOut);
    }

    /// @notice Why the cap cannot bind inside `buy()` as things stand, recorded so a change that breaks it is
    /// visible. The tranche is sized to the coin pool's bound in dollars; a market never sells a name below a
    /// dollar, so the name it returns is never more than the dollars paid. The name in hand is therefore always
    /// within the bound already. The cap is there for the day one of those two facts stops holding.
    function test_fork_theNameInHandNeverExceedsTheDollarsThatBoughtIt() public {
        if (!forked) return;
        InspectableTreasury t = new InspectableTreasury(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            reg, dName, coin, name
        );
        _policy(t, true, false);
        _fund(t);
        (PoolKey memory key, bool funIs0,, uint256 sized, LaunchedToken memory l, uint160 limit) = t.sizeBuy();
        (uint256 bound,,) = t.boundFor(key, funIs0, l, type(uint128).max);

        uint256 nameIn = t.buyNameOnly(sized, terms(50, 60));
        console.log("coin pool's bound / tranche sized to it / name it bought");
        console.log(bound);
        console.log(sized);
        console.log(nameIn);
        assertLe(sized, bound, "the tranche never exceeds the coin pool's bound");
        assertLe(nameIn, sized, "and a name is never cheaper than a dollar, so the name never exceeds it either");
        assertGt(limit, 0);
    }

    // ---------------------------------------------------------------- a cap that binds

    /// @notice The targeted regression for a binding cap. When the name in hand is more than the coin pool's
    /// bound will take, `buy()` must submit the bound's amount with the bound's own minimum, and hold the rest
    /// back as leftover. Submitting the whole amount with that minimum would divide the floor down by the
    /// difference, which here is two thirds of it.
    ///
    /// This is the case the ordinary fixture cannot produce, and it is kept separate for that reason. It needs a
    /// name that sells below a dollar; no market does, so the name leg is replaced with one that does.
    function test_fork_aBindingCapSubmitsTheBoundsAmountAndItsOwnMinimum() public {
        if (!forked) return;
        SubParNameTreasury t = new SubParNameTreasury(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            reg, dName, coin, name
        );
        _policy(t, true, false); // no recovery, so the held-back name stays visible
        _fund(t);

        (PoolKey memory key, bool funIs0,, uint256 sized, LaunchedToken memory l,) = t.sizeBuy();
        uint256 nameIn = (sized * t.OVER_BPS()) / 10_000;
        (uint256 fits, uint256 minOut, uint160 limit) = t.boundFor(key, funIs0, l, nameIn);

        console.log("name in hand / what the bound will take / its minimum");
        console.log(nameIn);
        console.log(fits);
        console.log(minOut);
        assertLt(fits, nameIn, "the cap binds, which is the whole point of this case");

        vm.expectCall(
            SEEDER,
            abi.encodeWithSelector(LaunchSeeder.swapExactInBounded.selector, key, funIs0, fits, minOut, DEAD, limit)
        );
        t.buy(terms(50, 60));

        uint256 held = IERC20(name).balanceOf(address(t));
        assertGe(held, nameIn - fits, "everything the bound would not take is still here, not stranded");
        assertEq(t.buybackHeld(name), held, "and all of it is recorded as the buyback's");
        // the floor that was actually enforced, against the one a mismatch would have given
        uint256 taken = nameIn - held;
        assertGt(
            FullMath.mulDiv(minOut, taken, fits),
            FullMath.mulDiv(minOut, taken, nameIn),
            "the pair submitted enforces a strictly stronger floor than sending the whole amount would"
        );
    }
}
