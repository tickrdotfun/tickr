# 13 · The official coins: TICKR, priced in FUN, and HOLY on v2

tickr has one coin of its own. Its ticker is **TICKR**, it is priced in **FUN**, and it is the first launch on the platform. It runs on exactly the rules every other launch runs on. This page lists what makes it different, which is only who launched it and when.

## What it is

| | |
| --- | --- |
| Coin | TICKR, name `tickr`, 18 decimals |
| Pair | FUN, a redeemable name: a one-for-one wrapper of USDG. FUN predates the market release, so it stays this kind for as long as it exists; `QuoteRegistry.kindOf(FUN)` returns 0, unclassified, and everything that reads it treats an unclassified name as redeemable, which is what FUN is |
| Its treasury | `BuybackTreasury` `0x60C1276f...`, the first one. TICKR's policy was frozen to it at launch and cannot be repointed. `BuybackTreasuryV2` is for launches made from the market release on and has no bearing on TICKR |
| Supply | 1,000,000,000, all of it in the locked pool at launch; nobody holds any at creation, and the only way to hold some in the launch transaction is a first buy from the curve like anyone else |
| Fee split | 50% creator, 10% ticker club, 40% protocol, frozen at launch, the same as every coin under a ticker |
| Creator | the team. The creator share of TICKR's fees goes to the team's fee wallet |
| Creator tax | 2%, the launch-time ceiling, on every trade, all of it to the team's fee wallet, shown on every trade like any creator tax |
| Allocation, airdrop, vesting | none |

## How it was launched

In the genesis transaction, while launching was still closed to everyone but the deployer: `TickerLauncher.launchAndBuy("FUN", ...)` invented FUN, paid the ticker fee that became the working dollars of FUN's own pool, opened TICKR's pool with the whole supply locked in it, on the same terms as every coin after it, and made the disclosed first buy, all in that one transaction, so nothing could trade the pool before it. Two small buys followed, each its own transaction through Uniswap's canonical Universal Router, both to the deployer's wallet: 0.0005 ETH of FUN through its own pool, then 0.001 ETH of TICKR; these are the listing buys every launch under a name ends with, see below. Then launches opened to everyone.

## The first buy

In the genesis transaction itself, the team bought a slice of TICKR: `5%` of supply, delivered to the treasury wallet. It is paid in FUN minted from USDG that the deployer bought with ETH the moment before, bought from the pool at the pool's price with no exemption from the fee, and the transaction is public. The size is worked out by running that same transaction in a simulation first and searching for the dollars that buy the share; the pool is new both times, so the answer is exact.

On launch night that 5% went into the pool instead of the fire: all 50,000,000 TICKR sit as a concentrated position on the TICKR/FUN pool, the same pool as every other trade, from just above the price at placement up to about fifty percent above it, so buys land on them at a fraction of the price impact the launch curve alone would give. The position is an NFT (id 2135484) owned by the treasury wallet; it earns the pool fee like any position and can be withdrawn or moved by that wallet. Nothing of it was burned, and none of it was sold. A first placement (id 2135009) was made twenty percent wide and the price fell out of its band within the hour, so it was withdrawn and placed again wider; every step below is a treasury or deployer transaction, none a sale:

- the 50,000,000 TICKR moved to the deployer, then placed: `0xe3d40210b9a7f3496aa6a4607cb7d448d518b4195d5a12021b6763e9c3d3d84a`, `0xc2d6954f0d1359cf592199d27004ff6e4724656877d634f3ef7e2fb2658001b6`
- withdrawn and placed again, wider: `0xf84487294c842c9021b93f96ce5522f31c89dd8100c94573171e9ca796a450c8`, `0x54dc325bf0cc8bcb5d5771ecdca6d6fa4bc6aa7404d2b0c3effb1d2d90dbc47f`, `0x16f5713ff400d636790fa8c36754722d1aef952da571634a4c84d03c6f7f51de`

## Buybacks

