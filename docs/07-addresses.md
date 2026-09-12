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

These are the deployments tickr calls. `LaunchSeeder`, `LaunchLocker`, `CoinQuoteLauncher`, `MarketQuoteLauncher` and `TickerLauncher` are constructed with them as immutables. `ManagedTickerHook` is deployed with the stack too: every redeemable name's own pool is created behind it, and it holds nothing. A fixed-inventory name's pool has no hook.

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

Deployed and live. Wiring is immutable, so these never change for v1; a v2 will be a new table. The same
addresses are in `contracts/deployments/4663.json`, which is what the site is built from.

| Contract | Job | Address |
|---|---|---|
| `Factory` | Launches, records, owner terms, the CTO timelock; `launchToken`, `getLaunchedToken`, `poolKeyOf` | `0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f` |
| `LaunchDeployer` | CREATE2 coin; `predictToken(initiator, params, supply)` | `0xD86C1Cc523256519Dbd608318395e0C97e0368d6` |
| `LaunchSeeder` | Opens a launch pool at the opening price with the supply in a locked one-sided position; `swapExactIn` and `swapExactInBounded` on any pool | `0x3733576410312D34B53F90cFE513B0D0995aB6Ca` |
| `FeeEscrow` | Pull-based protocol + creator balances (native + ERC-20) | `0xCf706542a17ee6C0Cc9595E3f49d9131aF3331ba` |
| `LaunchLocker` | Holds every launch position; `collectFees` splits the pool's fees per the frozen terms; no withdrawal | `0xDfD29cB10Ff0491CdF7896F75e54f4357F4a42b8` |
| `LaunchAndBuyRouter` | Create + first buy in one tx (must be a factory registrar) | `0x22EC456D584cB92bdFA13469E70936e3192fd746` |
| `AnchorRegistry` | ETH / USDG / official Stock Token allowlist | `0x7927cB22b4C5AA0DBdd851805d3149AAC07e2BC1` |
| `BuybackVault` | Receives buyback slices; strategy interface only in v1 | `0x8c3ed4F9616893AFE2608079D2Bb02EAaCD099E5` |
| `BuybackTreasury` | The fee recipient frozen into every launch made before the market release, TICKR's included: collects the protocol share, pays the team half, buys TICKR with the other half and burns it. No owner | `0x60C1276ff7fEB5bC15f6f05C23D9de12fa0E72BA` |
| `BuybackTreasuryV2` | The fee recipient for launches made from the market release on. Same halves, and it converts a fixed-inventory name through its own market instead of forwarding it to the team | `0x8dcaBBf003e3d8C187D18f0a38cB1ac906D3FE28` |
| `TickerLauncher` | Invents redeemable names (one-for-one USDG wrappers, each running its own dollar pool) and launches coins under them; a factory registrar and the ticker club; no owner | `0x7f6c8bA781b5bDC499F2BA7501A2178508877649` |
| `ManagedTickerDeployer` | Deploys each redeemable name's wrapper at its CREATE2 address, for the ticker launcher alone; holds the wrapper's creation code so the launcher stays under the size limit | `0xe773BC7a4710DcAB084754bD296a84AF7ed9e4E7` |
| `ManagedTickerHook` | The one hook on every redeemable name's own pool: hands each pool's callbacks to its wrapper, so the wrapper tops up its offer before a swap and checks the price and its backing after; only the wrapper touches its pool's liquidity | `0x3adE2d75475e3262A4dfd1b55c012d39d704eAC0` |
| `MarketTickerLauncher` | Invents fixed-inventory names and launches coins under them; a factory registrar; no owner. Refuses any launch whose fee is not the frozen one | `0x901c693f5888537e3556AC0e691B0102825e2Ff9` |
| `MarketTickerDeployer` | Holds the fixed-inventory name's creation code and the shape of its market: supply 500,000,000 at 6 decimals, pool fee 500, spacing 10, width 30. Issues only for the launcher above | `0x384fE3D736583597A1fc345758462933455A9516` |
| `QuoteRegistry` | Tells the two kinds of name apart by which issuer made them, so nothing has to trust a name's own answer | `0x771d559712C7580d19432f83A3A7Eb7C6dFFbdCF` |
| `CoinQuoteLauncher` | Mode 3: launches priced in a coin launched here, opening cap from its pool | `0x48535E372642810a69DC7e11A2a5C2709B8119D0` |
| `StockQuoteLauncher` | Mode 4: launches priced in a Stock Token, opening cap from its Chainlink feed | `0x719EDF3aE0aB42B9657983c617aA1b16aCDEd4b0` |
| `MarketQuoteLauncher` | Mode 5: launches priced in any token with a deep enough Uniswap v3 pool against WETH or USDG. Deployed at `0x4Dc4404ac80fC4372B689f0013b8adACf1E0B61b` but not wired into the site, so the mode is not offered | not in use |
| `ZapRouter` | Buy or sell any coin with ETH in one transaction, whatever it is quoted in | `0xeB3E56b10C58e1149Ae38B65E0B28A90cC33ffe4` |
| Universal Router | The two activation buys a fixed-inventory launch ends with | `0x8876789976dEcBfCbBbe364623C63652db8C0904` |
| v4 Quoter | Quotes used by the site; reads only | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |

