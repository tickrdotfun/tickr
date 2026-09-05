import { createPublicClient, http } from "viem";
import { robinhoodChain } from "./chain";

/** A read-only client for route handlers. Same chain and RPC as the browser, no wallet. */
/**
 * Reads are made one JSON-RPC call at a time. Cloudflare Workers reuse a connection across requests and the
 * chain's public node answers a batched array with a single error for the whole batch, so batching costs more
 * than it saves here; viem still groups contract reads through multicall3, which is one call anyway.
 */
export const serverClient = createPublicClient({ chain: robinhoodChain, transport: http() });