The protocol's share of every fee, and every launch fee, is paid to a contract, `BuybackTreasury`, not to a wallet. It is the protocol fee recipient from the first launch, frozen into TICKR and every coin after it. The treasury has no owner and no way to withdraw: money leaves it two ways only, to the team wallet and to the dead address. The half and half split between buybacks and the team applies to revenue the treasury can convert to USDG, which is USDG, ETH and redeemable names; fees paid in an asset it cannot convert at par, a Stock Token or a coin used as a quote, are forwarded to the team in full; and the protocol's and the club's sell-side shares, paid in the launched coin, are burned by the locker directly and never reach the treasury.

The treasury binds itself to the ticker launcher the first time `collect` or `buy` runs after deployment (`launcher()`, event `LauncherBound`); from then on what FUN is, which coin is official and which wrappers convert cannot be moved by the factory owner. Anyone may call `collect(tokens)`. It claims what the escrow holds for the treasury, turns what it can into dollars (a redeemable name unwraps at par, ETH goes through the live ETH/USDG pool), sends half of the dollars to the team wallet, and sets the other half aside. Anything it cannot convert, a Stock Token or a coin used as a quote, goes whole to the team wallet, since the treasury has no honest price for it.

Anyone may then call `buy()`, at most once every ten minutes. It spends at most 5% of the dollars set aside, sized so that the buy moves TICKR's pool by no more than 300 basis points at the liquidity in range when it is sized, and the swap itself carries that price as its limit: the pool stops there whatever its liquidity turns out to be, and the FUN it did not take comes back as dollars and stays earmarked. It turns those dollars into FUN, buys TICKR in the TICKR/FUN pool, and sends the TICKR to `0x000000000000000000000000000000000000dEaD`. The size, the limit and the least it will accept are computed on chain from the pool as it stands when `buy` is called: a caller chooses none of them, and what one call can do is bounded by the tranche, the interval and the price limit. The treasury has no oracle. TICKR trades in one pool, so the pool's price is the only price there is, and a buy starts from wherever that price is; someone who moves it before a buy pays the pool's fee both ways to move it and can catch at most one tranche, at most once every ten minutes, inside the bound. The ETH conversion in `collect` runs on the same interval through the deepest pool on the chain. Every buy is a `BoughtAndBurned` event, and the TICKR page shows the running total.

the burn share starts at 50%, can be raised by the owner after a three-day delay, and can never be lowered. `buybackShareBps` is the share in force; `proposeBuybackShare(bps)` is the factory owner's proposal, upward only and at most all of it, and `applyBuybackShare()` puts it in force once `SHARE_DELAY` has passed, by anyone. A newer proposal replaces a pending one and the delay starts again. Burning takes coins out of circulation. It does not guarantee a higher price.

## The FUN club

FUN is a redeemable name, so it has a ticker club like any other, and TICKR is in it.

10% of the base fee of every coin launched under FUN is booked to that club when the fees are collected, in
30-day epochs (`TickerLauncher.EPOCH`). Members claim their share of each pot by booked volume, and the club's
captain counts double. TICKR is the founder's coin, the first launched under FUN, so it is captain in every epoch
it has volume in; in an epoch where it has none, the coin with the most volume under FUN takes the seat instead,
and TICKR gets it back in any later epoch it trades in.

The captain seat is a weight in a division and nothing else. It carries no say over any other coin, no access to
any fee but its own share, and no control over the name. Nobody owns FUN. See
[05 anchors](./05-anchors.md) for how the club, the captain and the sweep work in full.

One practical note: a pot is booked to the epoch its collection happens in, not the epoch the trades happened in,
and nothing collects automatically any more. A coin that wants its fees booked where they were earned has to call
`collectFees` before the epoch closes.



## Where to find it

The deployment record (`contracts/deployments/<chainId>.json`) carries `genesisToken`, `genesisTicker` and `genesisPool`. The site marks the coin as official from that record, never from its name: a second coin called TICKR under a different ticker is just a coin.

## Why FUN has a pool, and the two buys after genesis

Chart sites price a pair by walking from its quote token to a dollar through pools, and they only trust a price they have seen trade into a wallet. FUN is worth the dollar it wraps, but without a pool those sites cannot show TICKR/FUN in dollars, and without a trade that lands in a wallet after the pool exists they show nothing at all. So FUN, like every redeemable name, runs its own FUN/USDG pool at one dollar from the moment it is invented ([05](./05-anchors.md)), and genesis ends with two more transactions from the deployer through Uniswap's canonical Universal Router, each with a fresh positive minimum from Uniswap's quoter: FUN bought through that pool into the deployer's wallet, then TICKR bought through FUN's pool and its own. The launch transaction itself, first buy included, is not a trade those sites count; the two after it are. Every coin launched on the site goes through the same two buys, from the create page, before it is shown as done. A confirmed sequence is not a listing: chart sites index on their own clock, and nothing here promises one.

