import { decodeEventLog, parseAbi, type Address, type Hash, type Hex } from "viem";
import { fingerprint, isHash, lockName, same } from "./activation";

/**
 * The creation workflow with everything outside it injected, like the activation's: one launch per wallet at a
 * time, its intent written before the wallet opens, the hash the moment the wallet returns it, and the receipt
 * settled against that intent: the factory's own `TokenLaunched` for the predicted coin, in a canonical block.
 *
 * The rules:
 *   - an unresolved launch (prepared, sent, or launched but not yet read) blocks a new one; there is no dismissal
 *     of an unknown outcome: it resolves by its hash, or by the wallet's own pre-broadcast rejection;
 *   - a recovered or replacing transaction must be the reviewed one: sender, target, calldata, value, chain, nonce;
 *   - a receipt settles the launch only when the factory emitted the launch of the predicted coin in it, the block
 *     is canonical and one more block sits on top;
 *   - a record this browser cannot read, or that has a shape it does not know, is unresolved, not absent;
 *   - every transition, the reads-only ones included, runs under the wallet's signing lock across tabs and re-reads
 *     the record before writing, so a delayed result can never overwrite a newer record;
 *   - no lock manager, no launch.
 */

export type LaunchStatus = "prepared" | "sent" | "launched" | "reverted";
export type LaunchIntent = {
  version: 2;
  chainId: number;
  wallet: Address;
  /** the salt seed the address was ground from: kept, so a retry can only be the same address */
  seed: Hex;
  predicted?: Address;
  label: string;
  isTicker: boolean;
  tickerSymbol?: string;
  /** the exact request: target, calldata, value and the nonce it will carry */
  to: Address;
  data: Hex;
  value: string;
  nonce: number;
  createdAt: number;
  status: LaunchStatus;
  hash?: Hash;
  /** the hash the wallet first returned, when a repricing replaced it */
  originalHash?: Hash;
  token?: Address;
  poolId?: Hex;
  blockNumber?: string;
  blockHash?: Hash;
};

export type LaunchTx = { hash: Hash; from: Address; to: Address | null; input: Hex; nonce: number; value: bigint; chainId?: number };
export type LaunchReceipt = { transactionHash: Hash; blockHash: Hash; blockNumber: bigint; status: "success" | "reverted"; logs: { address: Address; topics: Hex[]; data: Hex }[] };
export type LaunchReads = {
  transaction(hash: Hash): Promise<LaunchTx | null>;
  receipt(hash: Hash): Promise<LaunchReceipt | null>;
  block(n: bigint): Promise<{ hash: Hash; number: bigint } | null>;
  blockNumber(): Promise<bigint>;
};
export type Locks = { request<T>(name: string, fn: () => Promise<T>): Promise<T> } | undefined;
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type LaunchDeps = { chainId: number; wallet: Address; factory: Address; storage: Store; reads: LaunchReads; locks: Locks; now?: () => number };

const LAUNCHED = parseAbi(["event TokenLaunched(address indexed token, bytes32 indexed poolId, address indexed deployer, address pairToken, uint256 launchConfigId, uint24 poolFee, uint256 phantomQuote)"]);

export const launchKey = (chainId: number, wallet: Address) => `tickr.launch.v2.${chainId}.${wallet.toLowerCase()}`;
/** the key an earlier build wrote: a record there is settled, or at least seen, before anything new */
export const legacyLaunchKey = (chainId: number, wallet: Address) => `tickr.launch.v1.${chainId}.${wallet.toLowerCase()}`;
export const launchUnresolved = (v?: LaunchIntent) => !!v && (v.status === "prepared" || v.status === "sent" || (v.status === "launched" && !v.token));

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

const STATUSES: LaunchStatus[] = ["prepared", "sent", "launched", "reverted"];

/** The whole shape, by status: what a record must carry to be trusted at all. */
export function validateIntent(v: unknown, chainId: number, wallet: Address): LaunchIntent {
  const x = v as LaunchIntent;
  check(x && typeof x === "object", "the saved launch record is not a record");
  check(x.version === 2 && x.chainId === chainId && same(x.wallet, wallet), "the saved launch record is not this wallet's on this chain");
  check(typeof x.seed === "string" && /^0x[0-9a-f]{64}$/i.test(x.seed), "the saved launch record has no seed");
  check(typeof x.label === "string" && typeof x.isTicker === "boolean" && Number.isFinite(x.createdAt), "the saved launch record is incomplete");
  check(typeof x.to === "string" && /^0x[0-9a-fA-F]{40}$/.test(x.to) && typeof x.data === "string" && /^0x[0-9a-fA-F]*$/.test(x.data) && /^\d+$/.test(String(x.value)) && Number.isInteger(x.nonce) && x.nonce >= 0, "the saved launch record has no complete request");
  check(x.predicted === undefined || /^0x[0-9a-fA-F]{40}$/.test(x.predicted), "the saved launch record's predicted address is malformed");
  check(STATUSES.includes(x.status), "the saved launch record has an unknown status");
  if (x.status === "prepared") check(x.hash === undefined, "a prepared launch cannot carry a hash");
  if (x.status === "sent" || x.status === "launched" || x.status === "reverted") check(isHash(x.hash), "a sent launch must carry its hash");
  check(x.originalHash === undefined || isHash(x.originalHash), "malformed original hash");
  if (x.status === "launched") check(!!x.token && /^0x[0-9a-fA-F]{40}$/.test(x.token) && typeof x.blockNumber === "string" && isHash(x.blockHash), "a launched record must carry the coin and its block");
  if (x.status !== "launched") check(x.token === undefined, "only a launched record carries a coin");
  return x;
}

