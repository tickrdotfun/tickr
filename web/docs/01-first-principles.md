# 01 · Overview

Everything below is a property of the contracts, not a promise. Each one names the code that makes it true.

## 1. No custody by the operator

Non-custodial for the operator: the pools, the locked positions, the escrow and the name wrappers hold assets by code, and nobody at tickr can move them. The site never holds funds or keys. Every transaction is built in the browser, shown, and signed in the user's own wallet. On chain, the only places money sits are the coin's Uniswap v4 pool (owned by nobody), the locked position that holds it (owned by `LaunchLocker`, which has no function to move it), the fee escrow (`FeeEscrow`, pull only: a recipient claims its own balance and nothing else moves), and a redeemable name's USDG reserve (`TickerToken`, redeemable one for one by whoever holds the wrapper). A fixed-inventory name holds no reserve at all: its supply sits in its own pool and there is nothing to redeem.

## 2. Atomic flows

A launch is one transaction. `Factory.launchToken` deploys the coin, opens its pool at the opening price, puts the entire supply into one locked position, and records the terms. Either all of it happens or none of it does. There is no phase between "created" and "tradable": the pool exists in the block the coin does, and a buy in that same transaction, the dev buy, is the only buy guaranteed to be first.

## 3. Everything readable on-chain

`Factory.getLaunchedToken(token)` returns the launch record: the pair, the opening quote reserve, the pool fee, the position's range and liquidity, the position id, the creator's tax and fee wallet. `poolKeyOf` and `poolIdOf` give the pool. `LaunchLocker.pendingFees` gives what the position has earned and not yet collected. `TickerLauncher` lists every ticker and every coin under it. Nothing needs tickr's servers.

## 4. Immutable per version

A coin's name, symbol, image, description, socials, pair, opening economics, pool fee and creator tax are fixed in the launch transaction. The pool key is derived from them and the fee split is copied into the launch record, so `setFeePolicy`, `setLaunchConfig` and `setFeeClub` change future launches only. A new version of the protocol is a new factory.

## 5. Creator holds 0 launch tokens at creation

`LaunchDeployer.deployToken` mints the supply and hands all of it to the factory, which puts all of it into the locked position. The creator receives nothing at creation. The one exception is the dev buy in the launch transaction, which buys from the pool at the opening price like anyone would, and is disclosed in the launch's own events. `Token` has no mint, no burn hook, no freeze, no blacklist, and one tax only: a buy in its first five seconds pays a snipe tax that starts at 99% and is gone by the fifth second, burned; see [02](./02-lifecycle.md).

## 6. Nothing to graduate, nothing to squat

Nothing sits between a buyer and the pool: no curve contract in front of it, no hand-off to a pool later. The position that holds the supply spans from the opening price to the end of the range, which is exactly a constant product curve with a virtual quote reserve (see [03 pool math](./03-curve-math.md)), and it is in the pool from the first block. Because the pool is created in the same transaction as the coin, nobody can create it first at a price of their choosing.

## 7. Every coin's address ends in 6942

Nothing on chain enforces this. The factory deploys each coin with CREATE2 at `keccak256(initiator ++ TokenParams.salt)`, and the salt is a free field, so the create page tries salts until `LaunchDeployer.predictToken` returns an address ending in `6942`. It costs no extra gas and needs no call to the chain. A coin launched through another interface with a random salt is just as valid, it only lacks the suffix.
