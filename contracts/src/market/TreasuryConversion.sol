// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IQuoteKind} from "./IQuoteKind.sol";
import {QuoteConverter, ISeederLike} from "./QuoteConverter.sol";
import {MarketTickerDeployer} from "./MarketTickerDeployer.sol";

/// @title TreasuryConversion
/// @notice The treasury's three conversion sites, made version aware, with the accounting the treasury depends
/// on stated as postconditions rather than left implicit.
///
/// This is a prototype of the wiring, not a replacement treasury. It holds the balances and the earmark so the
/// four properties can be tested in isolation:
///
/// 1. only counter actually received is credited as revenue
/// 2. a name that could not be converted stays where it is, still attributed, still convertible later
/// 3. a partial or zero fill can never mark a buy complete
/// 4. converting one asset never touches another's balance or the standing earmark
contract TreasuryConversion {
    using SafeERC20 for IERC20;

    IQuoteKind public immutable registry;
    MarketTickerDeployer public immutable marketIssuer;
    ISeederLike public immutable seeder;
    IERC20 public immutable counter;
    address public immutable teamWallet;

    /// @notice Counter set aside for buys and not yet spent.
    uint256 public earmarked;
    /// @notice Counter recognised as revenue, ever. Only what actually arrived.
    uint256 public totalRecognised;
    /// @notice What a name still owes us, by name: raised when a conversion cannot happen, cleared when it does.
    mapping(address => uint256) public unconverted;

    event Recognised(address indexed token, uint256 counterIn, uint256 spent);
    event NotConverted(address indexed token, uint256 held, bytes reason);
    event Bought(address indexed token, uint256 counterSpent, uint256 tokensOut);

    error NothingEarmarked();
    error BuyIncomplete(uint256 wanted, uint256 spent);

    constructor(
        IQuoteKind registry_,
        MarketTickerDeployer marketIssuer_,
        ISeederLike seeder_,
        IERC20 counter_,
        address teamWallet_
    ) {
        registry = registry_;
        marketIssuer = marketIssuer_;
        seeder = seeder_;
        counter = counter_;
        teamWallet = teamWallet_;
    }

    /// @notice Convert what we hold of `token` into counter and recognise only what arrived.
    ///
    /// A conversion that cannot happen is recorded and the balance left alone. It is never forwarded to the team
    /// as though it were unconvertible for good, and never counted as revenue it did not produce.
    function collectOne(address token, uint256 maxImpactBps, QuoteConverter.Terms memory terms)
        external
        returns (uint256 recognised, uint256 spent)
    {
        uint256 held = IERC20(token).balanceOf(address(this));
        if (held == 0) return (0, 0);

        uint256 counterBefore = counter.balanceOf(address(this));
        try this.convert(token, held, maxImpactBps, terms) returns (uint256 out, uint256 used) {
            // trust the measured balance, never the reported figure
            uint256 arrived = counter.balanceOf(address(this)) - counterBefore;
            recognised = arrived < out ? arrived : out;
            spent = used;
            totalRecognised += recognised;
            unconverted[token] = IERC20(token).balanceOf(address(this));
            emit Recognised(token, recognised, spent);
        } catch (bytes memory reason) {
            // an unprimed market, an expired quote, a rate that moved: the name stays ours and stays counted
            unconverted[token] = held;
            emit NotConverted(token, held, reason);
        }
    }

    /// @dev External so `collectOne` can catch a revert without losing the rest of the collection.
    function convert(address token, uint256 amount, uint256 maxImpactBps, QuoteConverter.Terms memory terms)
        external
        returns (uint256 out, uint256 used)
    {
        require(msg.sender == address(this), "TreasuryConversion: internal");
        return QuoteConverter.toCounter(registry, marketIssuer, seeder, address(counter), token, amount, maxImpactBps, terms);
    }

    /// @notice Convert and recognise, letting any refusal through to the caller. The tolerant path is
    /// `collectOne`, which records the refusal instead; this one is for a caller who wants to know why.
    function convertStrict(address token, uint256 amount, uint256 maxImpactBps, QuoteConverter.Terms memory terms)
        external
        returns (uint256 recognised, uint256 spent)
    {
        uint256 counterBefore = counter.balanceOf(address(this));
        (uint256 out, uint256 used) =
            QuoteConverter.toCounter(registry, marketIssuer, seeder, address(counter), token, amount, maxImpactBps, terms);
        uint256 arrived = counter.balanceOf(address(this)) - counterBefore;
        recognised = arrived < out ? arrived : out;
        spent = used;
        totalRecognised += recognised;
        unconverted[token] = IERC20(token).balanceOf(address(this));
        emit Recognised(token, recognised, spent);
    }

    /// @notice Set aside counter for buys. Only counter we actually hold beyond the standing earmark.
    function earmark(uint256 amount) external {
        require(counter.balanceOf(address(this)) >= earmarked + amount, "TreasuryConversion: not held");
        earmarked += amount;
    }

    /// @notice Spend earmarked counter on `token`. A partial or zero fill spends only what it used and leaves the
    /// rest earmarked; it never reports the buy as done.
    function buy(address token, uint256 want, uint256 maxImpactBps, QuoteConverter.Terms memory terms)
        external
        returns (uint256 tokensOut, uint256 spent)
    {
        if (earmarked == 0) revert NothingEarmarked();
        uint256 size = want > earmarked ? earmarked : want;
        uint256 tokenBefore = IERC20(token).balanceOf(address(this));

        (uint256 out, uint256 used) =
            QuoteConverter.fromCounter(registry, marketIssuer, seeder, address(counter), token, size, maxImpactBps, terms);

        tokensOut = IERC20(token).balanceOf(address(this)) - tokenBefore;
        if (tokensOut > out) tokensOut = out;
        spent = used;
        // only what was actually spent leaves the earmark; the remainder is still ours to try again with
        earmarked -= spent;
        emit Bought(token, spent, tokensOut);
    }

    /// @notice The same buy, but the caller insists it complete. Used to prove a partial fill cannot pass for one.
    function buyOrRevert(address token, uint256 want, uint256 maxImpactBps, QuoteConverter.Terms memory terms)
        external
        returns (uint256 tokensOut)
    {
        uint256 spent;
        (tokensOut, spent) = this.buy(token, want, maxImpactBps, terms);
        if (spent < want) revert BuyIncomplete(want, spent);
    }
}
