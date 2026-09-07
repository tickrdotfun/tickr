# 14 · Liquidity lock

Every coin's liquidity is held by one contract, `LaunchLocker`, from the block it launches. This page says exactly what that contract holds, what it can do, and how to check both.

## What the locker holds

- The launch position of every coin: a Uniswap v4 position holding the entire supply, from the opening price to the end of the range. `LaunchSeeder` mints it straight to the locker in the launch transaction, so there is no moment when anyone else owns it.
- The rounding remainder of the supply, the few units a one-sided position cannot absorb.

`getLaunchedToken(token).lpTokenId` is the position, and `PositionManager.ownerOf(lpTokenId)` reads the locker's address for every launch.

## What it can do

Two things. It can receive a position, through `onERC721Received`, and only from the Uniswap position manager, and only a fresh mint, never a position somebody already owns; the seeder checks that the locker owns the position before a launch is recorded. It can collect a position's fees, through `collectFees(token)`, which anyone may call at any time. A collection is a zero-liquidity decrease: Uniswap pays out what the position has earned and the principal is not touched. The proceeds are split by the terms frozen at launch, described in [06 fees](./06-fees.md).

```solidity
function pendingFees(address token) view returns (uint256 amount0, uint256 amount1);
function collectFees(address token) returns (uint256 quoteOut, uint256 coinOut);
```

## What it cannot do

Nothing in the contract can move a position, reduce its liquidity, or send a coin or a quote anywhere except as the proceeds of a fee collection. Not for the creator, not for the protocol, not for the owner of the factory. The owner's full list of powers is in [09 risks](./09-risks.md), and the locker is not on it.

This is a property of the code, not a promise. The source has no such function, and a contract cannot gain one after deployment. It also cuts both ways: liquidity that cannot be pulled is liquidity that cannot be recovered, by anyone, for any reason.

## What is not locked

Anyone may add liquidity to a tickr pool and remove their own again. Only the launch position and the remainder are held by the locker. An invented ticker's own pool is different: its positions are held by the wrapper itself, and nobody else can add to or remove from that pool at all; see [05 invented tickers](./05-anchors.md). A coin's price is set by everything in the pool, locked and not.

## How to check

1. `Factory.getLaunchedToken(token)` gives `lpTokenId`, `tickLower`, `tickUpper` and `liquidity`.
2. `PositionManager.ownerOf(lpTokenId)` returns the `LaunchLocker` address from the deployment record, [07 addresses](./07-addresses.md).
3. The locker's verified source on the explorer has the two functions above and nothing that moves principal.
