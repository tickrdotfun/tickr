import type { Address, Hash, Hex } from "viem";

/**
 * A wallet's record of the launch it is making, kept in this browser before the wallet opens: the seed that fixes
 * the coin's address, what the launch is, the transaction hash the moment the wallet returns it, and the coin once
 * its receipt has been read. A page that reloads finds the record and reconciles it before it offers a new launch,
 * so a lost wallet answer or a read that failed after the broadcast cannot turn into a second coin and a second fee.
 */
export type LaunchIntent = {
  version: 1;
  chainId: number;
  wallet: Address;
  /** the salt seed the address was ground from: the same seed on a retry is the same address, which cannot deploy twice */
  seed: Hex;
  predicted?: Address;
  label: string;
  /** what the launch is priced in, and whether that is an invented name that needs the two activation buys */
  isTicker: boolean;
  tickerSymbol?: string;
  createdAt: number;
  /** the hash the wallet returned; absent while the answer is unknown */
  hash?: Hash;
  /** the coin, once a successful receipt was read */
  token?: Address;
  poolId?: Hex;
  blockNumber?: string;
  status: "prepared" | "sent" | "launched" | "reverted" | "declined";
};

export const launchKey = (chainId: number, wallet: Address) => `tickr.launch.v1.${chainId}.${wallet.toLowerCase()}`;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function loadLaunch(s: Pick<Storage, "getItem">, chainId: number, wallet: Address): LaunchIntent | undefined {
  const raw = s.getItem(launchKey(chainId, wallet));
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as LaunchIntent;
    if (!v || v.version !== 1 || v.chainId !== chainId || v.wallet.toLowerCase() !== wallet.toLowerCase() || !v.seed) return undefined;
    return v;
  } catch {
    return undefined;
  }
}

/** Save, then read back: a write that did not land is a stop, never a reason to open the wallet. */
export function saveLaunch(s: Store, v: LaunchIntent) {
  const key = launchKey(v.chainId, v.wallet);
  const raw = JSON.stringify(v);
  s.setItem(key, raw);
  if (s.getItem(key) !== raw) throw new Error("this browser cannot keep the launch record durably. nothing is sent without one.");
}

/** A finished record (launched and handed on, or declined) is cleared so the next launch starts clean. */
export function clearLaunch(s: Store, chainId: number, wallet: Address) {
  s.removeItem(launchKey(chainId, wallet));
}

/** Whether a record still needs the chain's answer before another launch may be prepared. */
export const launchUnresolved = (v?: LaunchIntent) => !!v && (v.status === "prepared" || v.status === "sent" || (v.status === "launched" && !v.token));
