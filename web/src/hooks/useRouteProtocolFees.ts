"use client";

import { useReadContracts } from "wagmi";
import type { Hex } from "viem";
import { ADDRESSES, isZero } from "@/lib/addresses";
import { poolManagerAbi } from "@/lib/extraAbis";
import { protocolFeeFromSlot0, slot0Slot } from "@/lib/pool";
import { idOf, type Hop } from "@/lib/route";
import { hopDirections, protocolFeePips } from "@/lib/quote";

/**
 * Uniswap's own protocol fee for each pool on a route, in the direction that route trades it.
 *
 * It is taken off the input before the pool's own fee applies, so a route total that leaves it out is a lower
 * bound rather than the cost. Reading it is one storage word per pool.
 *
 * Every entry is `undefined` until its read comes back, and stays `undefined` if it fails. A missing value is
 * never turned into a zero: `routeFees` treats an unread fee as unknown and says so.
 */
export function useRouteProtocolFees(path: Hop[] | undefined, from: string | undefined) {
  const hops = path ?? [];
  const dirs = from !== undefined ? hopDirections(hops, from) : hops.map(() => undefined);
  const reads = hops
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => h.kind === 0 && dirs[i] !== undefined)
    .map(({ h }) => ({ abi: poolManagerAbi, address: ADDRESSES.poolManager, functionName: "extsload", args: [slot0Slot(idOf(h.key))] }) as const);

  const q = useReadContracts({
    contracts: reads,
    query: { enabled: reads.length > 0 && !isZero(ADDRESSES.poolManager), staleTime: 60_000 },
  });

  const byHop: (number | undefined)[] = hops.map(() => undefined);
  let r = 0;
  hops.forEach((h, i) => {
    if (h.kind !== 0 || dirs[i] === undefined) {
      // a wrap hop charges nothing at all, which is known rather than unread
      if (h.kind === 2) byHop[i] = 0;
      return;
    }
    const got = q.data?.[r];
    r++;
    if (got?.status !== "success") return;
    try {
      byHop[i] = protocolFeePips(protocolFeeFromSlot0(got.result as Hex), dirs[i] as boolean);
    } catch {
      // a pool reporting something impossible is left unread rather than believed
    }
  });

  return { byHop, loading: q.isLoading, complete: byHop.every((v) => v !== undefined) };
}
