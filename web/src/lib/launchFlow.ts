import { decodeEventLog, parseAbi, type Address, type Hash, type Hex } from "viem";
import { fingerprint, isHash, lockName, same } from "./activation";

/**
 * The creation workflow with everything outside it injected, like the activation's: one launch per wallet at a
 * time, its intent written before the wallet opens, the hash the moment the wallet returns it, and the receipt
 * settled against that intent: the factory's own `TokenLaunched` for the predicted coin, or nothing.
 *
 * The rules:
 *   - an unresolved launch (prepared, sent, or launched but not yet read) blocks a new one; there is no dismissal
 *     of an unknown outcome: it resolves by its hash, or by the wallet's own pre-broadcast rejection;
 *   - a recovered transaction must be the reviewed one: sender, target, calldata, value, chain and nonce;
 *   - a receipt settles the launch only when the factory emitted the launch of the predicted coin in it;
 *   - a record this browser cannot read is unresolved, not absent;
 *   - one signing lock per wallet across tabs, shared with the activation; no lock manager, no signing.
 */

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
  status: "prepared" | "sent" | "launched" | "reverted";
  hash?: Hash;
  token?: Address;
  poolId?: Hex;
  blockNumber?: string;
};

export type LaunchTx = { hash: Hash; from: Address; to: Address | null; input: Hex; nonce: number; value: bigint; chainId?: number };
export type LaunchReceipt = { transactionHash: Hash; blockNumber: bigint; status: "success" | "reverted"; logs: { address: Address; topics: Hex[]; data: Hex }[] };
export type LaunchReads = { transaction(hash: Hash): Promise<LaunchTx | null>; receipt(hash: Hash): Promise<LaunchReceipt | null> };
export type Locks = { request<T>(name: string, fn: () => Promise<T>): Promise<T> } | undefined;
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type LaunchDeps = { chainId: number; wallet: Address; factory: Address; storage: Store; reads: LaunchReads; locks: Locks; now?: () => number };

const LAUNCHED = parseAbi(["event TokenLaunched(address indexed token, bytes32 indexed poolId, address indexed deployer, address pairToken, uint256 launchConfigId, uint24 poolFee, uint256 phantomQuote)"]);

export const launchKey = (chainId: number, wallet: Address) => `tickr.launch.v2.${chainId}.${wallet.toLowerCase()}`;
export const launchUnresolved = (v?: LaunchIntent) => !!v && (v.status === "prepared" || v.status === "sent" || (v.status === "launched" && !v.token));

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

