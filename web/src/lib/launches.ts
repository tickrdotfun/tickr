import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { FactoryAbi } from "@/lib/abis";
import { ADDRESSES, START_BLOCK } from "@/lib/addresses";
import { launchPoolKey } from "@/lib/pool";
import { isHidden, isHiddenConfig } from "@/lib/hidden";
import { robinhoodChain } from "@/lib/chain";

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
/** All launches, newest first. A log scan from the start block, or an enumeration when the node refuses the scan. Shared by the hook and the server snapshot. */
async function loadAllLaunches(client: PublicClient): Promise<Launch[]> {
  // 1. Event scan
  try {
    const [logs, count] = await Promise.all([
      client.getLogs({ address: ADDRESSES.factory, event: TOKEN_LAUNCHED, fromBlock: START_BLOCK, toBlock: "latest" }),
      client.readContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "launchCount" }),
    ]);
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
  const [infos, cfgs] = await Promise.all([
    client.multicall({
      contracts: tokens.map((t) => ({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "getLaunchedToken", args: [t] }) as const),
      allowFailure: false,
    }),
    client.multicall({
      contracts: tokens.map((t) => ({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "launchConfigIdOf", args: [t] }) as const),
      allowFailure: false,
    }),
  ]);
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
}

/**
 * Every launch the site will list, newest first.
 *
 * The one boundary both paths above pass through, so the exclusion cannot be missed by whichever one ran. A
 * hidden coin is dropped here and therefore never reaches a listing, a search, a ranking or an activity feed,
 * all of which are built from this.
 */
export async function loadLaunches(client: PublicClient): Promise<Launch[]> {
  const all = await loadAllLaunches(client);
  return all.filter(
    (l) =>
      !isHidden(robinhoodChain.id, l.token) &&
      !isHidden(robinhoodChain.id, l.pairToken) &&
      !isHiddenConfig(robinhoodChain.id, l.launchConfigId),
  );
}
