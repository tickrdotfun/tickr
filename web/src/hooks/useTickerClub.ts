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
  weight: number; // share of this window's total weight, 0..1; the captain's volume counts twice
  lastWeight: number;
  pot: bigint; // what this coin paid into the club this window
  lastPot: bigint;
  captain: boolean; // captain this window: the founder's coin while it trades, else the biggest coin
  lastCaptain: boolean;
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
      // the captain counts double: the founder's coin while it trades, else the coin with the most volume
      const [captain, lastCaptain] = await Promise.all([
        client.readContract({ ...launcher, functionName: "captainOf", args: [ticker, epoch] }).catch(() => undefined) as Promise<Address | undefined>,
        last === undefined ? Promise.resolve(undefined) : (client.readContract({ ...launcher, functionName: "captainOf", args: [ticker, last] }).catch(() => undefined) as Promise<Address | undefined>),
      ]);
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
        captain: !!captain && sameAddr(t, captain),
        lastCaptain: !!lastCaptain && sameAddr(t, lastCaptain),
      }));
      const total = rows.reduce((s, r) => s + r.volume, 0n);
      const lastTotal = rows.reduce((s, r) => s + r.lastVolume, 0n);
      // weights as the contract splits a pot: a coin's volume, twice for the captain, over the sum of all of them
      const w = (r: (typeof rows)[number]) => (r.captain ? r.volume * 2n : r.volume);
      const lw = (r: (typeof rows)[number]) => (r.lastCaptain ? r.lastVolume * 2n : r.lastVolume);
      const totalW = rows.reduce((s, r) => s + w(r), 0n);
      const lastTotalW = rows.reduce((s, r) => s + lw(r), 0n);
      const share = (v: bigint, t: bigint) => (t > 0n ? Number((v * 10_000n) / t) / 10_000 : 0);
      const members: ClubMember[] = rows.map((r) => ({ ...r, weight: share(w(r), totalW), lastWeight: share(lw(r), lastTotalW) }));

      // what the coin on this page could claim from the window that just closed, and from the closed windows before
      // it: a pot is claimable for as long as it has not been taken, so the last twelve are asked
      let claimable = 0n;
      let historyPartial = false;
      let historyOlder = false;
      const claimableByEpoch: { epoch: bigint; amount: bigint }[] = [];
      if (member && last !== undefined) {
        // from the window the coin launched in, so nothing it earned is ever out of reach; capped at sixty windows
        const born = await client.readContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "getLaunchedToken", args: [member] }).catch(() => undefined);
        const bornEpoch = born && epochLen > 0n ? BigInt(born.launchedAt) / epochLen : 0n;
        const first = last - bornEpoch > 59n ? last - 59n : bornEpoch;
        const epochs: bigint[] = [];
        for (let e = first; e <= last; e++) epochs.push(e);
        const vols = await client.multicall({ contracts: epochs.map((e) => ({ ...launcher, functionName: "volumeOf", args: [member, e] }) as const), allowFailure: true });
        const asked = epochs.filter((_, i) => vols[i].status === "success" && (vols[i].result as bigint) > 0n);
        const amounts = await Promise.all(asked.map((e) => (client.readContract({ ...launcher, functionName: "claimable", args: [member, pairs, e] }).catch(() => undefined)) as Promise<bigint | undefined>));
        asked.forEach((e, i) => {
          const a = amounts[i];
          if (a === undefined) {
            historyPartial = true; // a window that could not be read is not a window with nothing owed
            return;
          }
          if (e === last) claimable = a;
          else if (a > 0n) claimableByEpoch.push({ epoch: e, amount: a });
        });
        if (vols.some((v) => v.status !== "success")) historyPartial = true;
        if (bornEpoch < first) historyOlder = true; // windows before the sixty asked are still claimable on the contract
      }
      return {
        epoch,
        last,
        windowEndsAt: Number((epoch + 1n) * epochLen),
        members,
        payers: pairs as Address[],
        totalVolume: total,
        lastTotalVolume: lastTotal,
        captain,
        lastCaptain,
        potNow: rows.reduce((s, r) => s + r.pot, 0n),
        potLast: rows.reduce((s, r) => s + r.lastPot, 0n),
        claimable,
        claimableByEpoch,
        historyPartial,
        historyOlder,
      };
    },
  });
}
