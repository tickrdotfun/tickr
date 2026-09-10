import type { Abi } from "viem";
import * as Abis from "@/lib/abis";

/**
 * Every custom error the site can put a name to.
 *
 * Our own contracts come from their ABIs. The rest are errors raised *below* us, by Uniswap, which never appear
 * in any ABI we generate and would otherwise reach a user as a bare four-byte selector. They are listed by hand
 * because a route runs through Uniswap's pools, so Uniswap's failures are the ones a trader actually meets.
 *
 * `PriceLimitAlreadyExceeded` is the one that matters most here. A fixed-inventory market that has been bought
 * out leaves its pool price parked on the bound, and v4 rejects the next swap with this before the pool's own
 * accounting is reached. Without this entry the site shows 0x7c9c6e8f.
 */
export const KNOWN_ERRORS: Abi = [
  ...Object.values(Abis).flatMap((a) => (Array.isArray(a) ? (a as Abi).filter((x) => x.type === "error") : [])),

  // uniswap v4 core
  { type: "error", name: "PriceLimitAlreadyExceeded", inputs: [{ type: "uint160" }, { type: "uint160" }] },
  { type: "error", name: "PriceLimitOutOfBounds", inputs: [{ type: "uint160" }] },
  { type: "error", name: "SwapAmountCannotBeZero", inputs: [] },
  { type: "error", name: "PoolNotInitialized", inputs: [] },
  { type: "error", name: "PoolAlreadyInitialized", inputs: [] },
  { type: "error", name: "CurrencyNotSettled", inputs: [] },
  { type: "error", name: "ManagerLocked", inputs: [] },
  { type: "error", name: "WrappedError", inputs: [{ type: "address" }, { type: "bytes4" }, { type: "bytes" }, { type: "bytes" }] },

  // uniswap periphery, seen on router-built routes
  { type: "error", name: "V4TooLittleReceived", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "V4TooMuchRequested", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "TransactionDeadlinePassed", inputs: [] },

  // ours, raised outside an ABI we generate
  { type: "error", name: "PoolAlreadyExists", inputs: [] },
];
