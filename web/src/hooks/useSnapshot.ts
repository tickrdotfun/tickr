"use client";

import { useQuery } from "@tanstack/react-query";
import { DEPLOYED } from "@/lib/addresses";
import { deserialize } from "@/lib/bigjson";
import { DEMO } from "@/lib/demoTransport";
import type { Launch } from "@/lib/launches";
import type { MarketData } from "@/lib/market";

export type Snapshot = { at: number; launches: Launch[]; market: MarketData };

/** The server's snapshot of the home data, a few seconds old at most: one request, so a first visit paints at once. */
export function useSnapshot() {
  return useQuery({
    queryKey: ["snapshot"],
    // off with the server side until the site has a node of its own; see the route
    enabled: false && DEPLOYED && !DEMO,
    staleTime: 10_000,
    retry: false,
    queryFn: async (): Promise<Snapshot | undefined> => {
      // a snapshot that is slow is worth less than the chain reads already running: four seconds, then never mind
      const r = await fetch("/api/snapshot", { cache: "no-store", signal: AbortSignal.timeout(4_000) });
      if (!r.ok) return undefined;
      return deserialize<Snapshot>(await r.text());
    },
  });
}
