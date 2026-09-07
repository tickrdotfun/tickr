"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useChainId, usePublicClient, useWalletClient } from "wagmi";
import { parseAbi, type Address, type Hash, type Hex } from "viem";
import { ADDRESSES, isZero } from "@/lib/addresses";
import { isReadUnavailable, readBounded } from "@/lib/readRpc";
import type { V4Key } from "@/lib/route";
import {
  AMOUNTS,
  DEADLINE_SECONDS,
  MAX256,
  PHASES,
  QUOTER_ABI,
  check,
  encodeBuy,
  fingerprint,
  hex,
  isHash,
  json,
  ledgerKey,
  loadLedger,
  lockName,
  matchIdentity,
  maximumCost,
  minimumOutput,
  paddedGas,
  permissionCeiling,
  poolId,
  poolsFor,
  reviewExpired,
  routeFor,
  same,
  saveLedger,
  validateLedger,
  validateReview,
  verifyTradeLogs,
  type Attempt,
  type Ledger,
  type Phase,
  type Pools,
  type Review,
} from "@/lib/activation";
import { DEMO } from "@/lib/demoTransport";

const COIN_ABI = parseAbi([
  "function remainingBuy(address) view returns (uint256)",
  "function remainingHold(address) view returns (uint256)",
  "function currentSnipeTaxBps(address) view returns (uint256)",
  "function protectionEndsAtBlock() view returns (uint256)",
]);
const WRAPPER_ABI = parseAbi(["function poolKey() view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))"]);
const FACTORY_ABI = parseAbi(["function poolKeyOf(address) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))"]);

/** What the site needs to know about a launch to activate it. */
export type ActivationTarget = { token: Address; ticker: Address; own: V4Key };

/** One attempt as the chain shows it now. */
export type Record = { phase: Phase; hash?: Hash; status: "no hash" | "waiting" | "pending" | "confirming" | "confirmed" | "stopped"; cost: bigint; received: bigint; blockNumber?: bigint; note?: string };

export type Inspection = {
  /** how many phases are confirmed in order: 0, 1 or 2 */
  next: number;
  confirmed: boolean;
  pending: boolean;
  /** a reason nothing more may be sent until a person looks; empty when clear */
  blocked: string;
  cost: bigint;
  records: Record[];
  /** an attempt whose hash was never saved: its outcome is unknown until reconciled */
  unknown: boolean;
};

export type Phase2 = Phase;

/**
 * One coin's activation for the connected wallet, kept in this browser's journal and verified against the chain.
 *
 * Nothing is ever sent twice: an attempt is written before the wallet opens, its hash the moment the wallet returns
 * it, and an attempt whose hash is missing blocks everything until it is reconciled by hand. One wallet signs one
 * step at a time across every tab, through the browser's lock. Every step is prepared with a fresh positive
 * minimum from the canonical quoter and sent with explicit fees, gas and nonce; a read that fails stops the step,
 * it never lowers the protection. Confirmation is the canonical receipt plus the swaps and the delivery it shows.
 */
