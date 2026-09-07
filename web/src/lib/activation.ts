import type { Address, Hash, Hex } from "viem";
import { ADDRESSES, ZERO, isZero, sameAddr } from "./addresses";
import { ethUsdgKey, keyOf, v4Hop, type Hop, type V4Key } from "./route";

/**
 * Activation: the two buys that follow a launch.
 *
 * Chart sites and trackers price an invented name from a swap that lands in a wallet after the name's pool
 * exists, and price a coin from a buy after its pool exists. The launch transaction is neither. So a coin is not
 * finished until, in transactions after the launch, its name has been bought into a wallet through the name's own
 * pool (once per name, ever) and the coin itself has been bought. The site does both from the create page, and
 * shows a coin as not activated until they have landed. The coin trades normally on tickr either way.
 */

/** What each activation buy spends, in dollars, before the wallet's own rounding. */
export const ACTIVATION_USD = 20;

/** The one hook every name's pool runs behind, and the pool's fixed terms. */
export const MANAGED_FEE = 500;
export const MANAGED_TICK_SPACING = 1;

/** A name's own pool against USDG. */
export function managedKey(ticker: Address): V4Key {
  return keyOf(ticker, ADDRESSES.usdg, MANAGED_FEE, MANAGED_TICK_SPACING, ADDRESSES.managedTickerHook);
}

/** ETH into the name itself, through the live ETH/USDG pool and the name's own pool. */
export function tickerBuyPath(ticker: Address): Hop[] {
  return [v4Hop(ethUsdgKey()), v4Hop(managedKey(ticker))];
}

/** ETH into a coin under a name, through the name's own pool rather than by wrapping, so the trade is a trade. */
export function coinActivationPath(ticker: Address, own: V4Key): Hop[] {
  return [...tickerBuyPath(ticker), v4Hop(own)];
}

export function zapTickerParams(ticker: Address, path: Hop[], recipient: Address, minOut = 0n) {
  return {
    ticker,
    tokenIn: ZERO,
    amountIn: 0n,
    path,
    minOut,
    recipient,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 20 * 60),
  };
}

/** Wei that buys about `usd` dollars at `ethUsd`, rounded to a readable amount; a floor keeps a broken rate from sending dust. */
export function activationWei(ethUsd: number | null | undefined, usd = ACTIVATION_USD): bigint {
  const rate = ethUsd && ethUsd > 0 ? ethUsd : 4_000;
  const eth = usd / rate;
  // four significant digits, never below a ten-thousandth of an ETH
  const rounded = Math.max(0.0001, Number(eth.toPrecision(4)));
  return BigInt(Math.round(rounded * 1e18));
}

// ---------------------------------------------------------------- the intent, persisted

export type ActivationStage = "ticker" | "coin" | "done";

/**
 * Where a wallet is in a coin's activation, kept in this browser so a reload, a closed tab or a wallet that lost
 * the page resumes rather than resends. A hash recorded before the receipt is known is recovered, never resent.
 */
export type ActivationIntent = {
  coin: Address;
  ticker: Address | null;
  wallet: Address;
  stage: ActivationStage;
  /** the transaction of the current stage once the wallet returned it, until its receipt is known */
  pending?: Hash;
  tickerHash?: Hash;
  coinHash?: Hash;
  updatedAt: number;
};

const KEY = (chainId: number, coin: Address) => `tickr.activation.${chainId}.${coin.toLowerCase()}`;

export function loadIntent(chainId: number, coin: Address): ActivationIntent | undefined {
  try {
    const raw = window.localStorage.getItem(KEY(chainId, coin));
    if (!raw) return undefined;
    const v = JSON.parse(raw) as ActivationIntent;
    if (!v || !v.wallet || !v.stage) return undefined;
    return v;
  } catch {
    return undefined;
  }
}

export function saveIntent(chainId: number, intent: ActivationIntent) {
  try {
    window.localStorage.setItem(KEY(chainId, intent.coin), JSON.stringify({ ...intent, updatedAt: Date.now() }));
  } catch {
    // storage unavailable: the page still works, it just cannot resume after a reload
  }
}

export function clearIntent(chainId: number, coin: Address) {
  try {
    window.localStorage.removeItem(KEY(chainId, coin));
  } catch {
    // nothing to clear
  }
}

/** A cached "already activated" answer: activation is one way, so a true answer never needs reading again. */
const DONE_KEY = (chainId: number, what: Address) => `tickr.activated.${chainId}.${what.toLowerCase()}`;

export function rememberActivated(chainId: number, what: Address) {
  try {
    window.localStorage.setItem(DONE_KEY(chainId, what), "1");
  } catch {
    // fine
  }
}

export function recallActivated(chainId: number, what: Address): boolean {
  try {
    return window.localStorage.getItem(DONE_KEY(chainId, what)) === "1";
  } catch {
    return false;
  }
}

/** The one activation at a time a wallet may run in this tab: a second click waits for the first to finish. */
const locks = new Map<string, Promise<unknown>>();
export async function serialised<T>(wallet: Address, work: () => Promise<T>): Promise<T> {
  const k = wallet.toLowerCase();
  const prev = locks.get(k) ?? Promise.resolve();
  const next = prev.then(work, work);
  locks.set(k, next.catch(() => undefined));
  try {
    return await next;
  } finally {
    if (locks.get(k) === next.catch(() => undefined)) locks.delete(k);
  }
}

export const isManagedHookWired = () => !isZero(ADDRESSES.managedTickerHook);
export const sameCoin = (a?: string, b?: string) => sameAddr(a, b);
export type { Hex };
