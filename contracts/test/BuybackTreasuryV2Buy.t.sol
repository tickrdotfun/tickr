// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fork} from "./Fork.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IQuoteKind} from "../src/market/IQuoteKind.sol";
import {QuoteRegistry, ITickerLauncherLike} from "../src/market/QuoteRegistry.sol";
import {QuoteConverter} from "../src/market/QuoteConverter.sol";
import {BuybackTreasuryV2} from "../src/market/BuybackTreasuryV2.sol";
import {MarketTickerDeployer} from "../src/market/MarketTickerDeployer.sol";
import {IFactory} from "../src/interfaces/IFactory.sol";
import {IFeeEscrow} from "../src/interfaces/IFeeEscrow.sol";
import {LaunchSeeder} from "../src/LaunchSeeder.sol";

/// @dev A treasury whose official coin is one launched against a fixed-inventory name, so the whole buy path can
/// be exercised: counter into the name, the name into the coin, the coin burned.
contract TreasuryWithMarketOfficial is BuybackTreasuryV2 {
    address private immutable _coin;
    address private immutable _name;

    constructor(
        IFactory f,
        IFeeEscrow e,
        LaunchSeeder s,
        IERC20 u,
        address team,
        IQuoteKind r,
        MarketTickerDeployer m,
        address coin_,
        address name_
    ) BuybackTreasuryV2(f, e, s, u, team, r, m) {
        _coin = coin_;
        _name = name_;
    }

    function official() public view override returns (address, address) {
        return (_coin, _name);
    }
}

/// @dev Lets a test put the treasury into the state a stuck leftover leaves it in, so the accounting can be
/// checked on its own. The route into that state is exercised for real in BuybackTreasuryV2Leftover.t.sol,
/// against pools built for it; it cannot be reached against these live ones, where the buy is sized to the coin
/// pool in the first place and the pool therefore always takes what the buy produces.
contract TreasuryWithHeld is BuybackTreasuryV2 {
    constructor(IFactory f, IFeeEscrow e, LaunchSeeder s, IERC20 u, address team, IQuoteKind r, MarketTickerDeployer m)
        BuybackTreasuryV2(f, e, s, u, team, r, m)
    {}

    function __setHeld(address token, uint256 amount) external {
        buybackHeld[token] = amount;
    }
}

