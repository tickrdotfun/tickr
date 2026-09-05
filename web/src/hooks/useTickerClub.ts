"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { FactoryAbi, TickerLauncherAbi, TokenAbi } from "@/lib/abis";
import { ADDRESSES, isZero, sameAddr } from "@/lib/addresses";

export type ClubMember = {
  token: Address;
  symbol: string;
  creator: Address;
  volume: bigint; // this window
  lastVolume: bigint; // the window that just closed
  weight: number; // share of this window's volume, 0..1
  lastWeight: number;
  pot: bigint; // what this coin paid into the club this window
  lastPot: bigint;
};

/**
 * The ticker club for one wrapper: every coin under it, who has weight, and what the pots hold. Weight is pool
 * volume in the ticker over the current thirty-day window, booked when a coin's fees are collected.
 */
export function useTickerClub(ticker?: Address, member?: Address) {
  const client = usePublicClient();
  const enabled = !!client && !!ticker && !isZero(ADDRESSES.tickerLauncher);
  return useQuery({
    queryKey: ["ticker-club", ticker, member],
    enabled,
    staleTime: 15_000,
    queryFn: async () => {
      if (!client || !ticker) return null;
      const launcher = { abi: TickerLauncherAbi, address: ADDRESSES.tickerLauncher } as const;
      const [pairs, epoch, epochLen] = await Promise.all([
        client.readContract({ ...launcher, functionName: "pairsOf", args: [ticker] }) as Promise<readonly Address[]>,
        client.readContract({ ...launcher, functionName: "currentEpoch" }) as Promise<bigint>,
        client.readContract({ ...launcher, functionName: "EPOCH" }) as Promise<bigint>,
      ]);
      const last = epoch > 0n ? epoch - 1n : undefined;
      const per = 6;
      const reads = await client.multicall({
        contracts: pairs.flatMap((t) => [
          { abi: TokenAbi, address: t, functionName: "symbol" } as const,
          { abi: FactoryAbi, address: ADDRESSES.factory, functionName: "creatorFeeRecipientOf", args: [t] } as const,
          { ...launcher, functionName: "volumeOf", args: [t, epoch] } as const,
          { ...launcher, functionName: "volumeOf", args: [t, last ?? 0n] } as const,
          { ...launcher, functionName: "pot", args: [ticker, epoch, t] } as const,
          { ...launcher, functionName: "pot", args: [ticker, last ?? 0n, t] } as const,
        ]),
        allowFailure: true,
      });
      const at = (i: number, k: number) => {
        const r = reads[i * per + k];
        return r && r.status === "success" ? r.result : undefined;
      };
      const rows = pairs.map((t, i) => ({
        token: t,
        symbol: (at(i, 0) as string | undefined) ?? "?",
        creator: (at(i, 1) as Address | undefined) ?? ("0x0000000000000000000000000000000000000000" as Address),
        volume: (at(i, 2) as bigint | undefined) ?? 0n,
        lastVolume: last === undefined ? 0n : ((at(i, 3) as bigint | undefined) ?? 0n),
        pot: (at(i, 4) as bigint | undefined) ?? 0n,
        lastPot: last === undefined ? 0n : ((at(i, 5) as bigint | undefined) ?? 0n),
      }));
      const total = rows.reduce((s, r) => s + r.volume, 0n);
      const lastTotal = rows.reduce((s, r) => s + r.lastVolume, 0n);
      const share = (v: bigint, t: bigint) => (t > 0n ? Number((v * 10_000n) / t) / 10_000 : 0);
      const members: ClubMember[] = rows.map((r) => ({ ...r, weight: share(r.volume, total), lastWeight: share(r.lastVolume, lastTotal) }));

      // what the coin on this page could claim from the window that just closed
      let claimable = 0n;
      if (member && last !== undefined && members.some((m) => sameAddr(m.token, member) && m.lastVolume > 0n)) {
        claimable = (await client
          .readContract({ ...launcher, functionName: "claimable", args: [member, pairs, last] })
          .catch(() => 0n)) as bigint;
      }
      return {
        epoch,
        last,
        windowEndsAt: Number((epoch + 1n) * epochLen),
        members,
        payers: pairs as Address[],
        totalVolume: total,
        lastTotalVolume: lastTotal,
        potNow: rows.reduce((s, r) => s + r.pot, 0n),
        potLast: rows.reduce((s, r) => s + r.lastPot, 0n),
        claimable,
      };
    },
  });
}
