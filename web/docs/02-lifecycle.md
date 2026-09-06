# 02 · What a launch does

A coin on tickr has one state: live. What follows is what happens in the launch transaction, what happens on every trade after it, and what happens to the fees.

## 1. Create

The creator picks a name, a symbol, an image, a description, socials, a pair, an optional creator tax (0 to 2%), an optional dev buy, and a fee wallet (defaults to the launching wallet). The pair is ETH, USDG, an official Stock Token from the Robinhood Assets registry, a coin already launched here, or an invented ticker.

`Factory._launch`, called through `launchToken` (ETH and USDG), `launchTokenFor` (the launch and buy router) or `launchTokenWithPair` (the ticker, Stock Token and coin launchers, which supply the pair's economics), does the following in order. Either all of it happens or none of it does.

1. Checks: the launch config exists and is enabled, launching is open or the caller is whitelisted, `msg.value` equals the launch fee, the creator tax is within the cap, the symbol and name are not reserved for official assets, `expectedEconomics` matches the economics in force, the pair's decimals match.
2. `LaunchDeployer.deployToken` deploys the coin at its CREATE2 address and hands the supply to the factory.
3. The factory builds the pool key: the two tokens sorted by address, fee `(baseFeeBps + creatorTaxBps) * 100` in pips, tick spacing 10, no hook.
4. `LaunchSeeder.seedLaunch` initializes the pool at the opening price and mints one position holding the entire supply, from that price to the end of the range, to `LaunchLocker`. Rounding dust of the coin goes to the locker too.
5. The launch record and the fee policy in force are stored against the coin, the launch fee is credited to the protocol's escrow, and `TokenLaunched` and `LaunchPositionLocked` are emitted.

A dev buy is a swap on the new pool in the same transaction, done by the router or launcher that called the factory: `LaunchAndBuyRouter.launchAndBuy` for ETH and USDG, `launchAndBuy` on the ticker launcher (paid in USDG, wrapped into the ticker on the way in), `launchWithStockQuoteAndBuy` and `launchWithCoinQuoteAndBuy` for the other two.

Inventing a new ticker costs `TickerLauncher.NEW_TICKER_FEE` on top of the launch fee. That fee buys USDG and opens the ticker's guarded one dollar pool, locked, in the same transaction. See [05 anchors](./05-anchors.md).

## 2. Trade

The pool is a plain Uniswap v4 pool. Anything that trades Uniswap v4 on Robinhood Chain trades it from the block it is created in: the site through `ZapRouter`, `LaunchSeeder.swapExactIn` for a single pool, Uniswap's own router, aggregators, terminals and bots. The pool's LP fee is the 1% base plus the creator's tax, charged on every swap in the asset that goes in: buys pay it in the pair, sells pay it in the coin.

A buy out of the pool in a coin's first five seconds pays a snipe tax: 99% in the launch second, 25% one second in, 3% at two, then dust, then nothing from the fifth second on. It is burned to the dead address like every coin-side fee. The launcher's wallet and its fee wallet never pay it, and sells never do. Beside it, counted in blocks: in the launch block only the launch's own wallets may buy out of the pool, and in the two blocks after it every other wallet may hold at most 5% of supply and buy at most 5.5% of it, all its buys added up, net of the tax. A buy that would break either limit reverts whole. Sells are never limited. A transfer between wallets inside those two blocks is held to the same 5%, so a holding over the cap cannot be assembled from several wallets while the window is open; it counts as nothing bought. From the fourth block every limit is gone for good and transfers are free. There is no trading delay beyond that. The dev buy is the creator's way to be first.

What the two rules cover, exactly: coins leaving the pool manager as ERC-20 transfers, and, for the hold cap, coins arriving anywhere but the launch's own wallets and the protocol's contracts. A trader who settles a swap into ERC-6909 claim balances inside the pool manager and withdraws them after the window is seen by neither rule; the usual routers, the seeder and the zap, never do that. The rules make the obvious routes expensive in the first seconds; they do not make a launch impossible to snipe, and they do not stop a wallet that bought under the cap from buying again once the window closes.

## 3. Fees

A swap through `LaunchSeeder.swapExactIn` that a pool cannot fill in full returns what the pool did not take to the caller in the same transaction. Fees accrue to the locked position, like every Uniswap fee. `LaunchLocker.collectFees(token)` pulls what the position has earned and splits it by the terms frozen at launch. Anyone may call it, at any time. Details in [06 fees](./06-fees.md).

## The locker

`LaunchLocker` holds every launch position and every rounding remainder. It can receive positions and collect their fees, and nothing else: nothing in it can hand a position to anyone or take liquidity out of one, whoever asks, the owner and the creator included. Fee collection is a zero-liquidity decrease, which Uniswap uses to pay out owed fees without touching the principal. Other people may add liquidity to a tickr pool and remove their own again; only the launch position is locked.