export function createLaunchFlow(d: LaunchDeps) {
  const now = d.now ?? Date.now;
  const key = launchKey(d.chainId, d.wallet);

  /** The record, or nothing; a record this browser cannot read, or of a shape it does not know, is an error. */
  function load(): LaunchIntent | undefined {
    let raw: string | null;
    let legacy: string | null;
    try {
      raw = d.storage.getItem(key);
      legacy = d.storage.getItem(legacyLaunchKey(d.chainId, d.wallet));
    } catch {
      throw new Error("this browser's storage cannot be read, so the last launch cannot be settled. nothing new is offered until it can.");
    }
    if (!raw && legacy) throw new Error("a launch record from an earlier version of this page exists for this wallet. it is kept as it is; settle that launch by its transaction on the chain explorer before launching again here.");
    if (!raw) return undefined;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      throw new Error("the saved launch record is damaged. it is kept as it is; nothing new is offered until it is settled by hand.");
    }
    try {
      return validateIntent(v, d.chainId, d.wallet);
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}. the record is kept; nothing new is offered until it is settled.`);
    }
  }

  /** Save, then read back; the record is written only when it is still what it was when it was read. */
  function save(v: LaunchIntent, expected?: LaunchIntent) {
    if (expected !== undefined) {
      const current = load();
      check(fingerprint(current) === fingerprint(expected), "the launch record changed while this step was waiting; the newer record stays and this result is dropped.");
    }
    const raw = JSON.stringify(v);
    d.storage.setItem(key, raw);
    check(d.storage.getItem(key) === raw, "this browser cannot keep the launch record durably. nothing is sent without one.");
  }

  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    check(d.locks, "this browser cannot hold a signing lock across tabs, so nothing is sent from it. use a current desktop browser.");
    return d.locks.request(lockName(d.chainId, d.wallet), fn);
  }

  /** Write the intent before the wallet opens. Refused while an earlier launch is unresolved. Under the lock. */
  async function begin(intent: Omit<LaunchIntent, "version" | "chainId" | "wallet" | "createdAt" | "status">): Promise<LaunchIntent> {
    return locked(async () => {
      const existing = load();
      check(!launchUnresolved(existing), "a launch by this wallet is not settled yet. it is settled first, by its receipt or its hash; nothing new is offered before that.");
      const v: LaunchIntent = { ...intent, version: 2, chainId: d.chainId, wallet: d.wallet, createdAt: now(), status: "prepared" };
      save(v, existing);
      return v;
    });
  }

  /** The prepared request's final nonce, fixed right before the wallet opens (an approval may have moved it). */
  function amend(fields: { nonce: number }): LaunchIntent {
    const v = load();
    check(v && v.status === "prepared", "no prepared launch to amend");
    const next: LaunchIntent = { ...v, ...fields };
    save(next, v);
    return next;
  }

  /** The hash the wallet returned for the prepared launch, written at once. */
  function markSent(hash: Hash): LaunchIntent {
    const v = load();
    check(v && v.status === "prepared", "no prepared launch to attach a hash to");
    check(isHash(hash), "the wallet returned no usable hash");
    const sent: LaunchIntent = { ...v, hash, status: "sent" };
    save(sent, v);
    return sent;
  }

  function matches(tx: Pick<LaunchTx, "from" | "to" | "input" | "nonce" | "value" | "chainId">, v: LaunchIntent) {
    check(same(tx.from, d.wallet) && same(tx.to, v.to) && same(tx.input, v.data), "that transaction is not this launch: sender, target or calldata differ.");
    check(tx.value === BigInt(v.value) && tx.nonce === v.nonce, "that transaction is not this launch: value or nonce differ.");
    check(tx.chainId === undefined || tx.chainId === d.chainId, "that transaction is on another chain.");
  }

  /**
   * The wallet repriced the sent transaction: the replacement is adopted only when it is the same launch (sender,
   * target, calldata, value, chain and nonce), and the hash the wallet first returned is kept alongside.
   */
  function replaced(replacement: Pick<LaunchTx, "hash" | "from" | "to" | "input" | "nonce" | "value" | "chainId">): LaunchIntent {
    const v = load();
    check(v && v.status === "sent" && v.hash, "no sent launch to replace");
    check(isHash(replacement.hash), "the replacement has no usable hash");
    if (same(replacement.hash, v.hash)) return v;
    matches(replacement, v);
    const next: LaunchIntent = { ...v, hash: replacement.hash, originalHash: v.originalHash ?? v.hash };
    save(next, v);
    return next;
  }

  /** The wallet's own pre-broadcast rejection: the one thing that removes a prepared launch. */
  function declined(): void {
    const v = load();
    if (v && v.status === "prepared") d.storage.removeItem(key);
  }

  /**
   * Settle a sent launch against the chain, under the lock: the transaction must be the reviewed one, the receipt in
   * a canonical block with one more on top, and the factory must have emitted the launch of the predicted coin in
   * it. The record is written only if it is still the one this settlement read; a delayed result for an older
   * record is dropped.
   */
  async function settle(receipt?: LaunchReceipt): Promise<{ record: LaunchIntent; state: "pending" | "waiting" | "confirming" | "launched" | "reverted" }> {
    return locked(async () => {
      const v = load();
      check(v && v.hash && (v.status === "sent" || v.status === "launched"), "no sent launch to settle");
      if (v.status === "launched" && v.token) return { record: v, state: "launched" };
      const tx = await d.reads.transaction(v.hash);
      if (!tx) return { record: v, state: "waiting" };
      matches(tx, v);
      const rc = receipt && same(receipt.transactionHash, v.hash) ? receipt : await d.reads.receipt(v.hash);
      if (!rc) return { record: v, state: "pending" };
      const block = await d.reads.block(rc.blockNumber);
      check(block && same(block.hash, rc.blockHash), "the receipt's block is no longer canonical. stop for review.");
      const head = await d.reads.blockNumber();
      if (head <= rc.blockNumber) return { record: v, state: "confirming" };
      if (rc.status !== "success") {
        const done: LaunchIntent = { ...v, status: "reverted" };
        save(done, v);
        return { record: done, state: "reverted" };
      }
      let token: Address | undefined;
      let poolId: Hex | undefined;
      for (const log of rc.logs) {
        if (!same(log.address, d.factory)) continue;
        try {
          const e = decodeEventLog({ abi: LAUNCHED, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
          if (e.eventName === "TokenLaunched" && same(e.args.deployer, d.wallet)) {
            token = e.args.token;
            poolId = e.args.poolId;
          }
        } catch {
          // another event of the factory's
        }
      }
      check(token, "the receipt carries no launch by this wallet from the factory. stop for review.");
      check(!v.predicted || same(token, v.predicted), "the receipt launched a different coin than the one reviewed. stop for review.");
      const done: LaunchIntent = { ...v, status: "launched", token, poolId, blockNumber: rc.blockNumber.toString(), blockHash: rc.blockHash };
      save(done, v);
      return { record: done, state: "launched" };
    });
  }

  /**
   * A hash the wallet showed: for a prepared launch whose answer was lost, or for a sent launch the wallet repriced.
   * Only the reviewed transaction is accepted. Under the lock.
   */
  async function recover(input: string): Promise<LaunchIntent> {
    return locked(async () => {
      const v = load();
      check(v && (v.status === "prepared" || v.status === "sent"), "there is no unresolved launch");
      const h = input.trim();
      check(isHash(h), "enter the public transaction hash, never a key");
      const tx = await d.reads.transaction(h as Hash);
      check(tx && same(tx.hash, h), "no transaction is visible at this hash yet");
      matches(tx, v);
      const current = load();
      check(fingerprint(current) === fingerprint(v), "the launch record changed while the hash was being checked");
      const next: LaunchIntent = v.status === "prepared" ? { ...v, hash: h as Hash, status: "sent" } : same(v.hash, h) ? v : { ...v, hash: h as Hash, originalHash: v.originalHash ?? v.hash };
      save(next, v);
      return next;
    });
  }

  /** A settled record (launched and handed on, or reverted and read) is cleared for the next launch. Under the lock. */
  async function clear(): Promise<void> {
    return locked(async () => {
      const v = load();
      check(!launchUnresolved(v), "the launch is not settled; the record stays");
      d.storage.removeItem(key);
    });
  }

  return { load, begin, amend, markSent, replaced, declined, settle, recover, clear, fingerprint: (v: LaunchIntent) => fingerprint(v) };
}

export type LaunchFlow = ReturnType<typeof createLaunchFlow>;
