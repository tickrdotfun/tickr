# 19 · Any token with a market (Mode 5)

> One of the quote assets a launch can use. The others are ETH, USDG and Stock Tokens (04), an invented name (05), and a tickr coin (10).

A launch can be priced in **any ERC-20 on Robinhood Chain with a deep enough Uniswap v3 pool**: a pool against WETH or USDG, from the canonical v3 factory, holding at least the floor of that counter asset. `MarketQuoteLauncher` reads the pool at the moment of launch, sizes the opening market cap from it, and opens the coin's own pool against the token like every other launch.

## What counts as a market

| rule | value |
| --- | --- |
| pool | Uniswap v3, canonical factory, any fee tier |
| counter | WETH first; USDG only when no WETH pool clears both floors |
| floor, total | 5 WETH, or 15,000 USDG, held by the pool (`minDepth`) |
| floor, at the price | the same amount the pool would pay out to sellers of the token within 5% of the current price (`BAND_BPS`), measured by walking the pool's ticks |
| decimals | six or more |
| price | the pool's spot price when the launch is sent |

The second floor is the one that matters: it is the counter asset a seller could actually take out near the price, which cannot be faked with free liquidity of the token itself, and capital parked far out of range does not count. It is still a reading of the current block: a flash loan can satisfy it for one transaction. For that reason this mode ships switched off (`ENABLE_MARKET_QUOTES`), and the site hides it, until the check also asks the pool's own price history. Among the pools that clear both, the one that absorbs the most within the band wins. A WETH market always beats a USDG one, so a token with both is priced against ETH.

Three kinds of token are refused here because a better price source exists: ETH, USDG and Stock Tokens go through their own paths (04, 11), and coins launched by this factory go through the coin quote launcher (10), which reads their own v4 pool.

## The opening market cap

The launcher converts the ETH target (or the USDG target for a USDG market) into the token at the pool's spot price, and takes forty percent of that as the phantom reserve, the same ratio every other mode uses:

```
threshold  = targetRaise[base] * 1e18 / basePerQuoteX18
phantom    = threshold * 4000 / 10000
```

`basePerQuoteX18` is the pool's `sqrtPriceX96` squared, oriented so it reads as WETH (or USDG) raw units per 1e18 raw units of the token. The result is denominated in the token's own decimals. In dollar terms the opening market cap matches an ETH or USDG launch on the day, because it is the same target converted.

## Spot, and the pin

The price is spot, not an average. The floor at the price is a cost, not a lock: somebody who keeps a deep pool at a false price for the whole time between your preview and your launch can still show you that price, and the site shows the market cap in dollars for exactly that reason. Look at it. What protects the creator is `expectedEconomics`: the preview hashes the terms, the launch recomputes them from the pool and reverts on any difference. A price that moves between preview and send fails closed. Somebody who moves the pool in the same block can only make a launch revert, never change its terms.

## Reads

```solidity
function bestMarket(address quote) view returns (Market memory);      // pool, counter, fee, depth; reverts with the reason
function quotePrice(address quote) view returns (Market memory, address base, uint256 basePerQuoteX18);
function quoteEconomics(address quote) view returns (PairEconomics memory);
function previewLaunch(uint256 launchConfigId, address quote) view returns (bytes32 expectedEconomics, PairEconomics memory, Market memory, address base, uint256 basePerQuoteX18);
function isEligibleQuote(address quote) view returns (bool);           // never reverts
function minDepth(address counter) view returns (uint256);
function targetRaise(address base) view returns (uint256);
```

## Launching

```solidity
function launchWithMarketQuote(TokenParams params, uint256 launchConfigId, address quote) payable returns (address token, bytes32 poolId);
function launchWithMarketQuoteAndBuy(TokenParams params, uint256 launchConfigId, address quote, uint256 quoteIn, uint256 minTokensOut) payable returns (address token, bytes32 poolId, uint256 tokensOut);
```

`value` is the launch fee. The first buy is paid in the token itself, pulled from the caller and spent in the new pool in the same transaction. Errors: `QuoteIsAnchor`, `QuoteLaunchedHere`, `NoMarket`, `QuotePriceUnavailable`, `NoTargetRaise`, `BadValue`.

## Buying such a coin with ETH

The zap ([12](./12-zap.md)) walks ETH into the token through its v3 pool, or through ETH/USDG and then a USDG pool, and then into the coin's own pool, in one transaction. Selling walks the same route back.

## Owner powers

The owner can change `minDepth` per counter and `targetRaise` per base, for future launches only. Every launch already made keeps the terms frozen at its launch.

## The list on the create page

The site lists every token that clears the floor, in order of depth, with its market cap and the venues it trades on. The list is read from the chain with the same rule the contract applies, so what is shown is what the launcher accepts, and the preview before signing is the contract's own.
