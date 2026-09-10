# 09 · Risks

Read this before launching, buying, or integrating. Nothing here is advice.

## Market and token risks

- **Names and symbols are not unique.** Anyone can launch "PEPE" with the same logo. The only identity is the token address. Verify it against `Factory.getLaunchedToken(token).exists` and the `TokenLaunched` log from the tickr factory address before trading.
- **Creator tax.** A launch may carry a `creatorTaxBps` of up to `maxCreatorTaxBps()` (2% at launch; the owner can raise that ceiling for later launches, never above 10%; TICKR itself carries 2%) on every trade in its pool and every pool swap, forever. Read `getLaunchedToken(token).creatorTaxBps` before buying. It cannot be changed after creation, in either direction.

## Pair risks

- A launch quoted in an ERC-20 inherits that asset's contract, issuer, transfer-restriction, and depeg risk in full. The protocol cannot change a launch's pair. See [04 Official pairs](./04-custom-pairs.md).

## Redeemable name risks

- The way back to USDG from a coin under a redeemable name is the coin's own pool, then a one-for-one redeem of the name (`TickerToken.redeem`). The redeem has no price impact and no depth limit: it returns exactly what the name wraps. The only price impact on the way out is the coin's own pool, the same as for a coin paired with USDG directly.
- The risk that remains is the coin's own pool. A coin under a redeemable name can go to zero like any other coin; the name it is priced in stays worth exactly the USDG it wraps.
- Nobody can sell supply they were handed at birth, because nobody was handed any.

## Fixed-inventory name risks

These are different risks, not smaller ones. Read them before launching under one.

- **The quote asset can fall.** A fixed-inventory name holds nothing and is worth what its market says. A coin can hold its price in the name and still lose most of its dollar value, because the name lost it. A redeemable name cannot do this to you. This is the trade you are making.
- **There is no redeem.** The only way out of the name is selling it in its own pool, which has price impact and finite depth. A large exit moves the price against itself. `TickerToken.redeem` does not exist here and there is no equivalent.
- **Both markets can be thin.** Getting from a coin to dollars crosses two pools, the coin's and the name's. Depth in one does not imply depth in the other, and the site quotes the whole route rather than either half.
- **A launch can be refused for lack of a route.** If the name's market has nothing available in the direction a trade needs, the router stops rather than filling badly. On the site that reads: *This route currently has no available liquidity in the required direction.* It is a refusal, not a failure, and a different size or a later attempt needs its own fresh quote.
- The disclosure, on the docs index and the terms page: *Not issued by Robinhood Assets. Not a Stock Token. No mint/redeem against listed shares. A name invented on tickr is not the asset it is named after: a redeemable name is worth exactly the USDG it wraps, a fixed-inventory name has no backing and is worth only what its own market says.*

## The buyback cannot be switched off

Stated plainly because it is permanent and it surprises people.

- `buy()` on either treasury has **no permission check**. Anybody may call it and burn a tranche. The keeper the team runs is a convenience, not a gate: stopping the keeper stops the team from calling it, and stops nobody else.
- `collect()` has no permission check either, so anybody can pull accrued fees into the treasury and refill the earmark.
- The burn share **only rises**. `proposeBuybackShare` reverts unless the new value is higher than the current one, and no function lowers it. It starts at 50% and 50% is therefore its floor for the life of the contract.
- There is **no pause, no sweep and no withdrawal**. Dollars earmarked for the burn cannot be recovered by anyone, including the owner.

The consequence: once a coin's policy is frozen to a treasury, the protocol's share of that coin's fees will fund
that treasury's burn for as long as the coin trades, and no transaction exists that changes it. The owner can
point *future* launches at a different recipient. It can do nothing about coins already launched.

## Third party liquidity and other pools

A tickr pool is a plain Uniswap v4 pool. Anyone may add liquidity to it and remove their own again, and anyone may open another pool for the same two tokens at another fee or price. Neither touches the locked launch position, and a pool nobody trades in prices nothing. Snipe protection is a tax, not a gate: a buy out of the pool in the coin's first five seconds pays 99% in the launch second, 25% one second in, 3% at two, then dust, then nothing, all of it burned to the dead address. The launcher and its fee wallet are exempt, sells are never taxed, and from the fifth second the tax is gone. Launch protection sits beside it, counted in blocks: nobody but the launch's own wallets may buy in the launch block, and for the next two blocks every other wallet is held to 5% of supply held and 5.5% bought. A transfer into a wallet inside those two blocks is held to the same 5%. From the fourth block the coin is a plain ERC-20. Bots can still buy from the second block on, at that price and under those caps, and both rules only see coins that leave the pool manager as ERC-20 transfers: a bot that settles its swap into ERC-6909 claim balances inside the pool manager and withdraws after the window pays neither the tax nor the caps. The launcher's own wallets are exempt and may pass coins on, five percent per wallet, in the launch block. Take the rules as a cost on the usual routes, not as a promise that nobody snipes.

## Liquidity is locked forever

