# 10 · tickr coins (Mode 3)

A launch can be priced in **another coin this factory already launched**, instead of ETH, USDG, a Stock Token, or a
DIY quote. Contract: `CoinQuoteLauncher`.

## Why

Buying the new coin requires holding the quote coin, so every buy is demand for it. The new
coin seeds a `NEW/QUOTE` Uniswap v4 pool whose position goes to `LaunchLocker` and can never be withdrawn, so the quote
coin's market gets permanently deeper. A community can let people launch coins on top of their coin.

## Guardrails

Checked in this order by `quotePrice`, which every other entry point routes through:

| # | Rule | Error | Why |
|---|------|-------|-----|
| 1 | The quote must be a coin this factory launched | `QuoteNotLaunchedHere` | Third-party tokens can charge fees on transfer, rebase, or blocklist. `Curve` assumes it receives exactly what was sent, so any of those silently corrupt `realQuote` and strand the launch. Our own `Token` has no transfer hooks and a fixed supply. |
| 2 | The quote coin must itself be priced against an approved anchor | `QuoteTooDeep` | Depth one only. Without this a launch could sit on a tower of launches, where the bottom falling to zero destroys everything above it. A DIY quote is never an anchor, so a DIY launch can never be used as a quote. |
| 3 | The quote coin's pool must have liquidity at the current price | `QuotePriceUnavailable` | Otherwise it has no readable price. |
| 4 | The threshold is sized from the quote's live pool reserves and pinned | `LaunchEconomicsMismatch` | `previewLaunch` returns the hash to pass as `expectedEconomics`, so terms cannot move between the quote a creator reads and the transaction they send. |

`isEligibleQuote(coin)` returns a bool and never reverts, so a front end can filter the whole launch list on-chain.

## Economics

`quoteEconomics` reads the quote coin's pool (`slot0` and the liquidity in range at the current price) and derives
its reserves, `rCoin` of the coin and `rBase` of the base asset. The threshold is the amount of the quote coin that
the base asset's target raise buys out of that pool at constant product:

```
threshold = rCoin * target / (rBase + target)   // quote-coin units, 18 decimals; target = targetRaise[baseAsset]
phantom   = threshold * 40%
```

The model holds that liquidity constant through the trade. The launch position, from the opening price to the end
of the range, is exactly that; positions other people add or remove change what an actual buy of the target would
cost, in either direction and by however much they add or remove. The threshold is a sizing convention for the
opening market cap of the new coin, pinned at launch; it is not a quote anyone trades at and it promises nothing
about the executable value of the quote coin. The result is pinned in the preview, so a creator sees the price it gives before
signing, and a launch whose quote pool has moved since the preview reverts.

Spot alone, `target / price`, would ask for the whole reserve or more whenever the base reserve is near the target, which no buyer could ever fill. Sizing the threshold as a buy out of the reserve keeps it to what the quote's market can actually deliver, however deep or shallow that market is, and each later coin under the same quote sees a threshold sized to what is left.
`previewLaunch` also returns the spot price from `quotePrice` (`priceX18`, base-asset units per `1e18` of the coin,
inverted when the coin is `currency1`) for display.

`targetRaise` is set per base asset by the owner, so a launch priced in any coin costs a comparable amount of real money to move, whichever coin it is priced in.

## Calling it

```solidity
(bytes32 expectedEconomics, PairEconomics memory econ, address baseAsset, uint256 priceX18)
    = coinQuoteLauncher.previewLaunch(launchConfigId, quoteCoin);

// params.expectedEconomics = expectedEconomics, so the launch reverts if the quote pool moved since the preview
(address token, bytes32 poolId) = coinQuoteLauncher.launchWithCoinQuote{value: factory.launchFee()}(params, launchConfigId, quoteCoin);

// or with the creator's first buy in the same transaction: `coinIn` of the quote coin, approved to the launcher first
(address token2, bytes32 poolId2, uint256 tokensOut) =
    coinQuoteLauncher.launchWithCoinQuoteAndBuy{value: factory.launchFee()}(params, launchConfigId, quoteCoin, coinIn, minTokensOut);
```

Event: `CoinQuoteLaunched(token, poolId, quoteCoin, baseAsset, quotePriceX18, phantomQuote)`.

For a first buy in the same transaction, use `launchWithCoinQuoteAndBuy`, described below.

## What it inherits

Everything the factory gives every launch: the same pool, the same locked position, the same fee split and the same snipe tax and launch protection, and the creator is paid in the coin their launch trades against, like every other mode. `CoinQuoteLauncher` holds no
funds and has no privilege beyond being a registrar on the factory.

## Risks

The new coin carries the quote coin's risk on top of its own. If the quote coin's market collapses, the new coin's
liquidity collapses with it, and the pool cannot be migrated because it is locked. Prices are denominated in a volatile
asset, so a chart can rise against the quote coin while falling in dollar terms.

## The creator's first buy, the dev buy

`launchWithCoinQuoteAndBuy` launches and buys in one transaction. Approve the launcher for `coinIn` of the quote
coin first, and send `factory.launchFee()` as value; anything else reverts `BadValue`.

The launcher pulls `coinIn` from you, launches, then swaps it in the new pool through `LaunchSeeder.swapExactIn`
with the coin delivered **to you**, not to itself. So the snipe tax and the launch-block caps see your wallet, the
same as any other buyer, and `minTokensOut` is yours to set: pass a real one, since a first buy on a brand new
pool has no reference price to fall back on. What the pool did not take is returned to you, measured against the
launcher's balance before your funds arrived, so nothing it held beforehand can leave with the refund.

It emits `FirstBuy(token, quoteIn, tokensOut)` alongside the launch event. The launcher holds no funds between
transactions and has no privilege beyond being a registrar on the factory.