Logs start at block `57108282`.

## The official coin

| | |
|---|---|
| TICKR | `0x51d553Efd2E8D772AEe6d602A9ea26C56c9a6942` |
| FUN, the name it is priced in | `0xF9d30A05A63d795e3eF37b34143f33b2cBEf0f14` |

FUN is a redeemable name, not a fixed-inventory one: it predates the market release and `QuoteRegistry.kindOf`
does not classify it. It stays one for one with USDG for as long as it exists. See
[13 the official coin](./13-official-coin.md).


A coin's `Token` contract is created at launch time, and a name the first time its symbol is used: a
`TickerToken` from `TickerLauncher` if it is redeemable, a fixed-inventory name from `MarketTickerLauncher` if
it is not. Find them from `TokenLaunched`, `TickerCreated` and `NameCreated` events, or from
`Factory.getLaunchedToken(token)`, `TickerLauncher.isTicker(addr)` and `QuoteRegistry.kindOf(addr)`.

`BuybackTreasury` is deployed before the factory, because the factory names it as the protocol fee recipient and that address is frozen into every launch from the first one on. It has no owner, so it is not in the handover below. The deploy runs in a fixed order: `Deploy.s.sol`, then `RegisterStockTokens.s.sol`, then `Genesis.s.sol`, all signed by the deployer while it is still the owner; only then does the owner wallet call `acceptOwnership()` on the six owned contracts (`Factory`, `AnchorRegistry`, `BuybackVault`, `CoinQuoteLauncher`, `StockQuoteLauncher`, `MarketQuoteLauncher`). Genesis opens launches and removes the deployer's own pass. Start `getLogs` from `startBlock`. The owner is the deployer key unless `OWNER` was set, in which case ownership of `Factory`, `AnchorRegistry`, `BuybackVault`, `CoinQuoteLauncher`, `StockQuoteLauncher` and `MarketQuoteLauncher` is offered to it (`TickerLauncher` has no owner) and must be accepted with `acceptOwnership()` on each.

## The v2 official coin

| | |
|---|---|
| HOLY | `0x49f39Ce9bEBC9047DF7266B55D98e46c84526942` |
| COW, the name it is priced in | `0xF3b977f5b0c3F03eb265D1b26BF0F8961c1bE4f7` |
| HOLY/COW pool id | `0xaf7ab01a4776a95c24e38f4935a1f7d0b9687adb1c57c81ff7a4e84a58e988ef` |

COW is a fixed-inventory name, made by the `MarketTickerLauncher` above in the same transaction as HOLY.
