# 06 · Fees

Three inputs, one place they land, one function that splits them.

## The inputs

| what | amount | when |
| --- | --- | --- |
| launch fee | 0.0005 ETH | once, at creation, to the protocol |
| new ticker fee | 0.0015 ETH more | once, when a ticker is invented; it opens the ticker's dollar pool, locked |
| pool fee | 1% base plus the creator's tax, 0 to 2% | every buy and sell, taken by the pool from the swap's input |

The pool fee is the pool's own LP fee, fixed when the pool is created: `(baseFeeBps + creatorTaxBps) * 100` in Uniswap's hundredths of a bip, so 10000 for 1%. It is part of the pool key and can never change. Buys pay it in the pair, sells pay it in the coin, and it accrues to the locked launch position.

## FeePolicy

```solidity
struct FeePolicy {
    address protocolFeeRecipient; // the protocol's recipient, the BuybackTreasury, frozen into every launch
    uint16 creatorShareBps;       // of the base fee: 6000 under an invented ticker, 7000 elsewhere
    uint16 clubShareBps;          // 1000 under an invented ticker, 0 elsewhere
    uint16 protocolShareBps;      // 4000
    uint16 buybackBurnBps;        // 0 at launch; reserved for a later buyback policy
    uint16 hookFeeBps;            // the base fee in bps, 100, copied from the config at launch
    uint16 maxInternalPriceImpactBps; // unused in this version
}
```

The policy in force is copied into the launch record at creation. If the pair is not an invented ticker, the club's share folds into the creator's, so the split a launch shows is the split it keeps. The owner can change the policy for future launches only.

## Collecting

`LaunchLocker.collectFees(token)` is permissionless. It performs a zero-liquidity decrease on the launch position and takes both currencies to the locker, then splits each side:

1. The pool fee is base plus tax. The base part of what came in is `amount * baseFeeBps / (baseFeeBps + creatorTaxBps)`; the rest is the creator's tax and is the creator's alone.
2. The base part of the quote side goes 40% to the protocol's escrow balance, 10% to the ticker club when the pair is an invented ticker, and the remainder to the creator's escrow balance. The club is paid by transferring the wrapper to `TickerLauncher` and calling `onClubFee`, and the volume that fee stands for is recorded with `recordVolume`. A club that cannot book its slice hands it to the protocol instead of blocking the collection.
3. The coin side splits the same way. The base part goes 40% to the dead address for the protocol, 10% to the dead address for the club when there is one, and the remainder to the creator's escrow balance in the coin; the tax part goes whole to the creator's escrow balance in the coin. So every sell still takes coins out of circulation, the protocol's and the club's shares of it, and creators keep their own. Every coin launched here deflates on every sell.

`FeesCollected` reports every figure of a collection. `LaunchLocker.pendingFees(token)` shows what is owed before one.

The protocol's 40% is paid to the `BuybackTreasury`, not to a wallet: half of it buys and burns TICKR, half funds the team. See [13 the official coin](./13-official-coin.md). Inside a coin's first five seconds, a buy pays a snipe tax on the coin side too, burned to the dead address like every other coin-side fee; see [02 lifecycle](./02-lifecycle.md). The club a launch pays is frozen with its split: `FeePolicy.club` is written at launch and the locker pays that address and no other. A later change of the factory's club, or a club that is not a contract, touches no existing launch; a slice with nobody to book it goes to the protocol.

## Who collects

Anyone may call `collectFees(token)` at any time and pays only the gas. tickr also runs a keeper: the wallet that deployed the contracts, which holds no power once ownership has moved to the owner wallet, calls `collectFees` on every coin whose `pendingFees` are worth more than the gas, on a schedule. The same call from any other wallet does the same thing. Its address is published in [07 addresses](./07-addresses.md) once it exists.

## Claiming: FeeEscrow

Escrow balances are pull only. `claim()` pays the caller its ETH balance, `claimToken(token)` its balance in that token. Nothing is pushed to anyone, so a recipient that rejects transfers blocks only itself.

## Moving where fees go

The creator fee wallet can hand its role to another wallet with `transferCreatorFeeRecipient(token, newRecipient)`, from the wallet that holds it. Collections from then on credit the new wallet; nothing already credited in the escrow moves, so claim first. Club rewards the coin has earned but not yet claimed go to whoever holds the fee wallet when `claimClub` runs, since the club pays the recipient current at claim time. It cannot be undone by anyone but the new wallet, or by the owner's proposal path below, which a move by the creator does not cancel. The coin's own exemption from the snipe tax follows the new wallet. The site shows this as one row on the fees tab, to the creator only. The owner's slower path for lost keys and stolen wallets, a public three day notice and then a three day window in which anyone may execute, is in [09 risks](./09-risks.md); while one is pending the coin's page says so.

## The ticker club

Under an invented ticker, 10% of the base fee of every coin goes into that coin's pot for the current thirty day epoch, and the creators of the other coins under the same ticker claim from it in proportion to their recorded volume. Details in [05 anchors](./05-anchors.md).

## BuybackVault

`buybackBurnBps` is zero in the policy at launch, so no buyback is taken. The vault exists so a future policy can route a share of new launches' fees into it; the owner's only power over it is to set the strategy that may release what it holds.
