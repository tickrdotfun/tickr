"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { decodeErrorResult, type Abi, type Hash, type Hex } from "viem";
import { errorMessage } from "@/lib/format";
import { DEMO } from "@/lib/demoTransport";
import { ADDRESSES } from "@/lib/addresses";
import * as Abis from "@/lib/abis";
import type { wagmiConfig } from "@/lib/wagmi";

export type TxStatus = "idle" | "signing" | "confirming" | "success" | "error";
export type WriteFn = ReturnType<typeof useWriteContract<typeof wagmiConfig>>["writeContractAsync"];
export type TxStep = { label: string; request: (write: WriteFn) => Promise<Hash> };

/**
 * Imperative multi-step transaction runner (e.g. approve then buy).
 * Each step submits one transaction; we wait for its receipt before the next.
 */
/**
 * The site simulates and reads through its own RPC, but the wallet sends through whatever RPC it has for chain
 * 4663, and a wallet's built-in "Robinhood Chain" is the public network. On a private chain with the same id
 * that would send real value to an address with no code. So before anything is signed, the wallet's own
 * connection is asked whether the factory exists there; if it does not, nothing is sent.
 */
async function walletSeesFactory(getProvider: () => Promise<unknown>): Promise<boolean> {
  try {
    const provider = (await getProvider()) as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
    const code = (await provider.request({ method: "eth_getCode", params: [ADDRESSES.factory, "latest"] })) as string | undefined;
    return !!code && code !== "0x";
  } catch {
    return false; // a wallet that cannot answer gets nothing to sign: the check exists to stop a wrong network
  }
}

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

/** Every custom error our contracts declare, plus the two that mean a pool key was taken first. */
export const KNOWN_ERRORS: Abi = [
  ...Object.values(Abis).flatMap((a) => (Array.isArray(a) ? (a as Abi).filter((x) => x.type === "error") : [])),
  { type: "error", name: "PoolAlreadyExists", inputs: [] },
  { type: "error", name: "PoolAlreadyInitialized", inputs: [] },
];

/** The revert data inside a viem error, wherever it nests it. */
function revertData(e: unknown): Hex | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur && typeof cur === "object"; i++) {
    const o = cur as { data?: unknown; raw?: unknown; cause?: unknown };
    for (const v of [o.data, o.raw]) {
      if (typeof v === "string" && v.startsWith("0x") && v.length >= 10) return v as Hex;
      const inner = v && typeof v === "object" ? (v as { data?: unknown }).data : undefined;
      if (typeof inner === "string" && inner.startsWith("0x") && inner.length >= 10) return inner as Hex;
    }
    cur = o.cause;
  }
  return undefined;
}

/**
 * A receipt says only that a transaction reverted, never why. Replaying the same call against the block it
 * landed in reproduces the revert with its data, so a named error (a pool key taken between the simulation and
 * the block, say) is recognised by name and can be acted on, instead of read as a plain "reverted".
 */
async function minedRevert(client: Client, hash: Hash, blockNumber: bigint, label: string): Promise<Error> {
  try {
    const t = await client.getTransaction({ hash });
    await client.call({ account: t.from, to: t.to ?? undefined, data: t.input, value: t.value, blockNumber });
  } catch (e) {
    const data = revertData(e);
    if (data) {
      let name = data.slice(0, 10);
      try {
        name = decodeErrorResult({ abi: KNOWN_ERRORS, data }).errorName;
      } catch {
        // not one of ours: the selector is still better than nothing
      }
      return new Error(`${label}: reverted with ${name}`);
    }
  }
  return new Error(`${label}: transaction reverted`);
}

export function useTx() {
  const { writeContractAsync } = useWriteContract();
  const { connector } = useAccount();
  const client = usePublicClient();
  const [status, setStatus] = useState<TxStatus>("idle");
  const [hash, setHash] = useState<Hash | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [step, setStep] = useState<string | undefined>();
  // the failure behind the last undefined result, for callers that want to react to a specific revert
  const lastError = useRef<unknown>(undefined);

  const run = useCallback(
    async (steps: TxStep[]): Promise<Hash | undefined> => {
      setError(undefined);
      setHash(undefined);
      // A preview build has no chain behind it. Reads are replayed from a fixture, but a write goes through the
      // connected wallet, not through that transport: it would be broadcast to the real chain 4663, where these
      // addresses have no code, and the value sent with it would be gone. So writes stop here, before signing.
      if (DEMO) {
        setStatus("error");
        setError("This is a preview. Nothing here is live and no transaction can be sent.");
        return undefined;
      }
      try {
        if (connector && !(await walletSeesFactory(() => connector.getProvider()))) {
          const rpc = process.env.NEXT_PUBLIC_RPC_URL || "the RPC this site uses";
          throw new Error(
            `your wallet could not confirm tickr's contracts on its own connection to chain 4663, so nothing was signed. check the wallet's network for chain 4663, then try again. it has chain id 4663 but a different network, so nothing was sent. point the wallet's Robinhood Chain RPC at ${rpc} and try again.`,
          );
        }
        let last: Hash | undefined;
        for (const s of steps) {
          setStep(s.label);
          setStatus("signing");
          const h = await s.request(writeContractAsync);
          last = h;
          setHash(h);
          setStatus("confirming");
          if (client) {
            // a wallet can replace a pending transaction. sped up, it is the same action under a new hash; cancelled
            // or replaced by something else, the action never happened although a transaction did mine with `success`
            let replaced: { reason: string; hash: Hash } | undefined;
            const rc = await client.waitForTransactionReceipt({
              hash: h,
              onReplaced: (r) => {
                replaced = { reason: r.reason, hash: r.transaction.hash };
              },
            });
            if (replaced) {
              if (replaced.reason !== "repriced") throw new Error(`${s.label}: ${replaced.reason === "cancelled" ? "cancelled in the wallet" : "replaced in the wallet by another transaction"}. nothing was sent.`);
              last = replaced.hash;
              setHash(replaced.hash);
            }
            if (rc.status !== "success") throw await minedRevert(client, rc.transactionHash, rc.blockNumber, s.label);
          }
        }
        setStatus("success");
        setStep(undefined);
        return last;
      } catch (e) {
        lastError.current = e;
        setStatus("error");
        setError(errorMessage(e));
        setStep(undefined);
        return undefined;
      }
    },
    [writeContractAsync, client, connector],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(undefined);
    setHash(undefined);
    setStep(undefined);
  }, []);

  return { run, status, hash, error, step, reset, lastError, busy: status === "signing" || status === "confirming" };
}
