import type { Address } from "viem";

/**
 * Addresses the public site does not list.
 *
 * A test coin on the live chain is still a real coin: it launches, it emits the same event and every list the
 * site builds would pick it up. This is the one place that says which ones are ours and are not to be shown.
 *
 * Held **by chain id and address**, never by name or symbol. A symbol is not an identity: anybody can launch a
 * coin called the same thing, and hiding by name would hide theirs and miss a rename of ours.
 *
 * What this is not: it is not a block. The coin exists, its own page still opens if somebody has the address,
 * and it trades normally. This only keeps it out of the lists the site publishes.
 */
export type Hidden = { chainId: number; address: Address; note: string };

/**
 * Predicted before they exist, which is the point: an address can be listed here and the exclusion verified
 * before anything is launched, so nothing appears publicly even briefly.
 */
export const HIDDEN: readonly Hidden[] = [
  {
    chainId: 4663,
    address: "0x6C92c9AD7cE9Cf22db3Ea0447836eFB38e811698",
    // the acceptance run's name. A name is not launched through a configuration, so the rule below does not
    // reach it and it has to be listed by address. Its two coins are covered both ways: by that rule, and by
    // this entry, since a coin priced in a hidden name is dropped too
    note: "acceptance run, test name",
  },
  {
    chainId: 4663,
    address: "0x56B12107948F0cF01684454CAdb92d6BFA2299b5",
    note: "acceptance run, coin A",
  },
  {
    chainId: 4663,
    address: "0x400D1CDE38775AF5Ee5Db600d6852a30DddeEc6A",
    note: "acceptance run, coin B",
  },
] as const;

/**
 * Launch configurations whose coins are not listed, whatever address they land at.
 *
 * Predicting a coin's address works, but it depends on the creator's nonce not moving between the prediction
 * and the launch. If anything else is sent from that wallet first, the prediction is stale and the exclusion
 * misses the very coin it was written for, silently.
 *
 * A configuration id cannot drift that way. It is known from `LaunchConfigAdded` before any coin exists, and it
 * catches every coin launched on it. The addresses above stay as the belt to this brace, and the name still has
 * to be listed by address because a name is not launched through a configuration.
 */
export type HiddenConfig = { chainId: number; launchConfigId: bigint; note: string };

export const HIDDEN_CONFIGS: readonly HiddenConfig[] = [
  {
    chainId: 4663,
    launchConfigId: 1n,
    // the 82 bps acceptance configuration, added 2026-09-09 and verified on chain as baseFeeBps 82, enabled,
    // with config 0's supply and reserve. Entered here before any coin was launched on it, which is what keeps
    // those coins out of every public list from the moment they exist
    note: "acceptance run, 82 bps test configuration",
  },
] as const;

const CONFIGS = new Set(HIDDEN_CONFIGS.map((c) => `${c.chainId}:${c.launchConfigId.toString()}`));

/** Whether coins launched on this configuration are kept out of the site's lists. */
export function isHiddenConfig(chainId: number, launchConfigId?: bigint | number | null): boolean {
  return launchConfigId !== undefined && launchConfigId !== null && CONFIGS.has(`${chainId}:${BigInt(launchConfigId).toString()}`);
}

const key = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;
const SET = new Set(HIDDEN.map((h) => key(h.chainId, h.address)));

/** Whether this exact address on this exact chain is kept out of the site's lists. */
export function isHidden(chainId: number, address?: string | null): boolean {
  return !!address && SET.has(key(chainId, address));
}

/** Drop hidden entries from any list, by whichever field carries the address. */
export function withoutHidden<T>(chainId: number, rows: readonly T[], addressOf: (row: T) => string | undefined): T[] {
  return rows.filter((r) => !isHidden(chainId, addressOf(r)));
}
