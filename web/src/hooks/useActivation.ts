"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useChainId, usePublicClient } from "wagmi";
import { parseAbiItem, type Address } from "viem";
import { ZapRouterAbi } from "@/lib/abis";
import { ADDRESSES, START_BLOCK, isZero, sameAddr } from "@/lib/addresses";
import { adaptiveLogs } from "@/lib/logs";
import { applySlippage } from "@/lib/pool";
import { hopId, type Hop, type V4Key } from "@/lib/route";
import { previewZapOnce, zapParams } from "@/hooks/useZap";
import { useZapRoute } from "@/hooks/useZapRoute";
import { useEthUsd } from "@/hooks/useEthUsd";
import { useTx, type WriteFn } from "@/hooks/useTx";
import {
  activationWei,
  coinActivationPath,
  loadIntent,
  recallActivated,
  rememberActivated,
  saveIntent,
  serialised,
  tickerBuyPath,
  zapTickerParams,
  type ActivationIntent,
} from "@/lib/activation";
import { BaseError, ContractFunctionRevertedError } from "viem";
import { DEMO } from "@/lib/demoTransport";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
const INITIALIZE = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);

/** What the site needs to know about a launch to activate it. */
export type ActivationTarget = {
  token: Address;
  pairToken: Address;
  poolId: `0x${string}`;
  own: V4Key;
  /** the block the launch landed in, from its log; unknown for a launch found by enumeration */
  launchBlock?: bigint;
  isTicker: boolean;
};

export type ActivationState =
  | "loading" // still reading the chain
  | "ready" // something is missing and the button can be pressed
  | "signing-ticker"
  | "confirming-ticker"
  | "signing-coin"
  | "confirming-coin"
  | "recovering" // a transaction from before a reload is being waited for, nothing is sent
  | "done"
  | "error";

/**
 * Has the name ever been bought into a wallet through its own pool? The pool manager pays the buyer directly, so
 * that is a Transfer from the pool manager to an address without code. One way: once true, remembered.
 */
export function useTickerActivated(ticker?: Address, enabled = true) {
  const client = usePublicClient();
  const chainId = useChainId();
  return useQuery({
    queryKey: ["tickerActivated", chainId, ticker],
    enabled: !!client && !!ticker && enabled && !isZero(ADDRESSES.poolManager),
    staleTime: 15_000,
    refetchInterval: (q) => (q.state.data === true ? false : 6_000),
    retry: 3,
    queryFn: async (): Promise<boolean | null> => {
      if (!client || !ticker) return null;
      if (recallActivated(chainId, ticker)) return true;
      const latest = await client.getBlockNumber();
      const { logs, partial } = await adaptiveLogs(
        (a, b) => client.getLogs({ address: ticker, event: TRANSFER, args: { from: ADDRESSES.poolManager }, fromBlock: a, toBlock: b }),
        START_BLOCK,
        latest,
      );
      const wallets = Array.from(new Set(logs.map((l) => (l.args.to ?? "0x").toLowerCase()))).filter((a) => a.length === 42) as Address[];
      for (const w of wallets) {
        // the zap pays the wallet straight from the pool manager; a route that netted the name through the pool
        // manager never produced such a transfer at all, so any transfer to a wallet is the real thing
        const code = await client.getCode({ address: w }).catch(() => undefined);
        if (!code || code === "0x") {
          rememberActivated(chainId, ticker);
          return true;
        }
      }
      return partial ? null : false;
    },
  });
}

/** Has the coin been bought in a transaction after the one that launched it? One way: once true, remembered. */
export function useCoinActivated(t?: ActivationTarget, enabled = true) {
  const client = usePublicClient();
  const chainId = useChainId();
  return useQuery({
    queryKey: ["coinActivated", chainId, t?.token, t?.launchBlock?.toString()],
    enabled: !!client && !!t && enabled && !isZero(ADDRESSES.poolManager),
    staleTime: 15_000,
    refetchInterval: (q) => (q.state.data === true ? false : 6_000),
    retry: 3,
    queryFn: async (): Promise<boolean | null> => {
      if (!client || !t) return null;
      if (recallActivated(chainId, t.token)) return true;
      const latest = await client.getBlockNumber();
      const from = t.launchBlock ?? START_BLOCK;
      // the launch transaction: the one that initialised the pool
      const inits = await client
        .getLogs({ address: ADDRESSES.poolManager, event: INITIALIZE, args: { id: t.poolId }, fromBlock: from, toBlock: t.launchBlock ?? latest })
        .catch(() => []);
      const launchTx = inits[0]?.transactionHash?.toLowerCase();
      const { logs, partial } = await adaptiveLogs(
        (a, b) => client.getLogs({ address: ADDRESSES.poolManager, event: SWAP, args: { id: t.poolId }, fromBlock: a, toBlock: b }),
        from,
        latest,
      );
      const later = logs.some((l) => (l.transactionHash ?? "").toLowerCase() !== launchTx);
      if (later) {
        rememberActivated(chainId, t.token);
        return true;
      }
      return partial ? null : false;
    },
  });
}

