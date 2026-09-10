# 11 · Stock Token quotes (Mode 4)

A launch can be priced in an official Stock Token, with the opening market cap sized from that asset's live
Chainlink feed. Contract: `StockQuoteLauncher`.

## Why a feed and not a fixed number

The threshold is denominated in the quote asset. A fixed number of tokens would mean incomparable raises: ten tokens
of an $11 stock and ten of a $1,600 stock are not the same ask. So the owner sets **one USD target**, and every launch
converts it through its own asset's feed.

```
threshold = targetRaiseUsd * 10^tokenDecimals / price
phantom   = threshold * 40%
```

`targetRaiseUsd` and `price` share the feed's decimals, which is 8 on this chain, so those cancel and the result is in
token units. At an $8,090 target: NVDA at $224.01 needs 36.11 tokens, AAPL at $326.32 needs 24.79. Both are worth the
same.

The feed answer is the price of **one token**, with the corporate-action multiplier already applied. Do not apply
`uiMultiplier()` on top of it.

## Guardrails

Checked in order by `stockPrice`, which every other entry point routes through:

| Rule | Error |
|------|-------|
| The asset is an active, official Stock Token in `AnchorRegistry` (kind 2) | `NotOfficialStockToken` |
| It has a feed registered against it | `NoFeed` |
| The feed answer is positive | `BadPrice` |
| The feed is fresher than `maxStaleness`, three days at deploy so Friday's close still counts through the weekend, and its round is complete (`answeredInRound >= roundId`) | `StalePrice` |
| Terms are pinned through `previewLaunch` before launching | `LaunchEconomicsMismatch` |

`isEligibleQuote(token)` returns a bool and never reverts, so a front end can filter the list on-chain.

A same-ticker impostor cannot get in: eligibility is decided by the registry, not by the token's own metadata.

## Registering the assets

The registry is owner-curated. `config/stock-tokens-4663.json` holds the verified set, and
`script/RegisterStockTokens.s.sol` registers them in one batch through `AnchorRegistry.registerMany`.

Nothing is registered on the strength of the file alone. The script re-checks every entry against the chain first:
the token's `symbol()` must equal the ticker, `decimals()` must be 18, and the feed must return a positive answer.
Entries that fail are skipped and logged.

The list itself was built by cross-referencing the Chainlink feeds published for this chain against the tokens
deployed on it, then verifying each candidate on-chain. The marker that separates a Stock Token from a crypto asset is
ERC-8056: Stock Tokens implement `uiMultiplier()`, crypto assets do not. That yielded 34 assets.

## Calling it

```solidity
(bytes32 expectedEconomics, PairEconomics memory econ, uint256 priceUsd)
    = stockQuoteLauncher.previewLaunch(launchConfigId, stockToken);

// params.expectedEconomics = expectedEconomics, so the launch reverts if the feed moved since the preview
(address token, bytes32 poolId) =
    stockQuoteLauncher.launchWithStockQuote{value: factory.launchFee()}(params, launchConfigId, stockToken);

// or with the creator's first buy in the same transaction: `stockIn` of the Stock Token, approved to the launcher first
(address token2, bytes32 poolId2, uint256 tokensOut) = stockQuoteLauncher.launchWithStockQuoteAndBuy{
    value: factory.launchFee()
}(params, launchConfigId, stockToken, stockIn, minTokensOut);
```

Event: `StockQuoteLaunched(token, poolId, stockToken, priceUsd, phantomQuote)`. For a first buy in the same
transaction, use `launchWithStockQuoteAndBuy`, described below.

## What it inherits

Everything the factory gives every launch: the same pool, the same locked position, the same fee split, and the
same snipe tax and launch protection. The creator is paid in the Stock Token their launch trades against, and its
pool is paired against it. `StockQuoteLauncher` holds no funds and has no privilege beyond being a registrar on
the factory.

## Risks

The launch carries the underlying equity's risk on top of its own, including market hours and corporate actions. If a
feed goes stale, new launches against that asset are refused, but launches already trading are unaffected: the
threshold was fixed at creation. The owner can deactivate an asset, which stops new launches only.

## The creator's first buy, the dev buy

`launchWithStockQuoteAndBuy` launches and buys in one transaction. Approve the launcher for `coinIn` of the Stock Token first, and send `factory.launchFee()` as value; anything else reverts `BadValue`.

The launcher pulls `coinIn` from you, launches, then swaps it in the new pool through `LaunchSeeder.swapExactIn`
with the coin delivered **to you**, not to itself. So the snipe tax and the launch-block caps see your wallet, the
same as any other buyer, and `minTokensOut` is yours to set: pass a real one, since a first buy on a brand new
pool has no reference price to fall back on. What the pool did not take is returned to you, measured against the
launcher's balance before your funds arrived, so nothing it held beforehand can leave with the refund.

It emits `FirstBuy(token, quoteIn, tokensOut)` alongside the launch event. The launcher holds no funds between
transactions and has no privilege beyond being a registrar on the factory.


