# 15 · Launching from code

Robinhood Chain, chain id 4663, RPC `https://rpc.mainnet.chain.robinhood.com`, explorer `https://robinhoodchain.blockscout.com`. Addresses are in [07 addresses](./07-addresses.md) and in the deployment record.

## The pinned preview

Pin the opening economics with `expectedEconomics` so a change between your preview and your transaction reverts instead of launching at terms you did not see.

```ts
import { parseEther, zeroAddress } from "viem";
const expectedEconomics = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "previewLaunchEconomics", args: [0n, zeroAddress] });
const launchFee = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "launchFee" });
const params = {
  name: "Example", symbol: "EXMPL", logo: "ipfs://bafk...", description: "What this is.",
  socials: { twitter: "https://x.com/example", telegram: "", discord: "", website: "", farcaster: "" },
  creatorFeeRecipient: zeroAddress, // zero = the launching wallet
  creatorTaxBps: 0,                 // 0..200
  buybackEnabled: false,
  expectedEconomics,
  salt: randomBytes32,              // fresh every attempt; the site grinds it so the address ends in 6942
};
// launch and a 0.1 ETH dev buy, in one transaction. returns (token, poolId, tokensOut)
await wallet.writeContract({ address: ROUTER, abi: routerAbi, functionName: "launchAndBuy", args: [params, 0n, zeroAddress, parseEther("0.1"), minTokensOut, account.address], value: launchFee + parseEther("0.1") });
// without a dev buy: Factory.launchToken(params, 0, pairToken) with value = launchFee. returns (token, poolId)
```

## Each quote asset

- **ETH.** As above. The dev buy rides in `value` on top of the launch fee.
- **USDG.** Approve the router for the dev buy amount and send `launchFee` as value.
- **A Stock Token.** `StockQuoteLauncher.previewLaunch(0, stock)` gives `expectedEconomics`, then `launchWithStockQuote(params, 0, stock)` or `launchWithStockQuoteAndBuy(params, 0, stock, stockIn, minTokensOut)`.
- **A tickr coin.** The same on `CoinQuoteLauncher`: `launchWithCoinQuote` and `launchWithCoinQuoteAndBuy`.
- **Any token with a market.** `MarketQuoteLauncher.previewLaunch(0, token)` gives `expectedEconomics`, then `launchWithMarketQuote(params, 0, token)` or `launchWithMarketQuoteAndBuy(params, 0, token, tokenIn, minTokensOut)`. See [19](./19-market-quotes.md) for what counts as a market.
- **An invented ticker.** `TickerLauncher.previewLaunch(symbol, 0)` gives the hash, then `launch(symbol, params, 0)` or `launchAndBuy(symbol, params, 0, usdgIn, minTokensOut)`. A new ticker costs `launchFee + NEW_TICKER_FEE()` as value, an existing one `launchFee`.

## Knowing the address first

The token address is known before the launch: `LaunchDeployer.predictToken(initiator, params, supply)`. The pool key follows from the address, so the pool id is known too. Before sending, simulate: every revert is a named error, listed in [18 events and errors](./18-events-and-errors.md).

## Metadata

Limits, enforced by `LaunchDeployer`: name 64 bytes, symbol 16, logo 8,192, description 2,048, each social link 256. Name and symbol cannot be empty. `logo` is a string stored on the coin. The site pins images to IPFS and stores `ipfs://...`; a plain `https://` link works too. Socials are stored as full links. None of it can be changed after launch.
