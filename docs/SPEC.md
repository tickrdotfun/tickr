# tickr, Protocol Specification (v2)

The build spec, in the order the protocol runs. Everything here is checkable against `contracts/src`.

## 1. First principles

No custody, atomic launches, everything readable on chain, immutable per version, the creator holds nothing at creation except a disclosed dev buy, every coin ends in 6942. See [01](./01-first-principles.md).

## 2. Lifecycle

One state: live. `Factory._launch` deploys the coin (`LaunchDeployer.deployToken`, CREATE2, salt namespaced by the initiator), opens its Uniswap v4 pool at the opening price with no hook, tick spacing 10, fee `(baseFeeBps + creatorTaxBps) * 100`, mints one position holding the entire supply from the opening tick to the end of the range to `LaunchLocker` (`LaunchSeeder.seedLaunch`), records `LaunchedToken` and copies the `FeePolicy` in force. A dev buy is a swap on the new pool in the same transaction through `LaunchAndBuyRouter` or a launcher. No graduation, no phases, no rescue, no snipe tax.

## 3. Pool math

Opening price `p0 = phantomQuote / supply`. A one-sided position from `p0` upward is a constant product pool with a virtual quote reserve `P = phantomQuote`: coins left `t = P S / (P + q)`, market cap `(P + q)^2 / P`. Fees are the pool's LP fee, taken from the input of every swap. See [03](./03-curve-math.md).

## 4. Pairs

ETH (config economics), USDG and any ERC-20 the owner approves with `setPairTokenEconomics(pair, phantomQuote)` and the registry lists; registrars supply economics for the rest: `TickerLauncher` (invented tickers, USDG economics), `StockQuoteLauncher` (official Stock Tokens, opening cap from the Chainlink feed and a USD target), `CoinQuoteLauncher` (coins launched here, opening cap from the quote's own pool), `MarketQuoteLauncher` (any token with a deep enough Uniswap v3 pool against WETH or USDG, opening cap from that pool's spot price, floors 5 WETH or 15,000 USDG). Every launcher pins economics with `expectedEconomics`.

## 5. Invented tickers

`TickerToken`: a one for one wrapper of USDG, mint and redeem, no owner. `TickerLauncher.launch(symbol, coin, cfg)` creates the wrapper at CREATE2 by symbol if new, charging `NEW_TICKER_FEE` (0.0015 ETH) on top of the launch fee, which `LaunchSeeder.seedDollarPool` converts to USDG through the live ETH/USDG pool and locks in a WRAPPER/USDG pool at one dollar behind `ChartGuardHook` (only the seeder may initialize, only at one dollar, liquidity only within 10 ticks, any swap leaving 2 ticks reverts), then a listing swap. The club: 10% of the base fee of every coin under a ticker goes to `pot(ticker, epoch, coin)` on collection; `recordVolume` credits the same epoch; `claimClub` pays a member `pot * v / total` per payer, by amount; `sweepDeadPot` pays the payer's own share to the protocol. Reserved official symbols cannot be invented.

## 6. Fees

Launch fee 0.0005 ETH to the protocol at creation. Pool fee 1% base plus creator tax 0 to 2% (contract cap 10%), the pool's own LP fee. `LaunchLocker.collectFees` splits the base part 60 / 10 / 30 creator / club / protocol under a ticker and 70 / 30 elsewhere; the tax part is the creator's; the whole coin side is burned to `0xdEaD`, nobody is paid in the coin; everything for the creator and the protocol lands in `FeeEscrow`, pull only. See [06](./06-fees.md).

## 7. Contracts

`Factory` (launches, records, owner terms, CTO timelock), `LaunchDeployer` (CREATE2 coins), `LaunchSeeder` (pools, positions, dollar pools, exact-in swaps), `LaunchLocker` (positions and fee collection, no withdrawal), `FeeEscrow`, `TickerLauncher` and `TickerToken`, `ChartGuardHook`, `StockQuoteLauncher`, `CoinQuoteLauncher`, `MarketQuoteLauncher`, `LaunchAndBuyRouter`, `ZapRouter`, `AnchorRegistry`, `BuybackVault`, `Token`. Deployment wiring: the factory address is predicted four creates ahead and checked with `require`; the seeder is predicted for the guard hook the same way; both hooks are CREATE2 with mined flag bits.

## 8. Integration

See [15](./15-launching-from-code.md), [16](./16-trading-from-code.md), [17](./17-reading-state.md) and [18](./18-events-and-errors.md).

## 8b. Test matrix (contracts/test)

`Launch.t.sol`: pool opens with the whole supply locked, opening market cap, dev buy first, both currency orders, sells, pinned economics, fee exactness, tax cap, salt namespacing. `Fees.t.sol`: quote side split 30 / 70, coin side burn and creator escrow, creator tax, club 60 / 10 / 30, empty collection. `Ticker.t.sol`: inventing a name opens the locked guarded pool, fee exactness, one for one both ways, reserved symbols, shove reverts, only the seeder initializes, pro rata club, held-back collection. `Quotes.t.sol`: Stock Token and coin quotes, wild quotes refused. `Zap.t.sol`: one hop, ticker route both ways, preview equals execution, bad path, expiry. `Owner.t.sol`: club swap harmless, CTO timelock, creator transfer, closing launches keeps trading, tax cap. `fork/RobinhoodFork.t.sol`: the same against the canonical Uniswap v4 on Robinhood Chain state, real USDG, live v3 for NVDA.

## 9. Risks

See [09](./09-risks.md).
