# 12 · Buying with ETH (the zap)

Every coin can be bought with ETH in one transaction, whatever it is quoted in. Contract: `ZapRouter`.

## Why it exists

The coin's own pool, as the factory records it, must be the last hop of a buy and the first hop of a sell; a route through any other pool that happens to output the coin is refused. A coin quoted in USDG, a Stock Token, another coin, or an invented ticker is priced in that asset, and its pool only
accepts that asset. Without help a buyer would have to acquire the quote somewhere else first. That is the friction
aggregators remove on other launchpads, and the zap removes it here.

## How it works

Every route ends at the coin itself: its own pool is the last hop on a buy and the first hop on a sell. A coin priced in ETH is one hop. A coin priced in USDG is the ETH/USDG pool then the coin's pool. A coin under an invented ticker is ETH/USDG, then a wrap hop that mints the ticker one for one, then the coin's pool. A coin priced in a Stock Token goes through that stock's market first.


The caller passes a route: a list of hops walked from the input asset to the coin's quote. A hop is a Uniswap
v4 pool key, a Uniswap v3 pool address, or an invented ticker to wrap into or redeem from, one for one. Consecutive v4 hops run inside a single `PoolManager.unlock`; a v3 hop calls
the pool directly and pays it in the swap callback. Native ETH is wrapped before a v3 hop and unwrapped before a v4
hop that prices native ETH, so one route can mix both. A run of v4 hops is one unlock: the router swaps hop by hop, settles the run's input once and takes its output once, so nothing between the two ever leaves the pool manager. The coin's own pool, the last hop, pays the recipient directly; the snipe tax and the launch caps therefore see the buyer, never the router, and the amount the zap reports is the recipient's balance change. On a sell the coin goes from the seller straight into the pool manager. It holds nothing between transactions and has no
privileges.

```solidity
struct Hop {
    uint8 kind;           // 0 = Uniswap v4 (key), 1 = Uniswap v3 (pool), 2 = wrap (invented ticker, one for one; pool = the ticker)
    PoolKey key;
    address pool;
}

struct ZapParams {
    address token;        // the coin to buy
    address tokenIn;      // address(0) = native ETH, amount taken from msg.value
    uint256 amountIn;     // ERC-20 input only
    Hop[] path;           // hops from tokenIn to the coin's quote; empty when tokenIn already is the quote
    uint256 minTokensOut; // an absolute minimum of the coin, for the whole route
    address recipient;
    uint256 deadline;
}

function zapBuy(ZapParams calldata p) external payable returns (uint256 tokensOut);
function previewZap(ZapParams calldata p) external payable; // always reverts with Preview(quoteOut, tokensOut)
```

`previewZap` runs the real path and reverts with the amounts, so a front end quotes it with a plain `eth_call`.
The web app does exactly that and sizes `minTokensOut` from the result.

## Selling for ETH

The same router sells: `zapSell` pulls the coin, sells it on the coin's pool, walks the route backwards from the quote to
`tokenOut`, checks `minOut`, and pays the seller. `previewZapSell` reverts with `Preview(quoteOut, amountOut)` the
same way. The web app simulates it with the seller's allowance overridden, so the quote is exact before anything
is approved.

```solidity
struct ZapSellParams {
    address token;     // the coin to sell
    uint256 amountIn;  // coins
    Hop[] path;        // hops from the coin's quote to tokenOut; empty when tokenOut already is the quote
    address tokenOut;  // address(0) = native ETH
    uint256 minOut;    // in tokenOut units
    address recipient;
    uint256 deadline;
}
```

## Routes the web app builds

| Quote asset | Path |
|---|---|
| ETH | none, the coin's pool is called directly |
| USDG | ETH/USDG (fee 0.01%) |
| an invented ticker (paired with USDG) | ETH/USDG, then the ticker's own pool (a v4 hop, fee 500, spacing 1, hooks = `ManagedTickerHook`) or wrap into the ticker one for one, whichever pays more; the site quotes both |
| a coin launched here | that coin's pool, no hook |
| a Stock Token | the deepest pool against ETH: native ETH on v4 or WETH on v3, across the standard fee tiers |

Where no route is known the trade panel falls back to paying in the quote asset directly.

## Guardrails

| Rule | Error |
|---|---|
| Deadline not passed | `Expired` |
| The coin was launched by this factory | `UnknownToken` |
| The path ends at the coin's quote, and each hop contains the current asset | `BadPath` |
| The v3 swap callback comes from the pool being swapped, and never asks for more than the hop holds | `OnlyPool`, `InsufficientLiquidity` |
| Every hop fills completely | `InsufficientLiquidity` (a partial hop would strand funds in the router) |

## Buying a name itself

`zapTicker(ZapTickerParams)` buys an invented ticker through its own pool, with the pool manager paying the recipient directly, and `previewZapTicker` reverts with `Preview(quoteOut, tickerOut)` like the other previews. The route must end in the name's pool. This is the first of the two activation buys every launch under a name ends with, see [05](./05-anchors.md): chart sites price a name from a swap that lands in a wallet after the name's pool exists, and a route that nets the name through the pool manager on its way to a coin is not that. A name's pool takes one visit per transaction: a route through the same name's pool twice reverts.

```solidity
struct ZapTickerParams {
    address ticker;      // the invented ticker
    address tokenIn;     // address(0) = ETH, sent as value
    uint256 amountIn;    // for an ERC-20 input
    Hop[] path;          // v4 hops from tokenIn to the ticker, ending in the ticker's own pool
    uint256 minOut;      // the fewest ticker tokens acceptable
    address recipient;   // address(0) = msg.sender
    uint256 deadline;
}
```
