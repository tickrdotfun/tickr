"use client";

import { useQuery } from "@tanstack/react-query";
import type { ChainToken } from "@/lib/chainTokens";
import { robinhoodChain } from "@/lib/chain";
import { withoutHidden } from "@/lib/hidden";

export type { ChainToken };

/** Tokens on the chain with a market deep enough to price a launch, from the site's own endpoint. */
export function useChainTokens() {
  return useQuery({
    queryKey: ["chainTokens"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ChainToken[]> => {
      const r = await fetch("/api/chain-tokens");
      if (!r.ok) return [];
      const d = (await r.json()) as { tokens?: ChainToken[] };
      // the explorer knows nothing of the site's hidden list, so it is applied here like every other picker's
      return withoutHidden(robinhoodChain.id, d.tokens ?? [], (t) => t.address);
    },
  });
}
