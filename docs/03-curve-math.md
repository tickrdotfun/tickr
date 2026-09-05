# 03 · Price and market cap

There is no curve contract. The launch position is the curve: one Uniswap v4 position holding the entire supply from the opening price to the end of the range. This page is what that means in numbers.

## The opening price

Each pair has a `phantomQuote`, call it `P`: 1.68 ETH for ETH, 3,236 USDG for USDG and invented tickers, and for a Stock Token or a coin the amount its launcher derives from the live price at launch (see [04](./04-custom-pairs.md), [10](./10-coin-quotes.md), [11](./11-stock-quotes.md)). With `S` the supply, always 1,000,000,000 coins, the pool opens at

```
p0 = P / S    quote per coin
```

`LaunchSeeder.seedLaunch` aligns that to the pool's tick spacing of 10, which is a step of 0.1%, and mints the position from that tick to the last usable tick with all `S` coins on the coin's side and nothing on the quote side. The opening market cap is `p0 * S = P`, the same figure for every quote asset once converted, because every launcher sizes `P` from a dollar target.

## What the position does

A one-sided position from `p0` upward behaves like a constant product pool whose quote side starts with a virtual balance of `P`. Ignoring the fee, with `q` the quote buyers have put in so far:

```
coins left in the pool   t = P * S / (P + q)
price                    p = (P + q)^2 / (P * S)
market cap               m = (P + q)^2 / P
share of supply sold     q / (P + q)
```

For the ETH pair, `P = 1.68 ETH`:

| quote in `q` | market cap | sold |
| --- | --- | --- |
| 0 | 1.68 ETH | 0% |
| 1 ETH | 4.27 ETH | 37.3% |
| 5 ETH | 26.6 ETH | 74.9% |
| 20 ETH | 280 ETH | 92.3% |

For the USDG pair and every invented ticker, `P = 3,236 USDG`:

| quote in `q` | market cap | sold |
| --- | --- | --- |
| 0 | 3,236 USDG | 0% |
| 1,000 USDG | 5,545 USDG | 23.6% |
| 8,090 USDG | 39,640 USDG | 71.4% |
| 50,000 USDG | 875,900 USDG | 93.9% |

Nothing about this is special to tickr. It is the standard shape of a one-sided Uniswap v3 or v4 position, which is how most launchpads open a token. The table is before fees: a buy pays the LP fee on the quote it puts in and the remainder moves the price, so `q` is the quote net of fees.

## Fees in the math

The pool's LP fee is `(100 + creatorTaxBps)` in bps, so 1% with no tax and up to 3% with the maximum tax. Uniswap takes it from the input of every swap: a buy of `x` quote moves the price with `x * (1 - fee)` and books `x * fee` of quote to the position; a sell of `y` coins moves the price with `y * (1 - fee)` and books `y * fee` of coins to the position. Those booked amounts are what `LaunchLocker.collectFees` pays out.

## Reading the price

Spot price lives in the pool manager's slot0 for the pool id: `price = (sqrtPriceX96 / 2^96)^2`, currency1 per currency0, raw units. The site reads it through `poolIdOf(token)` and `extsload`; [17 reading state](./17-reading-state.md) has the exact call. Market cap is that price times the supply.

## Third party liquidity

Anyone may add liquidity to a tickr pool at any price and remove their own again. Trades then cross whatever liquidity is in range, ours and theirs, and the LP fee is shared in proportion. The launch position is by far the largest in practice, and it is the only one that is locked.
