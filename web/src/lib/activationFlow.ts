import type { Address, Hash, Hex } from "viem";
import type { V4Key } from "./route";
import {
  AMOUNTS,
  DEADLINE_SECONDS,
  MAX256,
  PHASES,
  check,
  encodeBuy,
  fingerprint,
  hex,
  isHash,
  loadLedger,
  lockName,
  matchIdentity,
  minimumOutput,
  paddedGas,
  permissionCeiling,
  poolId,
  reviewExpired,
  routeFor,
  same,
  saveLedger,
  validateLedger,
  validateReview,
  verifyTradeLogs,
  type Ledger,
  type Phase,
  type Pools,
  type Request,
  type Review,
} from "./activation";

/**
 * The activation workflow with everything outside it injected: chain reads, the wallet, storage, the cross-tab lock
 * and the clock. The React hook is a thin shell around it; the offline tests drive it through failures a browser
 * meets: a wallet whose answer is lost, a transaction that takes time to appear, a reload, a second tab, no lock.
 *
 * The rules it keeps, always:
 *   - an attempt is written before the wallet opens, its hash the moment the wallet returns one;
 *   - an attempt whose hash was never returned is unknown, and stays unknown until the hash is found by hand;
 *     nothing about the chain's view of a nonce turns unknown into "never sent";
 *   - a wallet's own pre-broadcast rejection (code 4001) is the one thing that declines an attempt;
 *   - nothing is prepared while an attempt is unknown, pending, or unverified;
 *   - one signing lock per wallet across tabs, or no signing at all.
 */

export type Tx = { hash: Hash; from: Address; to: Address | null; input: Hex; nonce: number; value: bigint; chainId?: number; gas: bigint; maxFeePerGas?: bigint; blockHash?: Hash | null; blockNumber?: bigint | null };
export type Receipt = { transactionHash: Hash; blockHash: Hash; blockNumber: bigint; status: "success" | "reverted"; gasUsed: bigint; effectiveGasPrice: bigint; logs: { address: Address; topics: Hex[]; data: Hex }[] };
export type Block = { hash: Hash; number: bigint; timestamp: bigint };

export type Reads = {
  chainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  block(n?: bigint): Promise<Block>;
  transaction(hash: Hash): Promise<Tx | null>;
  receipt(hash: Hash): Promise<Receipt | null>;
  /** "0x" or undefined for no code, as the client library reports it; a thrown error means unknown */
  code(addr: Address): Promise<Hex | undefined>;
  nonce(addr: Address, tag: "latest" | "pending"): Promise<bigint>;
  balance(addr: Address): Promise<bigint>;
  coinPoolKey(coin: Address): Promise<V4Key>;
  namePoolKey(name: Address): Promise<V4Key>;
  restrictions(coin: Address, wallet: Address): Promise<{ tax: bigint; buy: bigint; hold: bigint }>;
  quote(path: ReturnType<typeof routeFor>, amount: bigint): Promise<bigint>;
  estimateGas(req: { from: Address; to: Address; data: Hex; value: bigint }): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  call(req: { from: Address; to: Address; data: Hex; value: bigint; gas?: bigint }): Promise<Hex | undefined>;
};

export type WalletProvider = {
  accounts(): Promise<string[]>;
  chainId(): Promise<number>;
  /** returns the hash; throws `{ code: 4001 }` (or a cause with it) when the person declined before broadcast */
  send(request: Request): Promise<Hash>;
};

export type Locks = { request<T>(name: string, fn: () => Promise<T>): Promise<T> } | undefined;
export type Store = Pick<Storage, "getItem" | "setItem">;

export type Deps = {
  chainId: number;
  wallet: Address;
  coin: Address;
  ticker: Address;
  pools: Pools;
  router: Address;
  storage: Store;
  reads: Reads;
  provider: WalletProvider;
  locks: Locks;
  now?: () => number;
};

