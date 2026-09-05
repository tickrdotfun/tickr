import stocks from "@/data/stocks.json";
import deployments from "@/lib/deployments.json";
import { custom, decodeFunctionData, encodeFunctionResult, type Hex } from "viem";

/**
 * Replays a recorded chain.
 *
 * The launches on the preview deployment live on a local anvil fork that nothing on the internet can
 * reach, and their contracts have no code on the public chain. So instead of pointing the app at an RPC
 * that would fail every read, this transport answers from a recording of the fork: the same calls, the
 * same results, so every hook works unchanged and the site shows exactly what localhost showed.
 *
 * Reads are batched through multicall3, and how they get batched is not stable between two runs of the
 * same page. So the recording is keyed twice: on each whole batch as it happened, and on every individual
 * call inside it. A batch the recording never saw is decoded and answered call by call.
 *
 * It is a fixture, not a chain. Nothing can be written to it, and the numbers are frozen at the moment
 * the recording was taken, which is why the site says so on every page while this is switched on.
 */
export const DEMO = process.env.NEXT_PUBLIC_DEMO === "1";

const AGG3_SELECTOR = "0x82ad56cb";
const MULTICALL3_ABI = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

type Inner = { success: boolean; returnData: Hex };
type Recording = Record<string, unknown>;

const keyOf = (method: string, params: unknown) => `${method}|${JSON.stringify(params ?? []).toLowerCase()}`;
const innerKey = (target: string, callData: string) => `call|${target.toLowerCase()}|${callData.toLowerCase()}`;

let pending: Promise<Recording> | null = null;

/**
 * Contracts that exist on the real chain exactly as they do on the fork: Robinhood's Stock Tokens, USDG and the
 * canonical Uniswap contracts. A read about one of them that the recording never made is answered by the public
 * RPC instead of counted as a miss, so the pair card works for all 194 assets in a preview. Everything tickr
 * deployed on the fork has no code on the real chain and stays fixture-only.
 */
const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const REAL = new Set<string>([
  ...stocks.assets.map((a) => a.address.toLowerCase()),
  ...[deployments.usdg, deployments.poolManager, deployments.positionManager, deployments.weth].filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()),
]);
let forwardId = 1;
async function forward(method: string, params: unknown): Promise<unknown> {
  const r = await fetch(PUBLIC_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: forwardId++, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? "rpc error");
  const w = window as unknown as { __demoForwarded?: number };
  w.__demoForwarded = (w.__demoForwarded ?? 0) + 1;
  return j.result;
}
function realTarget(method: string, params: unknown): boolean {
  const p = params as unknown[] | undefined;
  const to = method === "eth_call" ? (p?.[0] as { to?: string } | undefined)?.to : method === "eth_getCode" ? (p?.[0] as string | undefined) : undefined;
  return !!to && REAL.has(to.toLowerCase());
}

function recording(): Promise<Recording> {
  // one fetch for the page's lifetime; a failure degrades to misses rather than to a broken render
  pending ??= fetch("/demo-rpc.json")
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return pending;
}

/** A miss is the difference between "the fixture says empty" and "the fixture was never asked". Keep them visible. */
function noteMiss(key: string) {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __demoMisses?: string[] };
  (w.__demoMisses ??= []).push(key.slice(0, 400));
}

/** Answer an aggregate3 batch from the individually recorded calls inside it. */
function answerBatch(map: Recording, data: Hex): Hex | undefined {
  let calls: readonly { target: string; callData: Hex }[];
  try {
    const decoded = decodeFunctionData({ abi: MULTICALL3_ABI, data });
    calls = decoded.args[0];
  } catch {
    return undefined;
  }
  let hits = 0;
  const result: Inner[] = calls.map((c) => {
    const k = innerKey(c.target, c.callData);
    const hit = map[k] as Inner | undefined;
    if (hit) {
      hits++;
      return hit;
    }
    noteMiss(k);
    return { success: false, returnData: "0x" };
  });
  if (hits === 0) return undefined;
  return encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", result });
}

export function demoTransport() {
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const map = await recording();
      const whole = keyOf(method, params);
      const hit = map[whole];
      if (hit !== undefined) return hit;

      if (method === "eth_call") {
        const data = (params as [{ data?: Hex }] | undefined)?.[0]?.data;
        if (data?.toLowerCase().startsWith(AGG3_SELECTOR)) {
          const answered = answerBatch(map, data);
          if (answered) return answered;
        }
      }

      if ((method === "eth_call" || method === "eth_getCode") && realTarget(method, params)) {
        try {
          return await forward(method, params);
        } catch {
          /* fall through to a miss */
        }
      }

      noteMiss(whole);
      // Anything the recording did not cover reads as absent rather than as an error, so a page the
      // recording never visited renders its empty state instead of a crash.
      if (method === "eth_getLogs") return [];
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_estimateGas" || method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas") return "0x0";
      if (method === "eth_call") return "0x";
      return null;
    },
  });
}
