# 13 · The official coin: TICKR, priced in FUN

tickr has one coin of its own. Its ticker is **TICKR**, it is priced in **FUN**, and it is the first launch on the platform. It runs on exactly the rules every other launch runs on. This page lists what makes it different, which is only who launched it and when.

## What it is

| | |
| --- | --- |
| Coin | TICKR, name `tickr`, 18 decimals |
| Pair | FUN, an invented ticker: a one-for-one wrapper of USDG |
| Supply | 1,000,000,000, all of it in the locked pool at launch; nobody holds any at creation, and the only way to hold some in the launch transaction is a first buy from the curve like anyone else |
| Fee split | 60% creator, 10% ticker club, 30% protocol, frozen at launch, the same as every coin under a ticker |
| Creator | the team. The creator share of TICKR's fees goes to the team's fee wallet |
| Creator tax | none |
| Allocation, airdrop, vesting | none |

## How it was launched

In the genesis transaction, while launching was still closed to everyone but the deployer: `TickerLauncher.launchAndBuy("FUN", ...)` invented FUN, paid the ticker fee that opened FUN's guarded one dollar pool, opened TICKR's pool with the whole supply locked in it, on the same terms as every coin after it, and made the disclosed first buy, all in that one transaction, so nothing could trade the pool before it. Then launches opened to everyone.

## The first buy

In the genesis transaction itself, the team bought a slice of TICKR: `6.8%` of supply, the same share the first coin on a comparable launchpad's deployer bought at its launch. It is paid in FUN minted from USDG that the deployer bought with ETH the moment before, bought from the pool at the pool's price with no exemption from the fee, and the transaction is public. The size is worked out by running that same transaction in a simulation first and searching for the dollars that buy the share; the pool is new both times, so the answer is exact.

## Buybacks

Nothing about buybacks is written into the contracts, and there is no share of anything reserved for them. If the team runs buybacks of TICKR, they will be described here first: the wallet that does them and what it does with the coins.

## The FUN club


## Where to find it

The deployment record (`contracts/deployments/<chainId>.json`) carries `genesisToken`, `genesisTicker` and `genesisPool`. The site marks the coin as official from that record, never from its name: a second coin called TICKR under a different ticker is just a coin.

## Why FUN gets a pool

Chart sites price a pair by walking from its quote token to a dollar through pools. FUN needs no market, but without one those sites cannot show TICKR/FUN in dollars. So inventing FUN opened a plain Uniswap v4 FUN/USDG pool at exactly one dollar behind the guard hook, funded by the ticker fee, the position locked, one small swap made so the pair gets listed. It is a price reference, not a market: FUN is worth the dollar it wraps, and the guarded pool can only ever say so. Every invented ticker gets the same on the same terms.

## Its address

TICKR's address ends in `6942`, like every coin launched from the site. The genesis script grinds the salt against the deployed `LaunchDeployer`'s own prediction and refuses to launch if the predicted address does not end that way, so the suffix is checked before anything is sent.
