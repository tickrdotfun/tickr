# golden activation calldata

`golden.json` holds what `encodeBuy` in `src/lib/activation.ts` produces for the fixed inputs in `golden.cjs` (the fixture wallet, coin and ticker; the funding pool ETH/USDG fee 100 spacing 1; the name's pool fee 500 spacing 1 behind the managed hook; the coin's pool fee 10000 spacing 10; the name purchase 0.0005 ETH with minimum 1229777; the coin purchase 0.001 ETH with minimum 664767222266720916779239; deadline 1800000000). The same bytes are the hex literals in `contracts/test/UniversalRouterBuy.t.sol`, which compares the script encoder against them.

- `node scripts/tests/golden.cjs` checks the encoder, `golden.json` and the Solidity test agree; `activation.test.cjs` runs the same check.
- `node scripts/tests/golden.cjs --write` regenerates `golden.json` and rewrites the Solidity hex after a reviewed encoder change; then `forge test --match-contract UniversalRouterBuyTest`.