/**
 * The activation of one coin for the connected wallet: what is still missing, the two buys as one button, and a
 * memory of where it got to so a reload resumes. Nothing is ever sent twice: a transaction whose hash is known
 * is waited for, and one wallet runs one activation at a time in this tab.
 */
export function useActivation(t?: ActivationTarget) {
  const client = usePublicClient();
  const chainId = useChainId();
  const { address: user } = useAccount();
  const qc = useQueryClient();
  const tx = useTx();
  const ethUsd = useEthUsd();
  const tickerQ = useTickerActivated(t?.isTicker ? t.pairToken : undefined, !!t?.isTicker);
  const coinQ = useCoinActivated(t);
  // a coin not under a name is bought along whatever route the trade panel would use
  const route = useZapRoute(t && !t.isTicker ? t.token : undefined, t && !t.isTicker ? t.pairToken : undefined, undefined, user);
  // what is in flight; the resting state is derived from the chain below
  const [phase, setPhase] = useState<Exclude<ActivationState, "loading" | "ready" | "done"> | "idle" | "celebrated">("idle");
  const [error, setError] = useState<string | undefined>();
  // the stored intent is read, never copied into state: `bump` re-reads it after every write
  const [bump, setBump] = useState(0);
  const running = useRef(false);

  const needsTicker = !!t?.isTicker && tickerQ.data !== true;
  const needsCoin = coinQ.data !== true;
  const known = (t?.isTicker ? tickerQ.data !== undefined && tickerQ.data !== null : true) && coinQ.data !== undefined && coinQ.data !== null;
  const activated = !!t && !needsTicker && !needsCoin;
  const wei = useMemo(() => activationWei(ethUsd.data), [ethUsd.data]);
  const stored = useMemo(() => {
    void bump; // re-read after every write
    return t && user ? loadIntent(chainId, t.token) : undefined;
  }, [t, user, chainId, bump]);
  const hashes = useMemo(
    () => (stored && user && sameAddr(stored.wallet, user) ? { ticker: stored.tickerHash, coin: stored.coinHash } : {}),
    [stored, user],
  );
  const state: ActivationState =
    phase === "idle" || phase === "celebrated" ? (!t ? "loading" : activated ? "done" : !known ? "loading" : "ready") : phase;
  const celebrate = phase === "celebrated";

  const coinPath = useMemo((): Hop[] | null => {
    if (!t) return null;
    if (t.isTicker) return coinActivationPath(t.pairToken, t.own);
    return route.data?.path ?? null;
  }, [t, route.data]);

  /** Wait for a transaction sent before a reload, then read the chain again. Sends nothing. */
  const recover = useCallback(
    async (intent: ActivationIntent) => {
      if (!client || !intent.pending) return;
      setPhase("recovering");
      try {
        const rc = await client.waitForTransactionReceipt({ hash: intent.pending, timeout: 120_000 });
        const next: ActivationIntent = { ...intent, pending: undefined };
        if (rc.status === "success") {
          if (intent.stage === "ticker") next.tickerHash = intent.pending;
          if (intent.stage === "coin") next.coinHash = intent.pending;
          if (intent.stage === "coin") next.stage = "done";
          else next.stage = "coin";
        }
        saveIntent(chainId, next);
      } catch {
        // still pending or dropped: the wallet decides; nothing is resent from here
      }
      setBump((b) => b + 1);
      await Promise.all([qc.invalidateQueries({ queryKey: ["tickerActivated"] }), qc.invalidateQueries({ queryKey: ["coinActivated"] })]);
      running.current = false;
      setPhase("idle");
    },
    [client, chainId, qc],
  );

  // on mount: an intent with a pending hash is recovered, never resent
  useEffect(() => {
    if (!t || !user || DEMO) return;
    const intent = loadIntent(chainId, t.token);
    if (!intent || !sameAddr(intent.wallet, user)) return;
    if (intent.pending && !running.current) {
      running.current = true;
      void recover(intent);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.token, user, chainId]);

  const activate = useCallback(async (): Promise<boolean> => {
    if (!t || !user || !client || running.current) return false;
    running.current = true;
    setError(undefined);
    const ok = await serialised(user, async () => {
      try {
        const base: ActivationIntent = loadIntent(chainId, t.token) ?? { coin: t.token, ticker: t.isTicker ? t.pairToken : null, wallet: user, stage: "ticker", updatedAt: 0 };
        let intent: ActivationIntent = { ...base, wallet: user };
        // 1. the name into the wallet, through its own pool, when it has never been
        if (needsTicker) {
          const path = tickerBuyPath(t.pairToken);
          const minOut = await previewTicker(client, t.pairToken, path, wei, user);
          intent = { ...intent, stage: "ticker" };
          saveIntent(chainId, intent);
          setPhase("signing-ticker");
          const h = await tx.run([
            {
              label: "Buy the name",
              request: async (w: WriteFn) => {
                const hash = await w({ abi: ZapRouterAbi, address: ADDRESSES.zapRouter, functionName: "zapTicker", args: [zapTickerParams(t.pairToken, path, user, minOut)], value: wei });
                saveIntent(chainId, { ...intent, pending: hash });
                setPhase("confirming-ticker");
                return hash;
              },
            },
          ]);
          if (!h) throw new Error(tx.error ?? "the name was not bought");
          intent = { ...intent, pending: undefined, tickerHash: h, stage: "coin" };
          saveIntent(chainId, intent);
          setBump((b) => b + 1);
          rememberActivated(chainId, t.pairToken);
        }
        // 2. the coin, in its own transaction
        if (needsCoin || intent.stage !== "done") {
          if (!coinPath) throw new Error("no route from ETH to this coin yet; try again in a moment");
          const pv = await previewZapOnce(client, t.token, coinPath, wei, user).catch(() => null);
          const minOut = pv ? applySlippage(pv.tokensOut, 300) : 0n;
          intent = { ...intent, stage: "coin" };
          saveIntent(chainId, intent);
          setPhase("signing-coin");
          const h = await tx.run([
            {
              label: "Buy the coin",
              request: async (w: WriteFn) => {
                const hash = await w({ abi: ZapRouterAbi, address: ADDRESSES.zapRouter, functionName: "zapBuy", args: [zapParams(t.token, coinPath, user, minOut)], value: wei });
                saveIntent(chainId, { ...intent, pending: hash });
                setPhase("confirming-coin");
                return hash;
              },
            },
          ]);
          if (!h) throw new Error(tx.error ?? "the coin was not bought");
          intent = { ...intent, pending: undefined, coinHash: h, stage: "done" };
          saveIntent(chainId, intent);
          rememberActivated(chainId, t.token);
        }
        // the hashes stay readable on this page; the next visit reads the chain, which now says activated
        saveIntent(chainId, { ...intent, stage: "done", pending: undefined });
        setBump((b) => b + 1);
        setPhase("celebrated");
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
        return false;
      } finally {
        running.current = false;
        await Promise.all([qc.invalidateQueries({ queryKey: ["tickerActivated"] }), qc.invalidateQueries({ queryKey: ["coinActivated"] })]);
      }
    });
    return ok;
  }, [t, user, client, chainId, needsTicker, needsCoin, coinPath, wei, tx, qc]);

  const retry = useCallback(() => {
    setError(undefined);
    setPhase("idle");
  }, []);

  return {
    state,
    error,
    activated,
    needsTicker,
    needsCoin,
    known,
    hashes,
    wei,
    ethUsd: ethUsd.data ?? undefined,
    celebrate,
    busy: state.startsWith("signing") || state.startsWith("confirming") || state === "recovering",
    txStep: tx.step,
    activate,
    retry,
    routeReady: !!coinPath,
    pathKey: coinPath?.map(hopId).join("|"),
  };
}

/** The least of the name the wallet accepts for its ETH: the zap's own preview, less three percent. */
async function previewTicker(client: NonNullable<ReturnType<typeof usePublicClient>>, ticker: Address, path: Hop[], valueWei: bigint, from: Address): Promise<bigint> {
  try {
    await client.simulateContract({
      abi: ZapRouterAbi,
      address: ADDRESSES.zapRouter,
      functionName: "previewZapTicker",
      args: [zapTickerParams(ticker, path, from)],
      value: valueWei,
      account: from,
    });
    return 0n;
  } catch (e) {
    if (e instanceof BaseError) {
      const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === "Preview") {
        const [, out] = revert.data.args as readonly [bigint, bigint];
        return applySlippage(out, 300);
      }
    }
    throw e;
  }
}