export type RecordStatus = "no hash" | "waiting" | "pending" | "confirming" | "confirmed" | "stopped";
export type Record = { phase: Phase; hash?: Hash; status: RecordStatus; cost: bigint; received: bigint; blockNumber?: bigint; note?: string };
export type Inspection = { next: number; confirmed: boolean; pending: boolean; blocked: string; cost: bigint; records: Record[]; unknown: boolean };

export const isRejection = (e: unknown): boolean => {
  const o = e as { code?: number; cause?: { code?: number }; name?: string } | undefined;
  return o?.code === 4001 || o?.cause?.code === 4001 || o?.name === "UserRejectedRequestError";
};

export function createActivationFlow(d: Deps) {
  const now = d.now ?? Date.now;
  const r = d.reads;

  function load(): Ledger {
    return loadLedger(d.storage, d.chainId, d.wallet, d.coin, d.ticker);
  }

  /** Run `fn` holding this wallet's signing lock across tabs; no lock manager means no signing. */
  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    check(d.locks, "this browser cannot hold a signing lock across tabs, so nothing is sent from it. use a current desktop browser.");
    return d.locks.request(lockName(d.chainId, d.wallet), fn);
  }

  const noCode = (code: Hex | undefined) => code === undefined || code === "0x";

  /** What the chain says about every recorded attempt. Reads only. */
  async function inspect(l: Ledger): Promise<Inspection> {
    const s: Inspection = { next: 0, confirmed: false, pending: false, blocked: "", cost: 0n, records: [], unknown: false };
    check((await r.chainId()) === d.chainId, "the read connection is on another chain");
    let previousBlock = -1n;
    const head = await r.blockNumber();
    for (const a of l.attempts) {
      const rec: Record = { phase: a.review.phase, hash: a.hash, status: "no hash", cost: 0n, received: 0n };
      s.records.push(rec);
      if (!a.hash) {
        s.unknown = true;
        s.blocked = "the wallet's answer to the last request was lost. paste the transaction hash the wallet shows; nothing is sent again until it is found.";
        return s;
      }
      const tx = await r.transaction(a.hash);
      if (!tx) {
        s.pending = true;
        rec.status = "waiting";
        s.blocked = "waiting for the saved transaction to become visible. reads only; nothing is resent.";
        return s;
      }
      try {
        matchIdentity({ from: tx.from, to: tx.to, input: tx.input, nonce: tx.nonce, value: tx.value, chainId: tx.chainId }, a.review.request);
        check(tx.value + tx.gas * (tx.maxFeePerGas ?? 0n) <= BigInt(a.review.maximum), "the wallet submitted more than the reviewed maximum. stop for review.");
      } catch (e) {
        rec.status = "stopped";
        rec.note = e instanceof Error ? e.message : String(e);
        s.blocked = rec.note;
        return s;
      }
      const receipt = await r.receipt(a.hash);
      if (!receipt) {
        s.pending = true;
        rec.status = "pending";
        s.blocked = "";
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
      const block = await r.block(receipt.blockNumber);
      if (!block || !same(block.hash, receipt.blockHash)) {
        rec.status = "stopped";
        rec.note = "the receipt's block is no longer canonical. stop for review.";
        s.blocked = rec.note;
        return s;
      }
      if (receipt.blockNumber <= previousBlock) {
        rec.status = "stopped";
        rec.note = "the coin purchase must land in a later block than the name purchase.";
        s.blocked = rec.note;
        return s;
      }
      if (head <= receipt.blockNumber) {
        s.pending = true;
        rec.status = "confirming";
        s.blocked = "";
        return s;
      }
      try {
        rec.received = verifyTradeLogs(l, a.review.phase, receipt.logs, BigInt(a.review.minimum), a.review.pools);
      } catch (e) {
        rec.status = "stopped";
        rec.note = e instanceof Error ? e.message : String(e);
        s.blocked = rec.note;
        return s;
      }
      rec.blockNumber = receipt.blockNumber;
      rec.status = "confirmed";
      previousBlock = receipt.blockNumber;
      s.next++;
    }
    s.confirmed = s.next === 2;
    return s;
  }

  /** Reads only: the journal against the chain, under the lock so a concurrent write is caught. */
  async function refresh(): Promise<{ ledger: Ledger; inspection: Inspection }> {
    return locked(async () => {
      const l = load();
      const s = await inspect(l);
      check(fingerprint(load()) === fingerprint(l), "the record changed while it was being checked");
      return { ledger: l, inspection: s };
    });
  }

  async function readyFor(l: Ledger, phase: Phase): Promise<{ latest: bigint; balance: bigint }> {
    const s = await inspect(l);
    const offset = PHASES.indexOf(phase);
    check(!s.blocked && !s.pending && s.next === offset && l.attempts.length === offset, s.blocked || (offset === 1 ? "confirm the name purchase first, or refresh its receipt" : "the record is ahead of the chain; refresh"));
    check(noCode(await r.code(d.wallet)), "use an ordinary wallet account, not a smart account");
    const [latest, pending] = await Promise.all([r.nonce(d.wallet, "latest"), r.nonce(d.wallet, "pending")]);
    check(latest === pending, "this wallet has a transaction pending. wait for it; nothing is sent on top of it.");
    const [main, bridge] = await Promise.all([r.coinPoolKey(d.coin), r.namePoolKey(d.ticker)]);
    check(poolId(main) === poolId(d.pools.main) && poolId(bridge) === poolId(d.pools.bridge), "the pools on chain differ from the ones reviewed");
    if (phase === "coin") {
      const x = await r.restrictions(d.coin, d.wallet);
      check(x.tax === 0n && x.buy === MAX256 && x.hold === MAX256, "the coin's launch restrictions still apply to this wallet. wait for them to clear; the page checks again.");
    }
    return { latest, balance: await r.balance(d.wallet) };
  }

  /** A review of one phase: a fresh quote, its minimum, the exact transaction, its cost ceiling. Sends nothing. */
  async function prepare(phase: Phase): Promise<Review> {
    return locked(async () => {
      const l = load();
      check(l.attempts.length === PHASES.indexOf(phase) && l.attempts.every((a) => !!a.hash), "confirm the earlier purchase first, or refresh its receipt. an existing request is never repeated.");
      const state = await readyFor(l, phase);
      const amount = AMOUNTS[phase];
      const path = routeFor(d.pools, phase);
      const quoted = await r.quote(path, amount);
      const minimum = minimumOutput(quoted);
      const head = await r.block();
      const deadline = Number(head.timestamp) + DEADLINE_SECONDS;
      const data = encodeBuy({ wallet: d.wallet, pools: d.pools, phase, amountIn: amount, minimumOut: minimum, deadline });
      const bare = { from: d.wallet, to: d.router, data, value: amount };
      const estimate = await r.estimateGas(bare);
      const gas = paddedGas(estimate);
      const price = await r.gasPrice();
      const request: Request = { from: d.wallet, to: d.router, data, value: hex(amount), nonce: hex(state.latest), chainId: d.chainId, gas: hex(gas), maxFeePerGas: hex(price * 2n), maxPriorityFeePerGas: "0x0" };
      const maximum = permissionCeiling(amount, gas, price * 2n);
      check(maximum <= state.balance, "this purchase plus its gas ceiling exceeds the wallet's balance. nothing sent.");
      const out = await r.call({ ...bare, gas });
      check(!out || out === "0x", "the simulation returned unexpected output");
      const v: Review = {
        phase,
        request,
        maximum: maximum.toString(),
        preparedAt: now(),
        ledgerFingerprint: fingerprint(l),
        quote: quoted.toString(),
        minimum: minimum.toString(),
        deadline,
        predecessorHash: phase === "coin" ? l.attempts[0].hash! : "",
        pools: d.pools,
        gasEstimate: estimate.toString(),
      };
      validateReview(l, v);
      check(!reviewExpired(v, now()), "the reads took too long for this quote to be fresh. nothing sent; check again.");
      return v;
    });
  }

  /** Send the reviewed request, exactly as reviewed, after fresh checks. The intent is written before the wallet opens. */
  async function send(v: Review): Promise<Ledger> {
    return locked(async () => {
      const l = load();
      const offset = PHASES.indexOf(v.phase);
      check(l.attempts.length === offset && fingerprint(l) === v.ledgerFingerprint && !reviewExpired(v, now()), "the record changed, the step was already submitted, or the review expired. check again.");
      if (offset === 1) check(same(l.attempts[0].hash, v.predecessorHash), "the preceding receipt changed");
      const state = await readyFor(l, v.phase);
      check(state.balance >= BigInt(v.maximum), "insufficient balance for this purchase and its gas ceiling");
      check(BigInt(v.request.nonce) === state.latest, "the wallet's nonce changed. check again; nothing is rebased.");
      const out = await r.call({ from: d.wallet, to: v.request.to, data: v.request.data, value: BigInt(v.request.value), gas: BigInt(v.request.gas) });
      check(!out || out === "0x", "the fresh simulation did not pass");
      check((await r.gasPrice()) <= BigInt(v.request.maxFeePerGas), "fees rose above the reviewed cap. check again.");
      const head = await r.block();
      check(Number(head.timestamp) + 90 < v.deadline, "the quote's deadline is too close. check again.");
      const [accounts, chain] = await Promise.all([d.provider.accounts(), d.provider.chainId()]);
      check(same(accounts?.[0], d.wallet) && chain === d.chainId, "the wallet's account or network changed. nothing sent.");
      check(fingerprint(load()) === fingerprint(l), "the record changed before sending");
      // the intent first, durably; then the wallet
      const intent: Ledger = { ...l, attempts: [...l.attempts, { review: v, createdAt: now() }] };
      saveLedger(d.storage, intent);
      let hash: Hash;
      try {
        hash = await d.provider.send(v.request);
        check(isHash(hash), "the wallet returned no usable hash. recover the transaction by its hash; never resend.");
      } catch (e) {
        if (isRejection(e)) {
          // the wallet itself says it was declined before anything left it: the one definite decline
          check(fingerprint(load()) === fingerprint(intent), "the record changed while the wallet was open; the unresolved intent is kept for review");
          const declined: Ledger = { ...l, declined: [...l.declined, { review: v, createdAt: now() }] };
          saveLedger(d.storage, declined);
          throw new Error("you declined in the wallet. nothing was sent.");
        }
        // anything else is unknown: the attempt stays, hashless, until its hash is found
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`the wallet did not return a transaction hash (${msg}). the request is kept as unresolved: if the wallet shows a transaction, paste its hash. nothing is resent.`);
      }
      const saved: Ledger = { ...intent, attempts: intent.attempts.map((a, i) => (i === offset ? { ...a, hash } : a)) };
      try {
        check(fingerprint(load()) === fingerprint(intent), "the record changed while the wallet was open");
        saveLedger(d.storage, saved);
      } catch (e) {
        throw new Error(`the wallet returned ${hash} but saving it failed. keep this hash and paste it to recover; never resend. ${e instanceof Error ? e.message : ""}`);
      }
      return saved;
    });
  }

  /** Attach the hash the wallet showed for an attempt whose answer was lost, verified against the reviewed request. */
  async function recover(input: string): Promise<Ledger> {
    return locked(async () => {
      const l = load();
      const last = l.attempts.at(-1);
      check(last && !last.hash, "there is no unresolved request");
      const h = input.trim();
      check(isHash(h), "enter the public transaction hash, never a key");
      const tx = await r.transaction(h as Hash);
      check(tx && same(tx.hash, h), "no transaction is visible at this hash yet");
      matchIdentity({ from: tx.from, to: tx.to, input: tx.input, nonce: tx.nonce, value: tx.value, chainId: tx.chainId }, last.review.request);
      const saved: Ledger = { ...l, attempts: l.attempts.map((a, i) => (i === l.attempts.length - 1 ? { ...a, hash: h as Hash } : a)) };
      saveLedger(d.storage, saved);
      return saved;
    });
  }

  return { load, inspect, refresh, prepare, send, recover, validateLedger };
}

export type ActivationFlow = ReturnType<typeof createActivationFlow>;
