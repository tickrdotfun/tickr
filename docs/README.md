# tickr protocol docs (v1)


> Independent, immutable contracts, independently deployed. tickr is not affiliated with Robinhood.

Source: [github.com/tickrdotfun/tickr](https://github.com/tickrdotfun/tickr). The design source of truth is [`SPEC.md`](./SPEC.md). The pages below are written from the Solidity in `contracts/src/` and only describe functions, events, errors, and structs that exist there.

## Pages

| Page | What it covers |
|---|---|
| [01 Overview](./01-first-principles.md) | no custody, atomic flows, everything readable on chain, immutable per version |
| [02 What a launch does](./02-lifecycle.md) | create, trade, collect: one transaction opens the coin and its locked pool; the five-second snipe tax |
| [03 Price and market cap](./03-curve-math.md) | the one-sided position as a constant product curve, opening market caps, fees in the math |
| [04 ETH, USDG and Stock Tokens](./04-custom-pairs.md) | mode 1. the three official quote assets, per-asset economics, the `expectedEconomics` pin, native vs ERC-20 calling conventions |
| [05 Invented tickers](./05-anchors.md) | a ticker is a one-for-one wrapper of USDG. inventing one, launching under one, why nobody owns it, the dollar pool, the club, the required disclosure |
| [06 Fees](./06-fees.md) | launch fee, the pool fee, creator tax, the 60/10/30 split, collecting, burning, claims, where the protocol share goes |
| [07 Addresses](./07-addresses.md) | chain facts, canonical Uniswap v4 and v3 addresses on Robinhood Chain, the contract table |
| [09 Risks](./09-risks.md) | what can go wrong, the exact list of owner powers, unaudited status |
| [10 tickr coins](./10-coin-quotes.md) | mode 3. pricing a launch in a coin this factory launched, and the guardrails on it |
| [11 Stock Token quotes](./11-stock-quotes.md) | mode 4. pricing a launch in a Stock Token, sized from its live Chainlink feed |
| [12 Buying with ETH](./12-zap.md) | the ZapRouter: any coin, one transaction, paid in ETH |
| [13 Official coin](./13-official-coin.md) | TICKR priced in FUN: the first launch, on the same rules as every launch, how it was made first, and the buyback that burns it |
| [14 Liquidity lock](./14-liquidity-lock.md) | what the locker holds, what it can do, what it cannot, and how to check |
| [15 Launching from code](./15-launching-from-code.md) | the pinned preview, every quote asset, knowing the address first, metadata |
| [16 Trading from code](./16-trading-from-code.md) | one pool, routing from ETH, collecting fees and claiming |
| [17 Reading state](./17-reading-state.md) | the launch record, pool key and price via `extsload`, fees owed, ticker views, the treasury's views, the site's endpoints |
| [18 Events and errors](./18-events-and-errors.md) | the full event list, every named error and what to do about it |
| [19 Any token with a market](./19-market-quotes.md) | mode 5. pricing a launch in any token on the chain with a deep enough Uniswap v3 pool against WETH or USDG |

## Conventions used in these docs

- "Quote" is the asset a curve is priced in: native ETH (`address(0)`) or an approved ERC-20. "Token" / "meme" is the launched ERC-20.
- All bps values are out of `10_000`.
- Solidity signatures are quoted as they appear in `contracts/src/`. Addresses marked "TBD" are filled from `contracts/deployments/4663.json`, which `contracts/script/Deploy.s.sol` writes after deployment.
