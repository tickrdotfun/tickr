"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { DEPLOYED } from "@/lib/addresses";
import { POLL_MS } from "@/lib/constants";
import { loadMarket, type MarketData, type QuoteKind, type Row, type WindowKey, WINDOWS } from "@/lib/market";
import { useLaunches } from "./useLaunches";
import { useSnapshot } from "./useSnapshot";

export { WINDOWS };
export type { MarketData, QuoteKind, Row, WindowKey };

/**
 * Everything the home grid and the stats row need. The server's snapshot of the default window stands in until the
 * chain has answered, so a first visit paints at once.
 */
export function useMarketData(window: WindowKey = "all") {
  const client = usePublicClient();
  const launches = useLaunches();
  const snapshot = useSnapshot();
  const list = launches.data ?? [];
  const key = list.map((l) => l.token).join(",");

  return useQuery({
    queryKey: ["marketData", key, window],
    enabled: !!client && DEPLOYED,
    refetchInterval: POLL_MS * 2,
    placeholderData: (prev) => prev ?? (window === "all" ? snapshot.data?.market : undefined),
    queryFn: async (): Promise<MarketData> =>
      client
        ? loadMarket(client as Parameters<typeof loadMarket>[0], list, window)
        : { rows: [], tickersInvented: 0, totalVolumeUsd: 0, totalMarketCapUsd: 0, paidToCreatorsUsd: 0, coinsBurned: 0, pricedShare: 1, partial: false, cutoffBlock: 0n, blockTime: 2 },
  });
}