export function useActivation(t?: ActivationTarget) {
  const client = usePublicClient();
  const chainId = useChainId();
  const { address: user, connector } = useAccount();
  const wallet = useWalletClient();
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [readsDown, setReadsDown] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const inFlight = useRef(false);
  const ready = !!client && !!t && !!user && !isZero(ADDRESSES.universalRouter) && !isZero(ADDRESSES.v4Quoter) && !isZero(ADDRESSES.managedTickerHook) && !DEMO;

  const pools = useMemo((): Pools | undefined => (t ? poolsFor(t.ticker, t.own) : undefined), [t]);

  const storage = () => {
    try {
      const s = window.localStorage;
      s.getItem("tickr.activation.probe");
      return s;
    } catch {
      throw new Error("this browser cannot keep the activation record (storage is unavailable). nothing is sent without one.");
    }
  };

  const load = useCallback((): Ledger => {
    check(t && user, "no launch or wallet");
    return loadLedger(storage(), chainId, user, t.token, t.ticker);
  }, [t, user, chainId]);

  /** Run `fn` holding this wallet's signing lock across tabs; a busy lock means another tab is on it. */
  const locked = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      check(user, "no wallet");
      const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
      if (!locks) return fn(); // an older browser: the in-tab guard below still holds
      return locks.request(lockName(chainId, user), { ifAvailable: true }, async (lock) => {
        check(lock, "another tab is activating with this wallet. finish there, or close it without clearing its records.");
        return fn();
      }) as Promise<T>;
    },
    [chainId, user],
  );

  const fail = useCallback((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    setReadsDown(isReadUnavailable(e));
    setError(msg);
    setReview(null);
  }, []);

  /** What the chain says about every recorded attempt. Reads only. */
  const inspect = useCallback(
    async (l: Ledger): Promise<Inspection> => {
      check(client && pools, "no client");
      const s: Inspection = { next: 0, confirmed: false, pending: false, blocked: "", cost: 0n, records: [], unknown: false };
      const chain = await readBounded(() => client.getChainId());
      check(chain === chainId, "the read connection is on another chain");
      let previousBlock = -1n;
      const head = await readBounded(() => client.getBlockNumber());
      for (const a of l.attempts) {
        const rec: Record = { phase: a.review.phase, hash: a.hash, status: "no hash", cost: 0n, received: 0n };
        s.records.push(rec);
        if (!a.hash) {
          s.unknown = true;
          s.blocked = "the wallet's answer to the last request was lost. paste its transaction hash below; nothing is sent again until it is found.";
          return s;
        }
        const tx = await readBounded(() => client.getTransaction({ hash: a.hash! }).catch((e) => (String(e).includes("not be found") || String(e).includes("TransactionNotFound") ? null : Promise.reject(e))));
        if (!tx) {
          s.pending = true;
          rec.status = "waiting";
          s.blocked = "waiting for the saved transaction to become visible. reads only; nothing is resent.";
          return s;
        }
        try {
          matchIdentity({ from: tx.from, to: tx.to, input: tx.input, nonce: tx.nonce, value: tx.value, chainId: tx.chainId }, a.review.request);
        } catch (e) {
          rec.status = "stopped";
          rec.note = e instanceof Error ? e.message : String(e);
          s.blocked = rec.note;
          return s;
        }
        check(BigInt(tx.gas) * (tx.maxFeePerGas ?? 0n) + tx.value <= BigInt(a.review.maximum), "the wallet submitted more than the reviewed maximum. stop for review.");
        const receipt = await readBounded(() => client.getTransactionReceipt({ hash: a.hash! }).catch((e) => (String(e).includes("could not be found") || String(e).includes("ReceiptNotFound") ? null : Promise.reject(e))));
        if (!receipt) {
          s.pending = true;
          rec.status = "pending";
          s.blocked = "the transaction is pending. do not speed it up, replace or resend it; reads continue.";
          return s;
        }
        rec.cost = tx.value + receipt.gasUsed * receipt.effectiveGasPrice;
        s.cost += rec.cost;
        if (receipt.status !== "success") {
          rec.status = "stopped";
          rec.note = "reverted on chain and used its nonce. stop for review; nothing is retried automatically.";
          s.blocked = rec.note;
          return s;
        }
        const block = await readBounded(() => client.getBlock({ blockNumber: receipt.blockNumber }));
        check(block && same(block.hash, receipt.blockHash), "the receipt's block is no longer canonical. stop for review.");
        check(receipt.blockNumber > previousBlock, "the coin purchase must land in a later block than the name purchase.");
        if (head <= receipt.blockNumber) {
          s.pending = true;
          rec.status = "confirming";
          s.blocked = "waiting for one more block.";
          return s;
        }
        rec.received = verifyTradeLogs(l, a.review.phase, receipt.logs as { address: Address; topics: Hex[]; data: Hex }[], BigInt(a.review.minimum), a.review.pools);
        rec.blockNumber = receipt.blockNumber;
        rec.status = "confirmed";
        previousBlock = receipt.blockNumber;
        s.next++;
      }
      s.confirmed = s.next === 2;
      return s;
    },
    [client, chainId, pools],
  );

  /** Reads only: reload the journal and check it against the chain. */
  const refresh = useCallback(async () => {
    if (!ready || inFlight.current) return;
    setBusy("checking saved receipts, no spending");
    setError("");
    setReview(null);
    setInspection(null);
    try {
      await locked(async () => {
        const l = load();
        setLedger(l);
        const s = await inspect(l);
        check(fingerprint(load()) === fingerprint(l), "the record changed while it was being checked");
        setInspection(s);
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  }, [ready, locked, load, inspect, fail]);

  // the journal on mount and whenever the wallet, chain or launch changes; another tab's write reloads it
  useEffect(() => {
    if (!ready) return;
    // the first read is deferred a tick: an effect starts it, the read itself sets the state
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
  }, [ready, t?.token, user, chainId]);

  // a pending attempt is re-read on a timer, reads only
  useEffect(() => {
    if (busy || !inspection?.pending || inspection.unknown) return;
    const timer = setTimeout(() => void refresh(), 6_000);
    return () => clearTimeout(timer);
  }, [busy, inspection, refresh]);

  /** The checks before either phase may be prepared: the chain, the wallet, the pools, the restrictions, the order. */
  const readyFor = useCallback(
    async (l: Ledger, phase: Phase) => {
      check(client && t && user && pools, "not ready");
      const s = await inspect(l);
      const offset = PHASES.indexOf(phase);
      check(!s.blocked && !s.pending && s.next === offset && l.attempts.length === offset, s.blocked || (offset === 1 ? "confirm the name purchase first, or refresh its receipt" : "the record is ahead of the chain; refresh"));
      check((await readBounded(() => client.getCode({ address: user }))) === undefined || (await readBounded(() => client.getCode({ address: user }))) === "0x", "use an ordinary wallet account, not a smart account");
      const [latest, pending] = await Promise.all([readBounded(() => client.getTransactionCount({ address: user, blockTag: "latest" })), readBounded(() => client.getTransactionCount({ address: user, blockTag: "pending" }))]);
      check(latest === pending, "this wallet has a transaction pending. wait for it; nothing is sent on top of it.");
      const main = await readBounded(() => client.readContract({ abi: FACTORY_ABI, address: ADDRESSES.factory, functionName: "poolKeyOf", args: [t.token] }));
      const bridge = await readBounded(() => client.readContract({ abi: WRAPPER_ABI, address: t.ticker, functionName: "poolKey" }));
      check(poolId({ ...main, fee: Number(main.fee), tickSpacing: Number(main.tickSpacing) }) === poolId(pools.main) && poolId({ ...bridge, fee: Number(bridge.fee), tickSpacing: Number(bridge.tickSpacing) }) === poolId(pools.bridge), "the pools on chain differ from the ones reviewed");
      if (phase === "coin") {
        const [tax, buy, hold] = await Promise.all([
          readBounded(() => client.readContract({ abi: COIN_ABI, address: t.token, functionName: "currentSnipeTaxBps", args: [user] })),
          readBounded(() => client.readContract({ abi: COIN_ABI, address: t.token, functionName: "remainingBuy", args: [user] })),
          readBounded(() => client.readContract({ abi: COIN_ABI, address: t.token, functionName: "remainingHold", args: [user] })),
        ]);
        check(tax === 0n && buy === MAX256 && hold === MAX256, "the coin's launch restrictions still apply to this wallet. wait for them to clear; the page checks again.");
      }
      return { latest, balance: await readBounded(() => client.getBalance({ address: user })) };
    },
    [client, t, user, pools, inspect],
  );

  /** A review of one phase: a fresh quote, its minimum, the exact transaction and its cost ceiling. Sends nothing. */
  const prepare = useCallback(
    async (phase: Phase) => {
      if (!ready || inFlight.current) return;
      setBusy(phase === "quote" ? "checking the chain, a fresh quote and fees for the name purchase" : "rechecking the name purchase, then a fresh quote and fees for the coin purchase");
      setError("");
      setReview(null);
      try {
        await locked(async () => {
          check(client && t && user && pools, "not ready");
          const l = load();
          check(l.attempts.length === PHASES.indexOf(phase) && l.attempts.every((a) => !!a.hash), "confirm the earlier purchase first, or refresh its receipt. an existing request is never repeated.");
          const state = await readyFor(l, phase);
          const amount = AMOUNTS[phase];
          const path = routeFor(pools, phase);
          const quoted = await readBounded(async () => {
            const { result } = await client.simulateContract({ abi: QUOTER_ABI, address: ADDRESSES.v4Quoter, functionName: "quoteExactInput", args: [{ exactCurrency: "0x0000000000000000000000000000000000000000", path, exactAmount: amount }] });
            return result[0];
          });
          const minimum = minimumOutput(quoted);
          const head = await readBounded(() => client.getBlock());
          const deadline = Number(head.timestamp) + DEADLINE_SECONDS;
          const data = encodeBuy({ wallet: user, pools, phase, amountIn: amount, minimumOut: minimum, deadline });
          const bare = { from: user, to: ADDRESSES.universalRouter, data, value: amount };
          const estimate = await readBounded(() => client.estimateGas({ account: user, to: bare.to, data: bare.data, value: bare.value }));
          const gas = paddedGas(estimate);
          const price = await readBounded(() => client.getGasPrice());
          const request = { from: user, to: ADDRESSES.universalRouter, data, value: hex(amount), nonce: hex(state.latest), chainId, gas: hex(gas), maxFeePerGas: hex(price * 2n), maxPriorityFeePerGas: "0x0" as Hex };
          const maximum = permissionCeiling(amount, gas, price * 2n);
          check(maximum <= state.balance, "this purchase plus its gas ceiling exceeds the wallet's balance. nothing sent.");
          const out = await readBounded(() => client.call({ account: user, to: bare.to, data: bare.data, value: bare.value, gas }));
          check(!out.data || out.data === "0x", "the simulation returned unexpected output");
          const v: Review = {
            phase,
            request,
            maximum: maximum.toString(),
            preparedAt: Date.now(),
            ledgerFingerprint: fingerprint(l),
            quote: quoted.toString(),
            minimum: minimum.toString(),
            deadline,
            predecessorHash: phase === "coin" ? l.attempts[0].hash! : "",
            pools,
            gasEstimate: estimate.toString(),
          };
          validateReview(l, v);
          check(!reviewExpired(v), "the reads took too long for this quote to be fresh. nothing sent; check again.");
          setLedger(l);
          setReview(v);
        });
      } catch (e) {
        fail(e);
      } finally {
        setBusy("");
      }
    },
    [ready, locked, client, t, user, pools, chainId, load, readyFor, fail],
  );

  /** Send the reviewed request, exactly as reviewed, after fresh checks. The intent is saved before the wallet opens. */
  const send = useCallback(async () => {
    if (!ready || !review || inFlight.current) return;
    inFlight.current = true;
    setBusy("rechecking, then waiting for your wallet");
    setError("");
    try {
      await locked(async () => {
        check(client && t && user && pools && wallet.data && connector, "not ready");
        const v = review;
        const l = load();
        const offset = PHASES.indexOf(v.phase);
        check(l.attempts.length === offset && fingerprint(l) === v.ledgerFingerprint && !reviewExpired(v), "the record changed, the step was already submitted, or the review expired. check again.");
        if (offset === 1) check(same(l.attempts[0].hash, v.predecessorHash), "the preceding receipt changed");
        const state = await readyFor(l, v.phase);
        check(state.balance >= BigInt(v.maximum), "insufficient balance for this purchase and its gas ceiling");
        check(BigInt(v.request.nonce) === BigInt(state.latest), "the wallet's nonce changed. check again; nothing is rebased.");
        const out = await readBounded(() => client.call({ account: user, to: v.request.to, data: v.request.data, value: BigInt(v.request.value), gas: BigInt(v.request.gas) }));
        check(!out.data || out.data === "0x", "the fresh simulation did not pass");
        const price = await readBounded(() => client.getGasPrice());
        check(price <= BigInt(v.request.maxFeePerGas), "fees rose above the reviewed cap. check again.");
        const head = await readBounded(() => client.getBlock());
        check(Number(head.timestamp) + 90 < v.deadline, "the quote's deadline is too close. check again.");
        const provider = (await connector.getProvider()) as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
        const [accounts, chain] = await Promise.all([provider.request({ method: "eth_accounts" }) as Promise<string[]>, provider.request({ method: "eth_chainId" }) as Promise<string>]);
        check(same(accounts?.[0], user) && Number(BigInt(chain)) === chainId, "the wallet's account or network changed. nothing sent.");
        // the intent first, durably; then the wallet
        const intent: Ledger = { ...l, attempts: [...l.attempts, { review: v, createdAt: Date.now() }] };
        saveLedger(storage(), intent);
        setLedger(intent);
        let hash: Hash;
        try {
          hash = await wallet.data.sendTransaction({
            account: user,
            to: v.request.to,
            data: v.request.data,
            value: BigInt(v.request.value),
            gas: BigInt(v.request.gas),
            nonce: Number(BigInt(v.request.nonce)),
            maxFeePerGas: BigInt(v.request.maxFeePerGas),
            maxPriorityFeePerGas: 0n,
            chain: wallet.data.chain,
          });
          check(isHash(hash), "the wallet returned no usable hash. recover the transaction below; never resend.");
        } catch (e) {
          const code = (e as { code?: number; cause?: { code?: number } })?.code ?? (e as { cause?: { code?: number } })?.cause?.code;
          const msg = e instanceof Error ? e.message : String(e);
          const rejected = code === 4001 || /rejected|denied|User rejected/i.test(msg);
          if (rejected) {
            // a decline is only a decline if nothing left the wallet: the nonce says so
            const [latest, pending] = await Promise.all([readBounded(() => client.getTransactionCount({ address: user, blockTag: "latest" })), readBounded(() => client.getTransactionCount({ address: user, blockTag: "pending" }))]);
            if (BigInt(latest) === BigInt(v.request.nonce) && latest === pending) {
              check(fingerprint(load()) === fingerprint(intent), "the record changed while the wallet was open; the unresolved intent is kept for review");
              const declined: Ledger = { ...l, declined: [...l.declined, { review: v, createdAt: Date.now() }] };
              saveLedger(storage(), declined);
              setLedger(declined);
              setReview(null);
              throw new Error("you declined in the wallet. nothing was sent.");
            }
          }
          throw new Error(`the wallet did not return a transaction hash (${msg}). the intent is kept: if the wallet shows a transaction, paste its hash below. nothing is resent.`);
        }
        const saved: Ledger = { ...intent, attempts: intent.attempts.map((a, i) => (i === offset ? { ...a, hash } : a)) };
        try {
          check(fingerprint(load()) === fingerprint(intent), "the record changed while the wallet was open");
          saveLedger(storage(), saved);
        } catch (e) {
          throw new Error(`the wallet returned ${hash} but saving it failed. keep this hash and paste it below; never resend. ${e instanceof Error ? e.message : ""}`);
        }
        setLedger(saved);
        setReview(null);
        const s = await inspect(saved);
        setInspection(s);
        if (s.confirmed) setCelebrate(true);
      });
    } catch (e) {
      fail(e);
    } finally {
      inFlight.current = false;
      setBusy("");
    }
  }, [ready, review, locked, client, t, user, pools, wallet.data, connector, chainId, load, readyFor, inspect, fail]);

  /** Attach a hash the wallet showed for an attempt whose answer was lost: verified against the reviewed request. */
  const recover = useCallback(
    async (input: string) => {
      if (!ready || inFlight.current) return;
      setBusy("matching the transaction hash, no spending");
      setError("");
      try {
        await locked(async () => {
          check(client, "no client");
          const l = load();
          const last = l.attempts.at(-1);
          check(last && !last.hash, "there is no unresolved request");
          const h = input.trim();
          check(isHash(h), "enter the public transaction hash, never a key");
          const tx = await readBounded(() => client.getTransaction({ hash: h as Hash }));
          check(tx && same(tx.hash, h), "no transaction is visible at this hash yet");
          matchIdentity({ from: tx.from, to: tx.to, input: tx.input, nonce: tx.nonce, value: tx.value, chainId: tx.chainId }, last.review.request);
          const saved: Ledger = { ...l, attempts: l.attempts.map((a, i) => (i === l.attempts.length - 1 ? { ...a, hash: h as Hash } : a)) };
          saveLedger(storage(), saved);
          setLedger(saved);
          setInspection(await inspect(saved));
        });
      } catch (e) {
        fail(e);
      } finally {
        setBusy("");
      }
    },
    [ready, locked, client, load, inspect, fail],
  );

  /** Only a request that never reached the chain may be set aside: the nonce must still be where the review put it. */
  const dismissUnsent = useCallback(async () => {
    if (!ready || inFlight.current) return;
    setBusy("checking that nothing was sent");
    setError("");
    try {
      await locked(async () => {
        check(client && user, "no client");
        const l = load();
        const last = l.attempts.at(-1);
        check(last && !last.hash, "there is no unresolved request");
        const [latest, pending] = await Promise.all([readBounded(() => client.getTransactionCount({ address: user, blockTag: "latest" })), readBounded(() => client.getTransactionCount({ address: user, blockTag: "pending" }))]);
        check(BigInt(latest) === BigInt(last.review.request.nonce) && latest === pending, "the wallet's nonce moved: a transaction was sent. paste its hash instead.");
        const saved: Ledger = { ...l, attempts: l.attempts.slice(0, -1), declined: [...l.declined, last] };
        saveLedger(storage(), saved);
        setLedger(saved);
        setInspection(await inspect(saved));
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  }, [ready, locked, client, user, load, inspect, fail]);

  const next = inspection?.next ?? Math.min(ledger?.attempts.length ?? 0, 2);
  const phase: Phase = next === 0 ? "quote" : "coin";
  const unverified = (ledger?.attempts.length ?? 0) > next;
  const done = inspection?.confirmed === true;

  return {
    ready,
    ledger,
    inspection,
    review,
    busy,
    error,
    readsDown,
    next,
    phase,
    unverified,
    unknown: inspection?.unknown === true || (!!ledger?.attempts.at(-1) && !ledger.attempts.at(-1)!.hash),
    done,
    celebrate,
    amounts: AMOUNTS,
    prepare,
    send,
    refresh,
    recover,
    dismissUnsent,
    expired: !!review && reviewExpired(review),
    cost: (v: Review) => maximumCost(v.request),
    json,
    validateLedger,
    attemptsOf: (l: Ledger): Attempt[] => l.attempts,
  };
}

export type { Ledger, Review, Attempt };
