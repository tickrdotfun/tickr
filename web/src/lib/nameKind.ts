import { parseAbi, type Abi, type Address } from "viem";

import { ADDRESSES, isZero, sameAddr } from "./addresses";
import type { NameSpec } from "./activation";

/**
 * What a name is, worked out from the contracts that issue names, and never from its address or its pool.
 *
 * Two kinds exist. A wrapper is issued by the ticker launcher and redeems a dollar for a dollar. A market is
 * issued by the market deployer and has a price. They route differently, they are quoted differently and their
 * pools do not look alike, so getting this wrong is not a cosmetic error: it prices a trade by the wrong rule.
 *
 * There is deliberately no default. A name neither issuer claims, or a read that did not come back, leaves the
 * caller blocked. Guessing "wrapper" for a market would send a buy through a mint that does not exist; guessing
 * "market" for a wrapper would look for a pool that is not there. Both are worse than saying so.
 */

export const LAUNCHER_ABI = parseAbi(["function isTicker(address) view returns (bool)"]);
export const MARKET_DEPLOYER_ABI = parseAbi([
  "function market(address) view returns ((address token,address locker,uint256 tokenId,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint256 supply,int24 tickLower,int24 tickUpper))",
  "function keyFor(address) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))",
  "function fee() view returns (uint24)",
  "function spacing() view returns (int24)",
]);

/** The four reads a classification needs. Each may reject; a rejection is a blocked answer, never a "no". */
export type NameReads = {
  /** Does the ticker launcher claim to have issued this name? */
  isTicker(name: Address): Promise<boolean>;
  /** The token the market issuer says it made at this address, or the zero address if it made none. */
  marketToken(name: Address): Promise<Address>;
  /** The market issuer's own fee and tick spacing, which every market it makes is opened with. */
  marketParams(): Promise<{ fee: number; tickSpacing: number }>;
};

export class NameUnresolved extends Error {}

/** Thrown, not returned, so a caller cannot carry on with an answer it never got. */
const unresolved = (name: Address, why: string): never => {
  throw new NameUnresolved(`cannot tell what ${name} is: ${why}`);
};

export async function resolveNameSpec(reads: NameReads, name: Address): Promise<NameSpec> {
  if (!name || isZero(name)) return unresolved(name, "no name was given");

  let launcherSaid: boolean;
  try {
    launcherSaid = await reads.isTicker(name);
  } catch (e) {
    return unresolved(name, `the ticker launcher could not be read (${(e as Error)?.message ?? e})`);
  }
  if (launcherSaid) return { kind: "legacy" };

  // not a wrapper. That is not yet an answer: it has to be a market, proved by its issuer, or nothing
  if (isZero(ADDRESSES.marketTickerDeployer)) return unresolved(name, "no market issuer is wired, and the ticker launcher did not issue it");

  let issued: Address;
  try {
    issued = await reads.marketToken(name);
  } catch (e) {
    return unresolved(name, `the market issuer could not be read (${(e as Error)?.message ?? e})`);
  }
  if (!sameAddr(issued, name)) return unresolved(name, "neither issuer made it");

  let params: { fee: number; tickSpacing: number };
  try {
    params = await reads.marketParams();
  } catch (e) {
    return unresolved(name, `the market issuer's pool settings could not be read (${(e as Error)?.message ?? e})`);
  }
  if (!Number.isInteger(params.fee) || params.fee <= 0 || params.fee >= 1_000_000) return unresolved(name, `the market issuer reported an impossible fee (${params.fee})`);
  if (!Number.isInteger(params.tickSpacing) || params.tickSpacing <= 0 || params.tickSpacing > 32_767) return unresolved(name, `the market issuer reported an impossible tick spacing (${params.tickSpacing})`);
  return { kind: "market", fee: params.fee, tickSpacing: params.tickSpacing };
}

type Reader = {
  readContract(args: { abi: Abi; address: Address; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
};

/** The reads above, against a viem client. Bounded by whatever the caller wraps them in. */
export function nameReadsFrom(client: Reader, bound: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn()): NameReads {
  return {
    isTicker: (name) =>
      bound(async () =>
        isZero(ADDRESSES.tickerLauncher)
          ? false
          : ((await client.readContract({ abi: LAUNCHER_ABI as Abi, address: ADDRESSES.tickerLauncher, functionName: "isTicker", args: [name] })) as boolean),
      ),
    marketToken: (name) =>
      bound(async () => {
        const m = (await client.readContract({ abi: MARKET_DEPLOYER_ABI as Abi, address: ADDRESSES.marketTickerDeployer, functionName: "market", args: [name] })) as { token: Address };
        return m.token;
      }),
    marketParams: () =>
      bound(async () => {
        const [fee, spacing] = (await Promise.all([
          client.readContract({ abi: MARKET_DEPLOYER_ABI as Abi, address: ADDRESSES.marketTickerDeployer, functionName: "fee" }),
          client.readContract({ abi: MARKET_DEPLOYER_ABI as Abi, address: ADDRESSES.marketTickerDeployer, functionName: "spacing" }),
        ])) as [number | bigint, number | bigint];
        return { fee: Number(fee), tickSpacing: Number(spacing) };
      }),
  };
}
