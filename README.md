# tickr

a memecoin launchpad on Robinhood Chain (chain id 4663). one transaction puts a coin's whole supply into a Uniswap v4 pool that is locked from the first block, priced in ETH, USDG, a Robinhood Stock Token, a coin launched here, or a name the creator invents. the pool's fee is the only fee: the quote side is split between the creator and the protocol, the coin side burns.

> independent, immutable contracts, independently deployed. tickr is not affiliated with Robinhood. source: https://github.com/tickrdotfun/tickr

## layout

| path | what |
| --- | --- |
| `contracts/` | Foundry. `src/` the contracts, `script/` deploy and genesis, `test/` the suite and the fork tests |
| `docs/` | the spec and every page the site renders under /docs |
| `web/` | the Next.js site, the server routes and the docs renderer |
| `local.sh` | a fork of Robinhood Chain with the whole stack deployed and seeded, and the site on :3000 |
| `devnet.sh` | the same on a plain anvil with local stand-ins for the chain's own pieces |

## run

```sh
cd contracts && forge test
FORK=1 forge test --match-path test/fork/RobinhoodFork.t.sol --fork-url https://rpc.mainnet.chain.robinhood.com
cd web && pnpm install && pnpm dev
```

## how a launch works

`Factory._launch` checks the gate, the fee, the reserved names and the pinned economics, deploys the coin with CREATE2 (`LaunchDeployer`), opens a hookless Uniswap v4 pool at the opening price and has `LaunchSeeder` mint one position holding the entire supply, owned by `LaunchLocker`, which has no withdraw. `LaunchLocker.collectFees` is permissionless: the quote side goes to `FeeEscrow` for the creator and the protocol (and the ticker club under an invented name), the coin side is burned. Read `docs/SPEC.md` first, then `docs/02-lifecycle.md` and `docs/06-fees.md`.

## licence

MIT.
