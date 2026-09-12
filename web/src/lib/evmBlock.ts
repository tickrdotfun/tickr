import { robinhoodChain } from "@/lib/chain";

/**
 * Two block numbers, and which one a contract means.
 *
 * Robinhood Chain is an Arbitrum chain. Inside its EVM, `block.number` is the parent chain's (Ethereum's) block
 * number, about twelve seconds a block; the chain's own height, which the RPC reports and `useBlockNumber` returns,
 * is a different and much larger number. A coin records its launch in the first: `launchedBlock` and
 * `protectionEndsAtBlock` are EVM block numbers. Compared against the RPC height, a coin's protection reads as over
 * the moment it opens.
 *
 * So anything compared with a number a contract recorded asks the EVM for its block number, through Multicall3's
 * `getBlockNumber()`, which returns `block.number` as a call sees it. Receipts, log ranges and confirmation depth
 * stay on the RPC height, which is what they are in.
 */
export const EVM_BLOCK_SOURCE = robinhoodChain.contracts?.multicall3?.address;

export const MULTICALL3_BLOCK_ABI = [{ type: "function", name: "getBlockNumber", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;

/** Whether a coin's launch protection still holds, from the EVM's block number and the coin's own end block. */
export function protectionOn(evmBlock: bigint | undefined, endsAt: bigint | undefined): boolean {
  return evmBlock !== undefined && endsAt !== undefined && evmBlock < endsAt;
}
