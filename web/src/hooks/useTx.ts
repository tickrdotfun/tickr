"use client";

import { useCallback, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { Hash } from "viem";
import { errorMessage } from "@/lib/format";
import { DEMO } from "@/lib/demoTransport";
import { ADDRESSES } from "@/lib/addresses";
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

export function useTx() {
  const { writeContractAsync } = useWriteContract();
  const { connector } = useAccount();
  const client = usePublicClient();
  const [status, setStatus] = useState<TxStatus>("idle");
  const [hash, setHash] = useState<Hash | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [step, setStep] = useState<string | undefined>();

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
            const rc = await client.waitForTransactionReceipt({ hash: h });
            if (rc.status !== "success") throw new Error(`${s.label}: transaction reverted`);
          }
        }
        setStatus("success");
        setStep(undefined);
        return last;
      } catch (e) {
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

  return { run, status, hash, error, step, reset, busy: status === "signing" || status === "confirming" };
}
