"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useChainId, usePublicClient, useWalletClient } from "wagmi";
import { parseAbi, type Address, type Hash, type Hex } from "viem";
import { ADDRESSES, isZero } from "@/lib/addresses";
import { isReadUnavailable, readBounded } from "@/lib/readRpc";
import type { V4Key } from "@/lib/route";
import { AMOUNTS, PHASES, QUOTER_ABI, ledgerKey, maximumCost, poolsFor, reviewExpired, type Ledger, type Phase, type Pools, type Request, type Review } from "@/lib/activation";
import { MARKET_DEPLOYER_ABI } from "@/lib/nameKind";
import { useNameKind } from "@/hooks/useNameKind";
import { createActivationFlow, isRejection, type ActivationFlow, type Inspection, type Reads, type WalletProvider } from "@/lib/activationFlow";
import { DEMO } from "@/lib/demoTransport";

const COIN_ABI = parseAbi([
  "function remainingBuy(address) view returns (uint256)",
  "function remainingHold(address) view returns (uint256)",
  "function currentSnipeTaxBps(address) view returns (uint256)",
]);
const WRAPPER_ABI = parseAbi(["function poolKey() view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))"]);
const FACTORY_ABI = parseAbi(["function poolKeyOf(address) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))"]);

/** What the site needs to know about a launch to activate it. */
export type ActivationTarget = { token: Address; ticker: Address; own: V4Key };

const notFound = (e: unknown) => /not be found|NotFound|could not be found/i.test(String(e));

/**
 * One coin's activation for the connected wallet: the workflow engine in `lib/activationFlow.ts`, wired to the
 * chain, the wallet, this browser's storage and its lock manager. Every read is bounded; the engine keeps the rules.
 */
