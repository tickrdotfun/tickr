"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseAbiItem, type Address, type Hex } from "viem";
import { FactoryAbi } from "@/lib/abis";
import { ADDRESSES, DEPLOYED, START_BLOCK } from "@/lib/addresses";
import { POLL_MS } from "@/lib/constants";
import { launchPoolKey } from "@/lib/pool";

export type Launch = {
  token: Address;
  poolId: Hex;
  deployer: Address;
  pairToken: Address;
  poolFee: number;
  phantomQuote: bigint;
  launchConfigId: bigint;
  blockNumber?: bigint;
  index: number;
};

const TOKEN_LAUNCHED = parseAbiItem(
  "event TokenLaunched(address indexed token, bytes32 indexed poolId, address indexed deployer, address pairToken, uint256 launchConfigId, uint24 poolFee, uint256 phantomQuote)",
);

/** All launches, newest first. getLogs from startBlock; falls back to launchCount/launchAt enumeration. */
export function useLaunches() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["launches", ADDRESSES.factory],
    enabled: !!client && DEPLOYED,
    refetchInterval: POLL_MS * 3,
    queryFn: async (): Promise<Launch[]> => {
      if (!client) return [];
      // 1. Event scan
      try {
        const logs = await client.getLogs({
          address: ADDRESSES.factory,
          event: TOKEN_LAUNCHED,
          fromBlock: START_BLOCK,
          toBlock: "latest",
        });
        const count = await client.readContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "launchCount" });
        if (BigInt(logs.length) === count) {
          return logs
            .map((l, i) => ({
              token: l.args.token!,
              poolId: l.args.poolId!,
              deployer: l.args.deployer!,
              pairToken: l.args.pairToken!,
              poolFee: Number(l.args.poolFee!),
              phantomQuote: l.args.phantomQuote!,
              launchConfigId: l.args.launchConfigId!,
              blockNumber: l.blockNumber,
              index: i,
            }))
            .reverse();
        }
      } catch {
        // fall through to enumeration (RPC log-range limits etc.)
      }
      // 2. Enumeration fallback
      const count = await client.readContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "launchCount" });
      const n = Number(count);
      if (n === 0) return [];
      const idx = Array.from({ length: n }, (_, i) => BigInt(i));
      const tokens = await client.multicall({
        contracts: idx.map((i) => ({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "launchAt", args: [i] }) as const),
        allowFailure: false,
      });
      const infos = await client.multicall({
        contracts: tokens.map((t) => ({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "getLaunchedToken", args: [t] }) as const),
        allowFailure: false,
      });
      const cfgs = await client.multicall({
        contracts: tokens.map((t) => ({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "launchConfigIdOf", args: [t] }) as const),
        allowFailure: false,
      });
      return tokens
        .map((token, i) => ({
          token,
          poolId: launchPoolKey(token, infos[i].pairToken, Number(infos[i].poolFee), Number(infos[i].tickSpacing)).id,
          deployer: infos[i].deployer,
          pairToken: infos[i].pairToken,
          poolFee: Number(infos[i].poolFee),
          phantomQuote: infos[i].phantomQuote,
          launchConfigId: cfgs[i],
          index: i,
        }))
        .reverse();
    },
  });
}
