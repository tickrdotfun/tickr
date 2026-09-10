"use client";

import { useEffect, useState } from "react";
import { useChainId, usePublicClient } from "wagmi";
import type { Address } from "viem";
import { readBounded } from "@/lib/readRpc";
import { nameReadsFrom, resolveNameSpec } from "@/lib/nameKind";
import type { NameSpec } from "@/lib/activation";


/**
 * What a name is, read from the issuers, for any part of the page that needs to know.
 *
 * One place, because two places would drift and the two answers price a trade differently. It never guesses: a
 * name neither issuer claims, or a read that did not come back, leaves `spec` undefined and `error` set, and a
 * caller that cannot proceed without an answer must not proceed.
 */
export type NameKindState = { spec?: NameSpec; error?: string; loading: boolean };

export function useNameKind(name?: Address): NameKindState {
  const client = usePublicClient();
  const chainId = useChainId();
  const [state, setState] = useState<{ id: string; spec?: NameSpec; error?: string }>({ id: "" });
  const id = name && client ? `${chainId}:${name.toLowerCase()}` : "";

  useEffect(() => {
    if (!client || !name) return;
    let live = true;
    resolveNameSpec(nameReadsFrom(client, readBounded), name)
      .then((spec) => live && setState({ id, spec }))
      .catch((e: unknown) => live && setState({ id, error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [client, name, id]);

  if (!id || state.id !== id) return { loading: !!name };
  return { spec: state.spec, error: state.error, loading: false };
}
