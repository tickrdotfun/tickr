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
| The feed is fresher than `maxStaleness` | `StalePrice` |
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

// params.expectedEconomics = expectedEconomics
stockQuoteLauncher.launchWithStockQuote{value: factory.launchFee()}(
);
```

Event: `StockQuoteLaunched(token, poolId, stockToken, priceUsd, phantomQuote)`. For a first buy in the same
transaction, use `launchWithStockQuoteAndBuy`, described below.

## What it inherits

launch trades against, and its pool is paired against it. `StockQuoteLauncher` holds no funds and has no
privilege beyond being a registrar on the factory.

## Risks

The launch carries the underlying equity's risk on top of its own, including market hours and corporate actions. If a
feed goes stale, new launches against that asset are refused, but launches already trading are unaffected: the
threshold was fixed at creation. The owner can deactivate an asset, which stops new launches only.

## The creator's first buy, the dev buy