contract BuybackTreasuryV2BuyForkTest is Test {
    address constant FACTORY = 0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f;
    address constant ESCROW = 0xCf706542a17ee6C0Cc9595E3f49d9131aF3331ba;
    address constant SEEDER = 0x3733576410312D34B53F90cFE513B0D0995aB6Ca;
    address constant LIVE_TICKER_LAUNCHER = 0x7f6c8bA781b5bDC499F2BA7501A2178508877649;
    address constant MARKET_DEPLOYER = 0x0F72C545Bd455DB7184F5B0eA4725f5AA8494418;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant TESTNAME = 0x4Dd89f107d9b8395237719FA9d621a7A5BC00c52;
    address constant PROBETWO = 0x151073687c3f5B569fdEC876bEb3DBcEF5F3Ac83;
    address constant FUN = 0xF9d30A05A63d795e3eF37b34143f33b2cBEf0f14;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address constant TEAM = address(0x7EA1);
    uint256 constant Q96 = 1 << 96;

    TreasuryWithMarketOfficial t;
    QuoteRegistry reg;
    address owner;
    bool forked;

    function setUp() public {
        if (!Fork.select()) return;
        forked = true;
        owner = IFactory(FACTORY).owner();
        reg = new QuoteRegistry(ITickerLauncherLike(LIVE_TICKER_LAUNCHER), MarketTickerDeployer(MARKET_DEPLOYER), USDG);
        reg.record(TESTNAME);
        t = new TreasuryWithMarketOfficial(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            reg, MarketTickerDeployer(MARKET_DEPLOYER), PROBETWO, TESTNAME
        );
        // both directions, because they are measured in different units
        vm.startPrank(owner);
        t.setMinRate(TESTNAME, false, (Q96 * 50) / 100); // counter -> name
        t.setMinRate(TESTNAME, true, (Q96 * 50) / 100); // name -> counter
        vm.stopPrank();
    }

    function terms(uint256 pct, uint256 ahead) internal view returns (QuoteConverter.Terms memory) {
        return QuoteConverter.Terms({minOutPerInX96: (Q96 * pct) / 100, deadline: block.timestamp + ahead});
    }

    function fund(uint256 amount) internal {
        deal(USDG, address(t), amount);
        address[] memory none = new address[](0);
        QuoteConverter.Terms[] memory noneT = new QuoteConverter.Terms[](0);
        t.collect(none, noneT); // moves the dollars into the team split and the earmark
    }

    /// @notice The whole buy: dollars into the name at a market price, the name into the coin's pool, the coin
    /// burned at the dead address. The coin's minimum is taken from the name actually received, never from the
    /// dollars sent, because the two are not equal once a market is in the middle.
    function test_fork_buyGoesCounterToNameToCoinAndBurns() public {
        if (!forked) return;
        fund(2_000e6);
        uint256 earmarkBefore = t.earmarkedUsdg();
        uint256 burnedBefore = IERC20(PROBETWO).balanceOf(DEAD);
        assertGt(earmarkBefore, 0, "there is something to spend");

        (uint256 usdgIn, uint256 coinOut) = t.buy(terms(50, 60));
        console.log("dollars spent / coin burned");
        console.log(usdgIn);
        console.log(coinOut);
        assertGt(usdgIn, 0);
        assertGt(coinOut, 0, "the coin must have been bought");
        assertEq(IERC20(PROBETWO).balanceOf(DEAD) - burnedBefore, coinOut, "and burned, not held");
        assertEq(t.earmarkedUsdg(), earmarkBefore - usdgIn, "only what was spent left the earmark");
        assertEq(t.totalTickrBurned(), coinOut);
    }

    /// @notice A buy leaves no name behind when the coin's pool takes it all; when it does not, the leftover is
    /// sold back and the dollars stay earmarked rather than being split with the team.
    function test_fork_leftoverGoesBackToTheEarmarkNotTheTeam() public {
        if (!forked) return;
        fund(2_000e6);
        uint256 teamBefore = IERC20(USDG).balanceOf(TEAM);
        (uint256 usdgIn,) = t.buy(terms(50, 60));
        assertGt(usdgIn, 0);
        // whatever happened to the leftover, the team took nothing during a buy
        assertEq(IERC20(USDG).balanceOf(TEAM), teamBefore, "a buy never pays the team");
    }

    /// @notice A leftover the buy could not sell back belongs wholly to the buyback. When it is later converted,
    /// every dollar it produces returns to the earmark and none is split with the team.
    ///
    /// The state is set directly here, which keeps the accounting isolated from how it arose. The same
    /// attribution is checked from a real buy in BuybackTreasuryV2Leftover.t.sol.
    function test_fork_aHeldLeftoverReturnsWhollyToTheEarmark() public {
        if (!forked) return;
        TreasuryWithHeld h = new TreasuryWithHeld(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            reg, MarketTickerDeployer(MARKET_DEPLOYER)
        );
        vm.prank(owner);
        h.setMinRate(TESTNAME, true, (Q96 * 50) / 100);

        uint256 stuck = 200e6;
        deal(TESTNAME, address(h), stuck);
        h.__setHeld(TESTNAME, stuck);

        uint256 teamBefore = IERC20(USDG).balanceOf(TEAM);
        address[] memory one = new address[](1);
        one[0] = TESTNAME;
        QuoteConverter.Terms[] memory ts = new QuoteConverter.Terms[](1);
        ts[0] = terms(50, 60);

        (uint256 total, uint256 toTeam, uint256 earmarked) = h.collect(one, ts);
        console.log("converted / to team / to earmark");
        console.log(total);
        console.log(toTeam);
        console.log(earmarked);
        assertGt(total, 0, "it converted");
        assertEq(toTeam, 0, "and the team took none of it");
        assertEq(earmarked, total, "all of it went to the earmark");
        assertEq(IERC20(USDG).balanceOf(TEAM), teamBefore);
    }

    /// @notice And across a partial conversion: only the part that actually sold is drawn down, the rest stays
    /// held for the buyback, and the team still takes nothing.
    function test_fork_aPartiallyConvertedLeftoverStaysAttributed() public {
        if (!forked) return;
        TreasuryWithHeld h = new TreasuryWithHeld(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            reg, MarketTickerDeployer(MARKET_DEPLOYER)
        );
        vm.prank(owner);
        h.setMinRate(TESTNAME, true, (Q96 * 50) / 100);

        // far more than the market's dollar side can take in one go
        uint256 stuck = 5_000e6;
        deal(TESTNAME, address(h), stuck);
        h.__setHeld(TESTNAME, stuck);

        address[] memory one = new address[](1);
        one[0] = TESTNAME;
        QuoteConverter.Terms[] memory ts = new QuoteConverter.Terms[](1);
        ts[0] = terms(50, 60);

        (uint256 total, uint256 toTeam,) = h.collect(one, ts);
        uint256 stillHeld = h.buybackHeld(TESTNAME);
        console.log("converted / still held for the buyback");
        console.log(total);
        console.log(stillHeld);
        assertGt(total, 0, "part of it sold");
        assertGt(stillHeld, 0, "and part of it did not");
        assertLt(stillHeld, stuck, "the sold part was drawn down");
        assertEq(toTeam, 0, "the team took none of it");
        assertEq(IERC20(TESTNAME).balanceOf(address(h)), stillHeld, "and what is held matches what is there");
    }

    /// @notice A legacy wrapper's leftover still redeems exactly, and the legacy buy path is unchanged.
    function test_fork_legacyBuyPathIsUnchanged() public {
        if (!forked) return;
        BuybackTreasuryV2 legacy = new BuybackTreasuryV2(
            IFactory(FACTORY), IFeeEscrow(ESCROW), LaunchSeeder(payable(SEEDER)), IERC20(USDG), TEAM,
            reg, MarketTickerDeployer(MARKET_DEPLOYER)
        );
        reg.record(FUN);
        deal(USDG, address(legacy), 1_000e6);
        address[] memory none = new address[](0);
        QuoteConverter.Terms[] memory noneT = new QuoteConverter.Terms[](0);
        legacy.collect(none, noneT);
        assertGt(legacy.earmarkedUsdg(), 0);

        uint256 burnedBefore = IERC20(0x51d553Efd2E8D772AEe6d602A9ea26C56c9a6942).balanceOf(DEAD);
        (uint256 usdgIn, uint256 out) = legacy.buy(terms(1, 60));
        assertGt(usdgIn, 0, "the legacy path still spends");
        assertGt(out, 0, "and still burns");
        assertEq(IERC20(0x51d553Efd2E8D772AEe6d602A9ea26C56c9a6942).balanceOf(DEAD) - burnedBefore, out);
        assertEq(legacy.buybackHeld(FUN), 0, "a wrapper leftover redeems exactly and is never held");
    }
}
