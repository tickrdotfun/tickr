# 16 · Trading from code

Inside a coin's first five seconds a buy pays the snipe tax, taken on the way out of the pool: `Token.currentSnipeTaxBps(recipient)` is the rate at that second, and a quote that ignores it will not match what settles. The zap's `previewZap` already reports what the buyer keeps.

Every tickr pool is a Uniswap v4 pool with no hook. Uniswap's Universal Router, the v4 Quoter, aggregators and terminals trade it with the pool key in [17 reading state](./17-reading-state.md) and no tickr specific code. Their quotes already include the LP fee, because it is the pool's own.

## One pool

```solidity
// LaunchSeeder: exact input on one pool. value = amountIn for a native input; approve the seeder for an ERC-20 input.
function swapExactIn(PoolKey key, bool zeroForOne, uint256 amountIn, uint256 minOut, address recipient) payable returns (uint256 amountOut); // amountOut is what `recipient` received: for a coin inside its window, net of the snipe tax
function swapExactInBounded(PoolKey key, bool zeroForOne, uint256 amountIn, uint256 minOut, address recipient, uint160 sqrtPriceLimitX96) payable returns (uint256 amountOut); // the same, stopping at a price: the pool takes input only until it reaches the limit, the rest comes back
// two minimums: `swapExactIn`'s is a quantity, and a fill the pool cuts short because it ran dry must still deliver it or the call reverts whole.
// `swapExactInBounded`'s is a price: calling it is consent to a fill that stops at the limit, and its `minOut` is held pro rata on the part the pool took, with the rest refunded
```

A buy is `zeroForOne = true` when the pair is currency0, which is always the case for ETH, since address zero sorts first.

## From ETH into anything

To route from ETH into a coin quoted in something else, use `ZapRouter`, described in [12 buying with ETH](./12-zap.md). A route is a list of hops that ends at the coin's own pool: `kind` 0 for a v4 pool key, 1 for a v3 pool address, 2 for a wrap into an invented ticker. `previewZap` and `previewZapSell` revert with `Preview(quoteOut, amountOut)`, readable with `eth_call`.

## Collecting fees and claiming

```solidity
// LaunchLocker
function collectFees(address token) returns (uint256 quoteOut, uint256 coinOut);      // anyone may call
// FeeEscrow
function claim() returns (uint256);                                                 // ETH
function claimToken(address token) returns (uint256);                               // any ERC-20
```

A collection splits by the terms frozen at launch, [06 fees](./06-fees.md). The coin side, every fee taken in the launched coin on sells, splits like the quote side: the creator's share and the tax go to the escrow in the coin, the protocol's and the club's shares are burned to `0x000000000000000000000000000000000000dEaD`; nobody is paid in the coin, so the burned supply of a coin is that address's balance. What a collection produced is in the `FeesCollected` event.

## A coin under an invented name

Buying it with ETH is the zap with a route through the ETH/USDG pool, then either the name's own pool (a v4 hop, fee 500, spacing 1, hooks = `ManagedTickerHook`, key from `TickerLauncher.poolKeyOf(ticker)`) or a wrap hop, then the coin's pool; selling it is the same route backwards. Paying in the name itself is one hop through the coin's own pool. The name is redeemable one for one either way: `ManagedTickerToken.mint` and `redeem` are one for one with USDG, outside any route (they refuse to run while the pool manager is unlocked), and the name's pool trades within two ticks of a dollar or not at all, with the pool's fee on top. See [12](./12-zap.md) for the activation buys.
