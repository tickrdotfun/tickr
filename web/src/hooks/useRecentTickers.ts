"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { useTickers } from "./useTickers";
import { useLaunches } from "./useLaunches";

export type RecentTicker = { ticker: string; quoteToken: `0x${string}`; createdAt?: number; isNew: boolean };

/** The newest invented tickers, dated by the first launch priced in each: a ticker is created inside that launch. */
export function useRecentTickers(limit = 6) {
  const client = usePublicClient();
  const quotes = useTickers();
  const launches = useLaunches();
  const ready = !!client && !!quotes.data && !!launches.data;
  return useQuery({
    queryKey: ["recentTickers", limit, quotes.data?.map((q) => q.quoteToken).join(","), launches.data?.length],
    enabled: ready,
    staleTime: 30_000,
    queryFn: async (): Promise<RecentTicker[]> => {
      if (!client || !quotes.data || !launches.data) return [];
      // the earliest launch under each ticker is the one that created it
      const firstUnder = new Map<string, bigint>();
      for (const l of launches.data) {
        if (l.blockNumber === undefined) continue;
        const k = l.pairToken.toLowerCase();
        const prev = firstUnder.get(k);
        if (prev === undefined || l.blockNumber < prev) firstUnder.set(k, l.blockNumber);
      }
      const rows = quotes.data
        .map((q) => ({ ticker: q.ticker, quoteToken: q.quoteToken, block: firstUnder.get(q.quoteToken.toLowerCase()) }))
        .sort((a, b) => Number((b.block ?? 0n) - (a.block ?? 0n)))
        .slice(0, limit);
      const times = await Promise.all(
        rows.map(async (r) => {
          if (r.block === undefined) return undefined;
          try {
            const b = await client.getBlock({ blockNumber: r.block });
            return Number(b.timestamp);
          } catch {
            return undefined;
          }
        }),
      );
      const now = Date.now() / 1000;
      return rows.map((r, i) => ({ ticker: r.ticker, quoteToken: r.quoteToken, createdAt: times[i], isNew: times[i] !== undefined && now - times[i] < 86_400 }));
    },
  });
}
