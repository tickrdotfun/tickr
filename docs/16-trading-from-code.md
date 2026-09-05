# 16 · Trading from code

Every tickr pool is a Uniswap v4 pool with no hook. Uniswap's Universal Router, the v4 Quoter, aggregators and terminals trade it with the pool key in [17 reading state](./17-reading-state.md) and no tickr specific code. Their quotes already include the LP fee, because it is the pool's own.

## One pool

```solidity
// LaunchSeeder: exact input on one pool. value = amountIn for a native input; approve the seeder for an ERC-20 input.
function swapExactIn(PoolKey key, bool zeroForOne, uint256 amountIn, uint256 minOut, address recipient) payable returns (uint256 amountOut);
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

A collection splits by the terms frozen at launch, [06 fees](./06-fees.md). The coin side, every fee taken in the launched coin on sells, is burned in full to `0x000000000000000000000000000000000000dEaD`; nobody is paid in the coin, so the burned supply of a coin is that address's balance. What a collection produced is in the `FeesCollected` event.
