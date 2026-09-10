# 06 · Fees

Three inputs, one place they land, one function that splits them.

## The inputs

| what | amount | when |
| --- | --- | --- |
| launch fee | 0.0005 ETH | once, at creation, to the protocol |
| new ticker fee | 0.0015 ETH more | once, when a ticker is invented; it becomes the working dollars of the ticker's own pool |
| pool fee | 1% base plus the creator's tax, 0 to 2% at launch (the owner can raise that ceiling for later launches, never above 10%; TICKR itself carries 2%) | every buy and sell, taken by the pool from the swap's input |
| pool fee, under a fixed-inventory name | 0.82% flat, no creator tax | every buy and sell, same mechanism |

The pool fee is the pool's own LP fee, fixed when the pool is created: `(baseFeeBps + creatorTaxBps) * 100` in Uniswap's hundredths of a bip, so 10000 for 1%. It is part of the pool key and can never change. Buys pay it in the pair, sells pay it in the coin, and it accrues to the locked launch position.

### The frozen fee on the market path

A coin launched under a fixed-inventory name pays 82 bps, which is 8200 pips, and its creator tax is zero.
That is not a default. `MarketTickerLauncher` reads the launch config it was handed and reverts with
`NotTheFrozenFee(baseFeeBps, creatorTaxBps)` unless both numbers are exactly the frozen ones.

The check exists because the factory does not do it. `launchTokenWithPair` gates only on whether the caller is a
registrar, and the config id is whatever the caller passed. Without the launcher's own check, an authorised
registrar could open a coin at any fee the factory happened to have configured. So the launcher refuses instead
of trusting, and the fee a market-path coin carries is the same for every one of them, forever.

## FeePolicy

```solidity
struct FeePolicy {
    address protocolFeeRecipient; // the protocol's recipient, a BuybackTreasury, frozen into every launch
    uint16 creatorShareBps;       // of the base fee: 5000 under a redeemable name, 6000 elsewhere
    uint16 clubShareBps;          // 1000 under a redeemable name, 0 elsewhere; the three always sum to 10000
    uint16 protocolShareBps;      // 4000
    uint16 buybackBurnBps;        // 0 at launch: the vault route is off. the treasury's buyback and burn of TICKR is a separate mechanism, and on
    uint16 hookFeeBps;            // the base fee in bps, 100, copied from the config at launch
    uint16 maxInternalPriceImpactBps; // unused in this version
}
```

The policy in force is copied into the launch record at creation. If the pair has no club, the club's share folds
into the creator's, so the split a launch shows is the split it keeps. The owner can change the policy for future
launches only.

A fixed-inventory name has no club. The ticker club belongs to `TickerLauncher`, and a name it did not invent is
not in it. So a coin launched under a fixed-inventory name freezes at **60% creator, 0% club, 40% protocol**: the
1000 bps club share folds into the creator's 5000. Nothing was configured to make that happen; it is what
`Factory._launch` already did for any pair without a club.

Two treasuries are now in the records, and which one a coin pays is decided once, at its launch, and never again.

| launched | protocol fee recipient | what it does with a name it collects |
| --- | --- | --- |
| before the market release | `BuybackTreasury` `0x60C1276f...` | mints and redeems a redeemable name one for one; a name it cannot convert is forwarded to the team whole |
| from the market release on | `BuybackTreasuryV2` `0x8dcaBBf0...` | converts a fixed-inventory name through that name's own market, so the buyback share is not lost to the team |

That was the reason for the second treasury. The first one has no way to value a name that is not a dollar, so
every fixed-inventory name's fees would have gone to the team in full and the burn share of them would have been
zero. This does not mean the old treasury allocated zero overall; it allocated zero out of that particular
revenue.

## Collecting

`LaunchLocker.collectFees(token)` is permissionless. It performs a zero-liquidity decrease on the launch position and takes both currencies to the locker, then splits each side:

