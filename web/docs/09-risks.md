# 09 · Risks

Read this before launching, buying, or integrating. Nothing here is advice.

## Market and token risks

- **Names and symbols are not unique.** Anyone can launch "PEPE" with the same logo. The only identity is the token address. Verify it against `Factory.getLaunchedToken(token).exists` and the `TokenLaunched` log from the tickr factory address before trading.
- **Creator tax.** A launch may carry a `creatorTaxBps` of up to `maxCreatorTaxBps()` (2% at deploy, 10% is the contract's cap) on every trade in its pool and every pool swap, forever. Read `getLaunchedToken(token).creatorTaxBps` before buying. It cannot be changed after creation, in either direction.

## Pair risks

- A launch quoted in an ERC-20 inherits that asset's contract, issuer, transfer-restriction, and depeg risk in full. The protocol cannot change a launch's pair. See [04 Official pairs](./04-custom-pairs.md).

## Invented ticker risks

- The way back to USDG from a coin under a ticker is the coin's own pool, then a one-for-one redeem of the ticker (`TickerToken.redeem`). The redeem has no price impact and no depth limit: it returns exactly what the ticker wraps. The only price impact on the way out is the coin's own pool, the same as for a coin paired with USDG directly.
- The risk that remains is the coin's own pool. A coin under a ticker can go to zero like any other coin; the ticker it is priced in stays worth exactly the USDG it wraps.
- Nobody can sell supply they were handed at birth, because nobody was handed any. The disclosure on every create and token surface: *Not issued by Robinhood Assets. Not a Stock Token. No mint/redeem against listed shares. An invented ticker is a one-for-one wrapper of USDG: it is worth exactly what it wraps.*

## Third party liquidity and other pools

A tickr pool is a plain Uniswap v4 pool. Anyone may add liquidity to it and remove their own again, and anyone may open another pool for the same two tokens at another fee or price. Neither touches the locked launch position, and a pool nobody trades in prices nothing. Snipe protection is a tax, not a gate: a buy out of the pool in the coin's first five seconds pays 99% in the launch second, 25% one second in, 3% at two, then dust, then nothing, all of it burned to the dead address. The launcher and its fee wallet are exempt, sells are never taxed, and from the fifth second the tax is gone. Launch protection sits beside it, counted in blocks: nobody but the launch's own wallets may buy in the launch block, and for the next two blocks every other wallet is held to 5% of supply held and 5.5% bought. A transfer into a wallet inside those two blocks is held to the same 5%. From the fourth block the coin is a plain ERC-20. Bots can still buy from the second block on, at that price and under those caps, and both rules only see coins that leave the pool manager as ERC-20 transfers: a bot that settles its swap into ERC-6909 claim balances inside the pool manager and withdraws after the window pays neither the tax nor the caps. The launcher's own wallets are exempt and may pass coins on, five percent per wallet, in the launch block. Take the rules as a cost on the usual routes, not as a promise that nobody snipes.

## Liquidity is locked forever


## Owner powers, exactly

The factory is `Ownable2Step`. The owner can change the terms of future launches and nothing about a coin that exists. Function by function:

| power | function | reach |
| --- | --- | --- |
| Launch fee | `setLaunchFee` | Future launches only. |
| Creator tax ceiling | `setMaxCreatorTaxBps` | Future launches only; the contract caps it at 10%, the deployed value is 2%. |
| Launch configs | `addLaunchConfig`, `setLaunchConfig` | Supply, base fee, opening quote reserve and tick spacing of future launches. |
| Pair economics | `setPairTokenEconomics` | Which ERC-20s can be a pair through the factory and their opening quote reserve; future launches only. Revoking USDG stops USDG-quoted launches through the factory and, since invented tickers read it, new ticker launches too. |
| Open or close launching | `setLaunchEnabled`, `setWhitelistedLauncher` | New launches only. Every existing pool keeps trading. A factory is born closed; genesis opens it and removes the deployer's own pass, so closing again later closes it for everyone. |
| Registrars | `setRegistrar` | Which contracts may launch with their own pair economics: the ticker, Stock Token, coin and market quote launchers. |
| Fee policy | `setFeePolicy` | The split of future launches. Every existing launch keeps the policy copied at its creation, including the protocol wallet. |
| Fee club | `setFeeClub` | Which contract books the club's share for future launches; the club is frozen into each launch's policy at launch. |
| Ticker launcher | `setTickerLauncher` | Which contract may open a name's dollar pool through the seeder. Set once at deploy; independent of the club. Existing launches keep the club they launched with, and a club that fails to book a fee sends that slice to the protocol rather than blocking a collection. |
| Move a fee wallet | `proposeCreatorFeeRecipient`, `executeCreatorFeeRecipientChange` | Any coin's creator fee wallet, after a public three day notice and within a three day window. Exists for lost keys and compromised wallets; every use is an event. |
| Reserve a ticker or a name | `AnchorRegistry.reserveTicker`, `reserveNames` | Future launches only: a reserved symbol cannot be invented as a ticker and a reserved name cannot be used by a new coin. |
| Stock Token, coin and market targets | `StockQuoteLauncher.setTargetRaiseUsd`, `setMaxStaleness`, `CoinQuoteLauncher.setTargetRaise`, `MarketQuoteLauncher.setTargetRaise`, `setMinDepth` | The opening market cap of future launches in those modes. |
| Give up ownership | `renounceOwnership` | Freezes the terms of future launches forever. Cannot be undone. |

What the owner cannot do: take anything out of a pool, a locked position, the fee escrow, or a ticker's USDG reserve; stop an existing coin from trading; change an existing launch's fee, tax, pair or economics; mint, freeze or blacklist a coin; block a fee collection. There is no rescue function and no phase in which funds wait on anyone: the pool exists in the launch transaction and the position is locked in it.

Related owners outside the factory: the `AnchorRegistry` owner can `register` / `setActive` anchors (new launches only); the `BuybackVault` owner can `setStrategy`, and only that strategy can release what the vault holds, which is nothing while `buybackBurnBps` is zero. The `BuybackTreasury`, which receives the protocol's fee share, has no owner at all: no admin, no withdrawal, no rescue. Its money leaves only to the team wallet and the dead address, by the rules in [13](./13-official-coin.md).

## Unaudited

tickr v1 has **not** been audited. The contracts are immutable; a bug cannot be patched in place, only mitigated by deploying a new version and stopping new launches on the old factory (`setLaunchEnabled(false)`), which does not affect existing curves or pools. Interact only with amounts you can afford to lose.
