"use client";

import { useEffect, useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { persistQueryClient } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { wagmiConfig } from "@/lib/wagmi";
import { ADDRESSES } from "@/lib/addresses";
import { CHAIN_ID } from "@/lib/chain";
import { deserialize, serialize } from "@/lib/bigjson";

// every read the site makes is kept in the browser for a day, so a page paints from the last visit the moment it
// opens and refreshes from the chain behind that. the kept reads are restored right after React has attached to the
// server's HTML, never before, so the first client render matches what the server drew
const DAY = 24 * 60 * 60_000;

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 2_000, gcTime: DAY } },
      }),
  );
  useEffect(() => {
    let persister;
    try {
      persister = createSyncStoragePersister({ storage: window.localStorage, key: `tickr.reads.${CHAIN_ID}`, serialize, deserialize, throttleTime: 1_000 });
    } catch {
      return; // a browser without storage reads the chain every time, as before
    }
    // a new deployment is a new world: the factory address busts what an older build kept
    const [unsubscribe] = persistQueryClient({ queryClient, persister, maxAge: DAY, buster: `${CHAIN_ID}.${ADDRESSES.factory}` });
    return unsubscribe;
  }, [queryClient]);
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