1. The pool fee is base plus tax. The base part of what came in is `amount * baseFeeBps / (baseFeeBps + creatorTaxBps)`; the rest is the creator's tax and is the creator's alone.
2. The base part of the quote side goes 40% to the protocol's escrow balance, 10% to the ticker club when the pair is a redeemable name, and the remainder to the creator's escrow balance. The club is paid by transferring the wrapper to `TickerLauncher` and calling `onClubFee`, and the volume that fee stands for is recorded with `recordVolume`. A club that cannot book its slice hands it to the protocol instead of blocking the collection.
3. The coin side splits the same way. The base part goes 40% to the dead address for the protocol, 10% to the dead address for the club when there is one, and the remainder to the creator's escrow balance in the coin; the tax part goes whole to the creator's escrow balance in the coin. So every sell still takes coins out of circulation, the protocol's and the club's shares of it, and creators keep their own. Every coin launched here deflates on every sell.

`FeesCollected` reports every figure of a collection. `LaunchLocker.pendingFees(token)` shows what is owed before one.

The protocol's 40% is paid to the `BuybackTreasury`, not to a wallet: half of it buys and burns TICKR, half funds the team. The half and half split between buybacks and the team applies to revenue the treasury can convert to USDG, which is USDG, ETH and redeemable names; fees paid in an asset it cannot convert at par, a Stock Token or a coin used as a quote, are forwarded to the team in full; and the protocol's and the club's sell-side shares, paid in the launched coin, are burned by the locker directly and never reach the treasury. See [13 the official coin](./13-official-coin.md). Inside a coin's first five seconds, a buy pays a snipe tax on the coin side too, burned to the dead address like every other coin-side fee; see [02 lifecycle](./02-lifecycle.md). The club a launch pays is frozen with its split: `FeePolicy.club` is written at launch and the locker pays that address and no other. A later change of the factory's club, or a club that is not a contract, touches no existing launch; a slice with nobody to book it goes to the protocol.

## Who collects

Anyone may call `collectFees(token)` at any time and pays only the gas, and that is the only thing that makes a collection happen.

tickr ran a keeper for this, a wallet with no power over anything that called `collectFees` on a schedule. **It is switched off.** Nothing collects automatically now. Fees accrue on the locked position until somebody calls `collectFees`, and anybody may. Do not rely on a collection happening on its own, and do not assume `pendingFees` will be swept for you.

## Claiming: FeeEscrow

Escrow balances are pull only. `claim()` pays the caller its ETH balance, `claimToken(token)` its balance in that token. Nothing is pushed to anyone, so a recipient that rejects transfers blocks only itself.

## Moving where fees go

The creator fee wallet can hand its role to another wallet with `transferCreatorFeeRecipient(token, newRecipient)`, from the wallet that holds it. Collections from then on credit the new wallet; nothing already credited in the escrow moves, so claim first. Club rewards the coin has earned but not yet claimed go to whoever holds the fee wallet when `claimClub` runs, since the club pays the recipient current at claim time. It cannot be undone by anyone but the new wallet, or by the owner's proposal path below, which a move by the creator does not cancel. The coin's own exemption from the snipe tax follows the new wallet. The site shows this as one row on the fees tab, to the creator only. The owner's slower path for lost keys and stolen wallets, a public three day notice and then a three day window in which anyone may execute, is in [09 risks](./09-risks.md); while one is pending the coin's page says so.

## The ticker club

Under a redeemable name, 10% of the base fee on the quote side of every coin, what buys pay, goes into that coin's pot for the current thirty day epoch (the coin side's club share is burned, not pooled), and the creators of the other coins under the same ticker claim from it in proportion to their booked volume: when a coin's fees are collected, the locker books the quote fees collected divided by the pool fee rate as that coin's volume for the window of the collection. so it stands for buy volume in the quote, since only buys pay fees in the quote, and a coin's weight for a window depends on when someone collected. Details in [05 anchors](./05-anchors.md).

## BuybackVault

`buybackBurnBps` is zero in the policy at launch, so nothing is routed to the vault. That is one mechanism; the treasury's buyback and burn of TICKR, half of the protocol's share, is another and is on from the first launch, see [13 the official coin](./13-official-coin.md). The vault exists so a future policy can route a share of new launches' fees into it; the owner's only power over it is to set the strategy that may release what it holds.
