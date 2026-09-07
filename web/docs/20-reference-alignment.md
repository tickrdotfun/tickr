# 20 · Reference versus production

The managed ticker system and the two activation buys were built from a reference that traded on the public chain on 2026-09-07 (PING priced in PONG, two activations, then a buy and a sell through an aggregator's router). This page lists every difference between that reference and what tickr deploys, why each exists, and what validates it. A difference is not a vulnerability, but nothing a difference touches inherits the reference's evidence; each is tested on its own.

## Preserved as the reference had it

| Piece | Reference | Production | Validation |
|---|---|---|---|
| The wrapper | `ManagedTickerToken.sol` | the same file, one line changed: the hook binding is read from the shared hook's registry (`tokenOf(poolId)`) instead of a per-wrapper `token()` | `test/ManagedTickerMarket.t.sol` is the reference's suite ported unchanged; `ManagedTicker.t.sol` and `Ticker.t.sol` on the production path |
| The hook's permissions | the five plain callbacks, no swap deltas, no dynamic fee | identical | `test_hook_ordinaryAccountingOnly_andBoundToTheLauncher` checks the flags on the deployed address |
| Pool terms | fee 500, tick spacing 1, positions [-2, 0], [0, 2] and the retained [-2, 2] | identical | the market suite |
| Inventory floor, donation, cash keep, retained sides, recentre budget | 10,000e6, 1 USDG minimum, 0.01 USDG, 0.001 units, 4,096 raw | identical | the market suite; `INVENTORY_FLOOR` is a launcher constant |
| Activation route | native ETH/USDG, then the name's pool, then the coin's pool, through the canonical Universal Router, output to the wallet, `0x1004` / `0x070c0f` | identical bytes: `UniversalRouterBuy.sol` (scripts, fork test) and `web/src/lib/activation.ts` (site) | `test_fork_activation_throughTheCanonicalUniversalRouter` on the live chain's router and quoter; 31 offline cases in `web/scripts/tests/activation.test.cjs` on the encoding, its checks and the receipt verification |
| Activation amounts and tolerance | 0.0005 ETH, then 0.001 ETH; one percent under a fresh quote | identical defaults (`GENESIS_QUOTE_BUY_ETH`, `GENESIS_COIN_BUY_ETH`; the site's `AMOUNTS`) | any other amount needs its own acceptance test, as the reference said |
| Both stages, always | two purchases also under an existing name | identical: the site never skips the name purchase | `useActivation` has no skip path |
| The wallet journal | intent saved before the wallet opens, hash saved on return, unknown outcomes reconciled by hand, one signing lock per wallet across tabs, receipts verified for canonical inclusion, order, swaps on the exact pools and delivery | ported, scoped by chain, wallet and coin | the offline cases; the R15 closure checks in the brief |

## Different, and why

| Piece | Reference | Production | Why | Validation |
|---|---|---|---|---|
| One hook per wrapper | a hook deployed per wrapper with the wrapper's address in it | one `ManagedTickerHook` for every name, with a registry the launcher fills at creation | a creator cannot mine and deploy a hook address inside a launch; one shared hook keeps a launch to one transaction | `test_hook_aSecondNameGetsItsOwnPoolBehindTheSameHook`, the registration and binding tests, the fork test on the canonical pool manager |
| Who creates the wrapper | a pilot adapter that installed one predeployed wrapper | `TickerLauncher._create` through `ManagedTickerDeployer` (CREATE2, the creation code kept out of the launcher for size) | the general issuer path the reference asked for | `predictTicker` equals the created address; the ordering tests; the size report |
| Name addresses | not constrained | every name starts with `0xF`; every coin must sort below its name (`CoinNotFirst`) | the reference's orientation (coin first), enforced for every launch rather than checked by hand | `test_ticker_predictionMatchesCreation_andSitsInTheTopSixteenth`, `test_ticker_aCoinThatWouldSortAboveItsNameIsRefused`, the genesis and seed grinds |
| The name fee | a 1 USDG donation from the deployer | the 0.0015 ETH ticker fee converted through the live ETH/USDG pool with a floor of 1 USDG, all of it the wrapper's surplus | the launch pays for its own pool; no separate funding step | `test_ticker_inventingANameOpensItsOwnDollarPool`, the fork test's real USDG surplus |
| Genesis | not part of the reference | FUN and TICKR go through the same launch path and the same two activation buys from the deployer | the official coin follows the rule it sets | `Genesis.t.sol`, the fork cycle |
| Site routing for ordinary buys | not part of the reference | the zap wraps one for one or trades the name's pool, whichever pays more; a buy above the pool's offer wraps | a creator's buyers should not hit the pool's per-swap cap | `Zap.t.sol`, `test_managed_ethIntoACoinThroughTheNamePool_oneUnlock` |

## Not proven by the reference, said plainly

- The reference proves one sequence at one size on one day. It does not prove instant listing, listing at every size, dollar prices on every chart, or that any aggregator will route a given trade.
- A name's pool takes one visit per transaction. Split routes that cross it twice are unsupported and revert.
- The offer through a name's pool is finite: the floor plus four times the circulation, per swap. Larger buys wrap.
- A confirmed activation is "on-chain sequence confirmed, external trading unverified" until a real buy and sell through an outside router are recorded for that launch; the launch runbook records them.