The launch position of every coin is minted straight to `LaunchLocker` and never leaves it. The contract can
receive a position and collect its fees, and it has no function that moves, reduces or rescues principal. Not for
the creator, not for the protocol, not for the factory's owner, who is not on the locker at all.

This cuts both ways, and that is the risk on this page rather than the reassurance: **liquidity that cannot be
pulled cannot be recovered either.** There is no migration, no redeploy onto a fixed pool, and no recourse if a
launch was opened on terms the creator later regrets. A fixed-inventory name's own issuance is held harder still,
by a per-name locker with no fee collection at all. Full detail in [14 liquidity lock](./14-liquidity-lock.md).



## Owner powers, exactly

The factory is `Ownable2Step`. The owner can change the terms of future launches and nothing about a coin that exists. Function by function:

| power | function | reach |
| --- | --- | --- |
| Launch fee | `setLaunchFee` | Future launches only. |
| Creator tax ceiling | `setMaxCreatorTaxBps` | Future launches only. 2% at launch; the owner can raise it, never above 10%. A launch keeps the tax it was created with. |
| Launch configs | `addLaunchConfig`, `setLaunchConfig` | Supply, base fee, opening quote reserve and tick spacing of future launches. |
| Pair economics | `setPairTokenEconomics` | Which ERC-20s can be a pair through the factory and their opening quote reserve; future launches only. Revoking USDG stops USDG-quoted launches through the factory and, since redeemable names read it, new ticker launches too. |
| Open or close launching | `setLaunchEnabled`, `setWhitelistedLauncher` | New launches only. Every existing pool keeps trading. A factory is born closed; genesis opens it and removes the deployer's own pass, so closing again later closes it for everyone. |
| Registrars | `setRegistrar` | Which contracts may launch with their own pair economics: the ticker, Stock Token, coin and market quote launchers. |
| Fee policy | `setFeePolicy` | The split of future launches. Every existing launch keeps the policy copied at its creation, including the protocol wallet. |
| Fee club | `setFeeClub` | Which contract books the club's share for future launches; the club is frozen into each launch's policy at launch. |
| Ticker launcher | `setTickerLauncher` | Which contract the treasury and the zap treat as the register of names. The names' pools answer to the launcher they were created by, whatever this points at. Set once at deploy; independent of the club. Existing launches keep the club they launched with, and a club that fails to book a fee sends that slice to the protocol rather than blocking a collection. |
| Move a fee wallet | `proposeCreatorFeeRecipient`, `executeCreatorFeeRecipientChange` | Any coin's creator fee wallet, after a public three day notice and within a three day window. Exists for lost keys and compromised wallets; every use is an event. |
| Raise the burn share | `BuybackTreasury.proposeBuybackShare`, `applyBuybackShare` | the burn share starts at 50%, can be raised by the owner after a three-day delay, and can never be lowered. The proposal is the treasury's only gated call; applying it is anyone's. |
| Set a name's conversion floor | `BuybackTreasuryV2.setMinRate(token, toCounter, rateX96)` | The rate a conversion of that name must beat before the treasury will do it. **This has no upper or lower bound.** The owner may set a floor below the frozen policy, weakening the protection for that one name, or high enough that no conversion of it can ever succeed, which stops the treasury converting it at all. Stated here rather than implied away. |
| Set the default conversion floor | `BuybackTreasuryV2.setDefaultMinRate(toCounter, rateX96)` | The floor for names with none of their own. May be raised freely and lowered again, but never below the frozen policy value. Unlike `setMinRate` it cannot go under that. |
| Reserve a ticker or a name | `AnchorRegistry.reserveTicker`, `reserveNames` | Future launches only: a reserved symbol cannot be invented as a ticker and a reserved name cannot be used by a new coin. |
| Stock Token, coin and market targets | `StockQuoteLauncher.setTargetRaiseUsd`, `setMaxStaleness`, `CoinQuoteLauncher.setTargetRaise`, `MarketQuoteLauncher.setTargetRaise`, `setMinDepth` | The opening market cap of future launches in those modes. |
| Give up ownership | `renounceOwnership` | Freezes the terms of future launches forever. Cannot be undone. |

What the owner cannot do: take anything out of a pool, a locked position, the fee escrow, or a ticker's USDG reserve; stop an existing coin from trading; change an existing launch's fee, tax, pair or economics; mint, freeze or blacklist a coin; block a fee collection. There is no rescue function and no phase in which funds wait on anyone: the pool exists in the launch transaction and the position is locked in it.

Related owners outside the factory: the `AnchorRegistry` owner can `register` / `setActive` anchors (new launches only); the `BuybackVault` owner can `setStrategy`, and only that strategy can release what the vault holds, which is nothing while `buybackBurnBps` is zero. The `BuybackTreasury`, which receives the protocol's fee share, has no owner at all: no admin, no withdrawal, no rescue. Its money leaves only to the team wallet and the dead address, by the rules in [13](./13-official-coin.md).

## Immutable

The contracts are immutable; a bug cannot be patched in place, only mitigated by deploying a new version and stopping new launches on the old factory (`setLaunchEnabled(false)`), which does not affect existing curves or pools. Interact only with amounts you can afford to lose.
