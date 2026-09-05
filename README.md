# tickr

a memecoin launchpad on Robinhood Chain (chain id 4663). one transaction puts a coin's whole supply into a Uniswap v4 pool that is locked from the first block, priced in ETH, USDG, a Robinhood Stock Token, a coin launched here, or a name the creator invents. the pool's fee is the only fee: both sides are split between the creator and the protocol; the protocol's share of the coin side burns, and half of its quote share buys and burns the official coin. a buy in a coin's first five seconds pays a snipe tax that starts at 99% and is gone by the fifth second.

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

`Factory._launch` checks the gate, the fee, the reserved names and the pinned economics, deploys the coin with CREATE2 (`LaunchDeployer`), opens a hookless Uniswap v4 pool at the opening price and has `LaunchSeeder` mint one position holding the entire supply, owned by `LaunchLocker`, which has no withdraw. `LaunchLocker.collectFees` is permissionless: the quote side goes to `FeeEscrow` for the creator and the protocol (and the ticker club under an invented name); the coin side splits the same way, the creator's share to the escrow and the rest burned. The protocol's recipient is `BuybackTreasury`, which pays the team half and buys and burns TICKR with the rest; `Token` taxes buys in its first five seconds. Read `docs/SPEC.md` first, then `docs/02-lifecycle.md` and `docs/06-fees.md`.

## licence

MIT.
