# 07 · Addresses

## Chain

| | |
|---|---|
| Network | Robinhood Chain (mainnet) |
| Chain id | `4663` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| Gas token | ETH |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| USDG | `0x5fc5360D0400A0Fd4f2af552ADD042D716F1d168` (6 decimals) |

tickr curves and pools use native ETH (`address(0)`), not WETH. WETH is listed for wallets and aggregators only.

## Canonical Uniswap v4 on Robinhood Chain

These are the deployments tickr calls. `LaunchSeeder`, `LaunchLocker`, `CoinQuoteLauncher`, `MarketQuoteLauncher` and `TickerLauncher` are constructed with them as immutables. `ManagedTickerHook` is deployed with the stack too: every invented ticker's own pool is created behind it, and it holds nothing.

| Contract | Address |
|---|---|
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

## Uniswap v3 (reference only)

Not used by tickr. Listed because wallets and routers on the chain may quote through them.

| Contract | Address |
|---|---|
| v3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| v3 NonfungiblePositionManager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| v3 SwapRouter | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| v3 QuoterV2 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` |

## tickr v1 contracts

Addresses are written to `contracts/deployments/4663.json` by the deploy script. Until then every row is TBD. Wiring is immutable, so once deployed these never change for v1; a v2 will be a new table.

| Contract | Job | Address |
|---|---|---|
| `LaunchDeployer` | CREATE2 coin; `predictToken(initiator, params, supply)` | TBD, see `contracts/deployments/4663.json` after deploy |
| `LaunchSeeder` | Opens a launch pool at the opening price with the supply in a locked one-sided position; `swapExactIn` and `swapExactInBounded` on any pool | TBD, see `contracts/deployments/4663.json` after deploy |
| `FeeEscrow` | Pull-based protocol + creator balances (native + ERC-20) | TBD, see `contracts/deployments/4663.json` after deploy |
| `LaunchLocker` | Holds every launch position; `collectFees` splits the pool's fees per the frozen terms; no withdrawal | TBD, see `contracts/deployments/4663.json` after deploy |
| `LaunchAndBuyRouter` | Create + first buy in one tx (must be a factory registrar) | TBD, see `contracts/deployments/4663.json` after deploy |
| `AnchorRegistry` | ETH / USDG / official Stock Token allowlist | TBD, see `contracts/deployments/4663.json` after deploy |
| `BuybackVault` | Receives buyback slices; strategy interface only in v1 | TBD, see `contracts/deployments/4663.json` after deploy |
| `BuybackTreasury` | The protocol's fee recipient, frozen into every launch: collects the protocol share, pays the team half, buys TICKR with the other half and burns it. No owner | TBD, see `contracts/deployments/4663.json` after deploy |
| `TickerLauncher` | Invents tickers (one-for-one USDG wrappers, each running its own dollar pool) and launches coins under them; a factory registrar and the ticker club; no owner | TBD, see `contracts/deployments/4663.json` after deploy |
| `Factory` | Launches, records, owner terms, the CTO timelock; `launchToken`, `getLaunchedToken`, `poolKeyOf` | TBD, see `contracts/deployments/4663.json` after deploy |
| `ManagedTickerDeployer` | Deploys each ticker's wrapper at its CREATE2 address, for the ticker launcher alone; holds the wrapper's creation code so the launcher stays under the size limit | TBD, see `contracts/deployments/4663.json` after deploy |
| `ManagedTickerHook` | The one hook on every ticker's own pool: hands each pool's callbacks to its wrapper, so the wrapper tops up its offer before a swap and checks the price and its backing after; only the wrapper touches its pool's liquidity | TBD, see `contracts/deployments/4663.json` after deploy |
| `CoinQuoteLauncher` | Mode 3: launches priced in a coin launched here, opening cap from its pool | TBD, see `contracts/deployments/4663.json` after deploy |
| `StockQuoteLauncher` | Mode 4: launches priced in a Stock Token, opening cap from its Chainlink feed | TBD, see `contracts/deployments/4663.json` after deploy |
| `MarketQuoteLauncher` | Mode 5: launches priced in any token with a deep enough Uniswap v3 pool against WETH or USDG | TBD, see `contracts/deployments/4663.json` after deploy |
| `ZapRouter` | Buy or sell any coin with ETH in one transaction, whatever it is quoted in | TBD, see `contracts/deployments/4663.json` after deploy |


A coin's `Token` contract is created at launch time, and an invented ticker (`TickerToken`) the first time its symbol is used; find them from `TokenLaunched` and `TickerCreated` events or `Factory.getLaunchedToken(token)` / `TickerLauncher.isTicker(addr)`.

`BuybackTreasury` is deployed before the factory, because the factory names it as the protocol fee recipient and that address is frozen into every launch from the first one on. It has no owner, so it is not in the handover below. The deploy runs in a fixed order: `Deploy.s.sol`, then `RegisterStockTokens.s.sol`, then `Genesis.s.sol`, all signed by the deployer while it is still the owner; only then does the owner wallet call `acceptOwnership()` on the six owned contracts (`Factory`, `AnchorRegistry`, `BuybackVault`, `CoinQuoteLauncher`, `StockQuoteLauncher`, `MarketQuoteLauncher`). Genesis opens launches and removes the deployer's own pass. Start `getLogs` from `startBlock`. The owner is the deployer key unless `OWNER` was set, in which case ownership of `Factory`, `AnchorRegistry`, `BuybackVault`, `CoinQuoteLauncher`, `StockQuoteLauncher` and `MarketQuoteLauncher` is offered to it (`TickerLauncher` has no owner) and must be accepted with `acceptOwnership()` on each.