export function useActivation(t?: ActivationTarget) {
  const client = usePublicClient();
  const chainId = useChainId();
  const { address: user, connector } = useAccount();
  const wallet = useWalletClient();
  // everything read or reviewed is stamped with the wallet, chain and coin it was read for: another identity's
  // results are never shown for this one, so a read that fails after a wallet change cannot leave a stale "done"
  const identity = t && user ? `${chainId}:${user.toLowerCase()}:${t.token.toLowerCase()}` : "";
  const [state, setState] = useState<{ id: string; ledger: Ledger | null; inspection: Inspection | null; review: Review | null }>({ id: "", ledger: null, inspection: null, review: null });
  const ledger = state.id === identity ? state.ledger : null;
  const inspection = state.id === identity ? state.inspection : null;
  const review = state.id === identity ? state.review : null;
  const setLedger = useCallback((l: Ledger | null) => setState((x) => ({ ...(x.id === identity ? x : { id: identity, ledger: null, inspection: null, review: null }), id: identity, ledger: l })), [identity]);
  const setInspection = useCallback((i: Inspection | null) => setState((x) => ({ ...(x.id === identity ? x : { id: identity, ledger: null, inspection: null, review: null }), id: identity, inspection: i })), [identity]);
  const setReview = useCallback(
    (r: Review | null | ((prev: Review | null) => Review | null)) =>
      setState((x) => {
        const base = x.id === identity ? x : { id: identity, ledger: null, inspection: null, review: null };
        return { ...base, id: identity, review: typeof r === "function" ? r(base.review) : r };
      }),
    [identity],
  );
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [readsDown, setReadsDown] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const inFlight = useRef(false);
  // what kind of name this is, read from the issuers, through the one hook that answers that question. Until it
  // is known nothing is prepared: a market name treated as a wrapper would be routed through a mint that does
  // not exist, and the reverse would look for a pool that is not there
  const name = useNameKind(t?.ticker);
  const spec = name.spec;
  const nameError = name.error;

  // the managed hook is only needed by a name that trades behind it. A market name does not, and requiring it
  // would have made every market name unactivatable on a site that never wires one
  const ready =
    !!client && !!t && !!user && !!wallet.data && !!connector && !!spec &&
    !isZero(ADDRESSES.universalRouter) && !isZero(ADDRESSES.v4Quoter) &&
    (spec.kind === "market" || !isZero(ADDRESSES.managedTickerHook)) && !DEMO;
  const pools = useMemo((): Pools | undefined => (t && spec ? poolsFor(t.ticker, t.own, spec) : undefined), [t, spec]);

  const flow = useMemo((): ActivationFlow | undefined => {
    if (!ready || !client || !t || !user || !pools || !spec || !wallet.data || !connector) return undefined;
    const c = client;
    const kind = spec.kind;
    const w = wallet.data;
    const reads: Reads = {
      chainId: () => readBounded(() => c.getChainId()),
      blockNumber: () => readBounded(() => c.getBlockNumber()),
      block: (n) => readBounded(async () => {
        const b = n === undefined ? await c.getBlock() : await c.getBlock({ blockNumber: n });
        return { hash: b.hash as Hash, number: b.number, timestamp: b.timestamp };
      }),
      transaction: (h) => readBounded(() => c.getTransaction({ hash: h }).then((x) => ({ hash: x.hash, from: x.from, to: x.to, input: x.input, nonce: x.nonce, value: x.value, chainId: x.chainId, gas: x.gas, maxFeePerGas: x.maxFeePerGas, blockHash: x.blockHash, blockNumber: x.blockNumber })).catch((e) => (notFound(e) ? null : Promise.reject(e)))),
      receipt: (h) => readBounded(() => c.getTransactionReceipt({ hash: h }).then((x) => ({ transactionHash: x.transactionHash, blockHash: x.blockHash, blockNumber: x.blockNumber, status: x.status, gasUsed: x.gasUsed, effectiveGasPrice: x.effectiveGasPrice, logs: x.logs as { address: Address; topics: Hex[]; data: Hex }[] })).catch((e) => (notFound(e) ? null : Promise.reject(e)))),
      code: (a) => readBounded(() => c.getCode({ address: a })),
      nonce: (a, tag) => readBounded(() => c.getTransactionCount({ address: a, blockTag: tag })).then((n) => BigInt(n)),
      balance: (a) => readBounded(() => c.getBalance({ address: a })),
      coinPoolKey: (coin) => readBounded(() => c.readContract({ abi: FACTORY_ABI, address: ADDRESSES.factory, functionName: "poolKeyOf", args: [coin] })).then((k) => ({ ...k, fee: Number(k.fee), tickSpacing: Number(k.tickSpacing) })),
      // a wrapper knows its own pool; a market's pool is the issuer's, worked out from the name. Reading the
      // wrong one of these gives a plausible key for the wrong pool, so it follows the kind and nothing else
      namePoolKey: (name) =>
        readBounded(() =>
          kind === "market"
            ? c.readContract({ abi: MARKET_DEPLOYER_ABI, address: ADDRESSES.marketTickerDeployer, functionName: "keyFor", args: [name] })
            : c.readContract({ abi: WRAPPER_ABI, address: name, functionName: "poolKey" }),
        ).then((k) => ({ ...(k as V4Key), fee: Number((k as V4Key).fee), tickSpacing: Number((k as V4Key).tickSpacing) })),
      restrictions: async (coin, who) => {
        const [tax, buy, hold] = await Promise.all([
          readBounded(() => c.readContract({ abi: COIN_ABI, address: coin, functionName: "currentSnipeTaxBps", args: [who] })),
          readBounded(() => c.readContract({ abi: COIN_ABI, address: coin, functionName: "remainingBuy", args: [who] })),
          readBounded(() => c.readContract({ abi: COIN_ABI, address: coin, functionName: "remainingHold", args: [who] })),
        ]);
        return { tax, buy, hold };
      },
      quote: (path, amount) => readBounded(async () => {
        const { result } = await c.simulateContract({ abi: QUOTER_ABI, address: ADDRESSES.v4Quoter, functionName: "quoteExactInput", args: [{ exactCurrency: "0x0000000000000000000000000000000000000000", path, exactAmount: amount }] });
        return result[0];
      }),
      estimateGas: (q) => readBounded(() => c.estimateGas({ account: q.from, to: q.to, data: q.data, value: q.value })),
      gasPrice: () => readBounded(() => c.getGasPrice()),
      call: (q) => readBounded(() => c.call({ account: q.from, to: q.to, data: q.data, value: q.value, gas: q.gas })).then((x) => x.data),
    };
    const provider: WalletProvider = {
      accounts: async () => {
        const p = (await connector.getProvider()) as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
        return (await p.request({ method: "eth_accounts" })) as string[];
      },
      chainId: async () => {
        const p = (await connector.getProvider()) as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
        return Number(BigInt((await p.request({ method: "eth_chainId" })) as string));
      },
      send: (q: Request) =>
        w.sendTransaction({
          account: user,
          to: q.to,
          data: q.data,
          value: BigInt(q.value),
          gas: BigInt(q.gas),
          nonce: Number(BigInt(q.nonce)),
          maxFeePerGas: BigInt(q.maxFeePerGas),
          maxPriorityFeePerGas: 0n,
          chain: w.chain,
        }),
    };
    const storage = (() => {
      try {
        const s = window.localStorage;
        s.getItem("tickr.activation.probe");
        return s;
      } catch {
        return undefined;
      }
    })();
    if (!storage) return undefined;
    const locks = typeof navigator !== "undefined" && navigator.locks ? { request: <T,>(name: string, fn: () => Promise<T>) => navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error("another tab is activating with this wallet. finish there, or close it without clearing its records.");
      return fn();
    }) as Promise<T> } : undefined;
    return createActivationFlow({ chainId, wallet: user, coin: t.token, ticker: t.ticker, pools, router: ADDRESSES.universalRouter, storage, reads, provider, locks });
  }, [ready, client, t, user, pools, spec, wallet.data, connector, chainId]);

  const fail = useCallback(
    (e: unknown) => {
      setReadsDown(isReadUnavailable(e));
      setError(e instanceof Error ? e.message : String(e));
      setReview(null);
    },
    [setReview],
  );

  /**
   * Whether a review still describes the transaction it was prepared for.
   *
   * It stops describing it when it expires, when the step it was for is no longer the step to make, or when an
   * attempt has been recorded since. Anything else a background read turns up leaves it alone: reading is not a
   * reason to throw away terms somebody is in the middle of reading.
   */
  const stillValid = useCallback((v: Review, l: Ledger, s: Inspection) => {
    if (reviewExpired(v)) return false;
    if (s.next !== PHASES.indexOf(v.phase)) return false;
    if (l.attempts.length !== PHASES.indexOf(v.phase)) return false;
    if (s.blocked || s.pending) return false;
    return true;
  }, []);

  const refresh = useCallback(async () => {
    if (!flow || inFlight.current) return;
    setBusy("checking saved receipts, no spending");
    setError("");
    // the review is not cleared up front. A refresh runs on a timer, and clearing it here took the terms off
    // the screen while somebody was reading them, every time the timer came round
    try {
      const { ledger: l, inspection: s } = await flow.refresh();
      setLedger(l);
      setInspection(s);
      setReview((v) => (v && stillValid(v, l, s) ? v : null));
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  }, [flow, fail, setInspection, setLedger, setReview, stillValid]);

  // the journal on mount and whenever the wallet, chain or launch changes; another tab's write reloads it
  useEffect(() => {
    if (!flow) return;
    const first = setTimeout(() => void refresh(), 0);
    const changed = (e: StorageEvent) => {
      if (t && user && (e.key === null || e.key === ledgerKey(chainId, user, t.token))) void refresh();
    };
    window.addEventListener("storage", changed);
    return () => {
      clearTimeout(first);
      window.removeEventListener("storage", changed);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  // a pending attempt is re-read on a timer, reads only
  useEffect(() => {
    if (busy || !inspection?.pending || inspection.unknown) return;
    const timer = setTimeout(() => void refresh(), 6_000);
    return () => clearTimeout(timer);
  }, [busy, inspection, refresh]);

  const prepare = useCallback(
    async (phase: Phase) => {
      if (inFlight.current) return;
      // a silent return here is what a dead button looks like from outside. The flow goes missing when a read
      // is unavailable, which is a state worth saying out loud rather than one to swallow
      if (!flow) {
        setError(
          nameError
            ? `the name could not be identified, so nothing can be prepared. ${nameError}`
            : "the page cannot reach the chain right now, so nothing can be prepared. reads are retried; nothing is sent.",
        );
        return;
      }
      setBusy(phase === "quote" ? "checking the chain, a fresh quote and fees for the name purchase" : "rechecking the name purchase, then a fresh quote and fees for the coin purchase");
      setError("");
      setReview(null);
      try {
        setReview(await flow.prepare(phase));
        setLedger(flow.load());
      } catch (e) {
        fail(e);
      } finally {
        setBusy("");
      }
    },
    [flow, fail, setLedger, setReview, nameError],
  );

  const send = useCallback(async () => {
    if (!flow || !review || inFlight.current) return;
    inFlight.current = true;
    setBusy("rechecking, then waiting for your wallet");
    setError("");
    try {
      const saved = await flow.send(review);
      setLedger(saved);
      setReview(null);
      const s = await flow.inspect(saved);
      setInspection(s);
      if (s.confirmed) setCelebrate(true);
    } catch (e) {
      // the record is what it is after the wallet: reload it, whatever the outcome
      try {
        setLedger(flow.load());
      } catch {
        // storage unreadable: the error below says so
      }
      fail(e);
      if (!isRejection(e)) void refresh();
    } finally {
      inFlight.current = false;
      setBusy("");
    }
  }, [flow, review, fail, refresh, setInspection, setLedger, setReview]);

  const recover = useCallback(
    async (input: string) => {
      if (!flow || inFlight.current) return;
      setBusy("matching the transaction hash, no spending");
      setError("");
      try {
        const saved = await flow.recover(input);
        setLedger(saved);
        setInspection(await flow.inspect(saved));
      } catch (e) {
        fail(e);
      } finally {
        setBusy("");
      }
    },
    [flow, fail, setInspection, setLedger],
  );

  // stages are labelled only from verified inspection; without one they are unknown, never "confirmed"
  const next = inspection?.next ?? 0;
  const phase: Phase = next === 0 ? "quote" : "coin";
  const attempts = ledger?.attempts.length ?? 0;
  const unknown = inspection?.unknown === true || (!!ledger?.attempts.at(-1) && !ledger.attempts.at(-1)!.hash);
  const unverified = !inspection || attempts > inspection.next;
  const done = inspection?.confirmed === true;
  const stageStatus = (i: number): string => {
    const rec = inspection?.records[i];
    if (rec) return rec.status;
    return ledger?.attempts[i] ? "unknown" : "not started";
  };

  return {
    ready,
    /** What the name turned out to be, once it is known; undefined while it is still being read. */
    nameKind: spec?.kind,
    /** Why activation cannot start, when the name could not be classified. Never a reason to carry on anyway. */
    nameError,
    ledger,
    inspection,
    review,
    busy,
    error,
    readsDown,
    next,
    phase,
    unverified,
    unknown,
    done,
    celebrate,
    amounts: AMOUNTS,
    prepare,
    send,
    refresh,
    recover,
    stageStatus,
    expired: !!review && reviewExpired(review),
    cost: (v: Review) => maximumCost(v.request),
  };
}

export type { Ledger, Review };