## Its address

TICKR's address ends in `6942`, like every coin launched from the site. The genesis script grinds the salt against the deployed `LaunchDeployer`'s own prediction and refuses to launch if the predicted address does not end that way, so the suffix is checked before anything is sent.

## v2: HOLY, priced in COW

The v2 path has an official coin of its own. Its ticker is **HOLY**, it is priced in **COW**, and it is the first coin launched on v2. It runs on exactly the rules every v2 launch runs on; what sets it apart is who launched it and what happened to its first buy.

| | |
| --- | --- |
| Coin | HOLY, name `HOLY`, 18 decimals, `0x49f39Ce9bEBC9047DF7266B55D98e46c84526942` |
| Pair | COW, a fixed-inventory name: 500,000,000 COW, all of it placed in one locked position against USDG at a dollar, `0xF3b977f5b0c3F03eb265D1b26BF0F8961c1bE4f7` |
| Supply | 1,000,000,000 |
| Pool fee | 0.82%. No creator tax: the v2 path carries none |
| Creator share | to the team treasury, the same wallet that receives TICKR's |
| Description | `HOLY COW. genesis tickr V2.` |
| Launched | block 61,243,389 on Robinhood Chain, by the wallet that launched TICKR |

### The first buy

The v2 launcher only launches; it has no buy. So the first buy was the very next transaction, and it landed in block 61,243,420. In the blocks between, every other buyer paid the snipe tax and was capped at 5% of supply, and the launching wallet is exempt from both; a buyer who keeps its coins as claims inside the pool manager is not stopped by either (docs 09).

It bought 71,921,606 HOLY, a little over 7% of supply, and once its receipts were confirmed one transaction split it exactly:

- **5%, 50,000,000 HOLY, to the wallets that held TICKR** at block 57,934,294 (8 September 2026, 19:18 UTC), pro-rata: each wallet's share of the 5% is its share of the qualifying TICKR, 0.211868 HOLY per TICKR. 79 wallets. Not counted: pools, the burn address, protocol contracts, the team treasury, one contract that is not a wallet, and anything under 1,000 TICKR. The snapshot was rebuilt from the chain's own transfer logs, and every one of the 1,000,000,000 TICKR is accounted for in it. Nothing to claim: each wallet was sent its HOLY directly.
- **2%, 20,000,000 HOLY, is the team's**, all of it to the team treasury.
- **798,912 HOLY to one early holder** who sold before the snapshot, sent with the airdrop. It comes out of what the buy brought in past the 7% — the part that is otherwise burned — so it is taken from neither the holders' 5% nor the team's 2%.
- **1,122,695 HOLY burned**: everything the buys brought in past the 7%, less the early holder's share above, so the figures here are exact rather than approximately right.

Every transfer is on the explorer: [HOLY's token transfers](https://robinhoodchain.blockscout.com/token/0x49f39Ce9bEBC9047DF7266B55D98e46c84526942?tab=token_transfers).

| Step | Transaction |
| --- | --- |
| Launch | `0x45da1ca83f71d42b6f854f08535355bcbc24af55156013a65af23f4dcbf44223` |
| First buy | `0x2a44fde8ee41b3a5909bcd089eb39cc6a44f1522eae4aedb8d7ab51c69ce5d2a` |
| Listing buy, COW | `0xffbecee5237fc018855b659178349e9fe18e95bc7f3e115c3f3ec9869e8a2de0` |
| The split: the team's 2% to the treasury and the excess burned, in one transaction | `0xc6d728de3b79d80444598622c02aaa9174f5504ce463f915ffbe3d26c661e4dd` |
| The airdrop: every wallet on the list, in one transaction | `0x50a32633ce36db424b9a57dd6d222dc2bac95991c9bda3d070b4aa2a44c4bb99` |
