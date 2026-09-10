import { defineChain } from "viem";

const multicall3 = process.env.NEXT_PUBLIC_MULTICALL3;

/**
 * 4663 is Robinhood Chain. A private devnet runs under its own id so no wallet can mistake it for the public
 * network and route a transaction there; wallets know 4663 and would.
 */
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 4663);
export const IS_DEVNET = CHAIN_ID !== 4663;
/** The dress rehearsal runs the same contracts on Sepolia; wallets know that chain and its explorer differs. */
export const IS_SEPOLIA = CHAIN_ID === 11155111;

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: IS_SEPOLIA ? "Sepolia" : IS_DEVNET ? "tickr devnet" : "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    // the node named for this build, or the chain's public one. how the browser actually splits its reads between
    // the site's endpoint and this node is in transport.ts
    default: { http: [process.env.NEXT_PUBLIC_RPC_URL && process.env.NEXT_PUBLIC_RPC_URL !== "/api/rpc" ? process.env.NEXT_PUBLIC_RPC_URL : "https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: IS_SEPOLIA ? "https://eth-sepolia.blockscout.com" : "https://robinhoodchain.blockscout.com" },
  },
  // Multicall3 at the canonical address is used for read batching when present.
  // Set NEXT_PUBLIC_MULTICALL3=none to force per-call reads.
  contracts:
    multicall3 === "none"
      ? undefined
      : {
          multicall3: {
            address: (multicall3 ?? "0xcA11bde05977b3631167028862bE2a173976CA11") as `0x${string}`,
          },
        },
});

export const EXPLORER = IS_SEPOLIA ? "https://eth-sepolia.blockscout.com" : "https://robinhoodchain.blockscout.com";
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`;
export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`;
export const explorerToken = (a: string) => `${EXPLORER}/token/${a}`;
