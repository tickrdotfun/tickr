"use client";

import { useEffect, useState } from "react";
import { useBlockNumber, useReadContract } from "wagmi";
import type { TokenData } from "@/hooks/useTokenData";

/** One line while a coin's launch protection is on: the first two blocks after launch, five percent per wallet. */
export function LaunchGuardLine({ d }: { d: TokenData }) {
  const { launch } = d;
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 2_000);
    return () => clearInterval(id);
  }, []);
  // asked for ten minutes after launch; the line itself ends by block number, not by the clock
  const fresh = now > 0 && !!launch && now - Number(launch.launchedAt) < 600;
  const blockNo = useBlockNumber({ watch: fresh, query: { enabled: fresh } });
  const ends = useReadContract({ abi: TOKEN_GUARD_ABI, address: launch?.token, functionName: "protectionEndsAtBlock", query: { enabled: fresh && !!launch } });
  if (!fresh || ends.data === undefined || blockNo.data === undefined || blockNo.data >= ends.data) return null;
  return <p className="detail-note detail-note-tight">launch protection is on: the first two blocks, 5% of supply per wallet, bought or received. sells of this coin are never limited.</p>;
}

const TOKEN_GUARD_ABI = [{ type: "function", name: "protectionEndsAtBlock", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
