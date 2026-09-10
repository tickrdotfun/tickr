"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { ADDRESSES, DEPLOYED } from "@/lib/addresses";
import { POLL_MS } from "@/lib/constants";
import { loadLaunches, type Launch } from "@/lib/launches";
import { useSnapshot } from "./useSnapshot";

export type { Launch };

/** All launches, newest first. The server's snapshot stands in until the chain has answered. */
export function useLaunches() {
  const client = usePublicClient();
  const snapshot = useSnapshot();
  return useQuery({
    queryKey: ["launches", ADDRESSES.factory],
    enabled: !!client && DEPLOYED,
    refetchInterval: POLL_MS * 3,
    placeholderData: (prev) => prev ?? snapshot.data?.launches,
    queryFn: async (): Promise<Launch[]> => (client ? loadLaunches(client as PublicClientLike) : []),
  });
}
type PublicClientLike = Parameters<typeof loadLaunches>[0];