export function createLaunchFlow(d: LaunchDeps) {
  const now = d.now ?? Date.now;
  const key = launchKey(d.chainId, d.wallet);

  /** The record, or nothing; a record this browser cannot read is an error, never "nothing". */
  function load(): LaunchIntent | undefined {
    let raw: string | null;
    try {
      raw = d.storage.getItem(key);
    } catch {
      throw new Error("this browser's storage cannot be read, so the last launch cannot be settled. nothing new is offered until it can.");
    }
    if (!raw) return undefined;
    let v: LaunchIntent;
    try {
      v = JSON.parse(raw) as LaunchIntent;
    } catch {
      throw new Error("the saved launch record is damaged. it is kept as it is; nothing new is offered until it is settled by hand.");
    }
    check(v && v.version === 2 && v.chainId === d.chainId && same(v.wallet, d.wallet) && /^0x[0-9a-f]{64}$/i.test(v.seed) && typeof v.to === "string" && typeof v.data === "string" && Number.isInteger(v.nonce), "the saved launch record is not this wallet's, or is incomplete. it is kept; nothing new is offered until it is settled.");
    return v;
  }

  function save(v: LaunchIntent) {
    const raw = JSON.stringify(v);
    d.storage.setItem(key, raw);
    check(d.storage.getItem(key) === raw, "this browser cannot keep the launch record durably. nothing is sent without one.");
  }

  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    check(d.locks, "this browser cannot hold a signing lock across tabs, so nothing is sent from it. use a current desktop browser.");
    return d.locks.request(lockName(d.chainId, d.wallet), fn);
  }

  /** Write the intent before the wallet opens. Refused while an earlier launch is unresolved. */
  async function begin(intent: Omit<LaunchIntent, "version" | "chainId" | "wallet" | "createdAt" | "status">): Promise<LaunchIntent> {
    return locked(async () => {
      const existing = load();
      check(!launchUnresolved(existing), "a launch by this wallet is not settled yet. it is settled first, by its receipt or its hash; nothing new is offered before that.");
      const v: LaunchIntent = { ...intent, version: 2, chainId: d.chainId, wallet: d.wallet, createdAt: now(), status: "prepared" };
      save(v);
      return v;
    });
  }

  /** The hash the wallet returned for the prepared launch, written at once. */
  function markSent(hash: Hash): LaunchIntent {
    const v = load();
    check(v && v.status === "prepared", "no prepared launch to attach a hash to");
    check(isHash(hash), "the wallet returned no usable hash");
    const sent: LaunchIntent = { ...v, hash, status: "sent" };
    save(sent);
    return sent;
  }

  /** The wallet's own pre-broadcast rejection: the one thing that removes a prepared launch. */
  function declined(): void {
    const v = load();
    if (v && v.status === "prepared") d.storage.removeItem(key);
  }

  function matches(tx: LaunchTx, v: LaunchIntent) {
    check(same(tx.from, d.wallet) && same(tx.to, v.to) && same(tx.input, v.data), "that transaction is not this launch: sender, target or calldata differ.");
    check(tx.value === BigInt(v.value) && tx.nonce === v.nonce, "that transaction is not this launch: value or nonce differ.");
    check(tx.chainId === undefined || tx.chainId === d.chainId, "that transaction is on another chain.");
  }

  /**
   * Settle a sent launch against the chain: the transaction must be the reviewed one, the receipt canonical, and the
   * factory must have emitted the launch of the predicted coin in it. Returns the record after the reads.
   */
  async function settle(receipt?: LaunchReceipt): Promise<{ record: LaunchIntent; state: "pending" | "waiting" | "launched" | "reverted" }> {
    const v = load();
    check(v && v.hash, "no sent launch to settle");
    const tx = await d.reads.transaction(v.hash);
    if (!tx) return { record: v, state: "waiting" };
    matches(tx, v);
    const rc = receipt && same(receipt.transactionHash, v.hash) ? receipt : await d.reads.receipt(v.hash);
    if (!rc) return { record: v, state: "pending" };
    if (rc.status !== "success") {
      const done: LaunchIntent = { ...v, status: "reverted" };
      save(done);
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
    const done: LaunchIntent = { ...v, status: "launched", token, poolId, blockNumber: rc.blockNumber.toString() };
    save(done);
    return { record: done, state: "launched" };
  }

  /** A hash the wallet showed for a prepared launch whose answer was lost: only the reviewed transaction is accepted. */
  async function recover(input: string): Promise<LaunchIntent> {
    return locked(async () => {
      const v = load();
      check(v && v.status === "prepared", "there is no unresolved launch");
      const h = input.trim();
      check(isHash(h), "enter the public transaction hash, never a key");
      const tx = await d.reads.transaction(h as Hash);
      check(tx && same(tx.hash, h), "no transaction is visible at this hash yet");
      matches(tx, v);
      const sent: LaunchIntent = { ...v, hash: h as Hash, status: "sent" };
      save(sent);
      return sent;
    });
  }

  /** A settled record (launched and handed on, or reverted and read) is cleared for the next launch. */
  function clear() {
    const v = load();
    check(!launchUnresolved(v), "the launch is not settled; the record stays");
    d.storage.removeItem(key);
  }

  return { load, begin, markSent, declined, settle, recover, clear, fingerprint: (v: LaunchIntent) => fingerprint(v) };
}

export type LaunchFlow = ReturnType<typeof createLaunchFlow>;
