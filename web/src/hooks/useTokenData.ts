"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { erc20Abi, parseAbiItem, type Address, type ContractFunctionParameters, type Hex } from "viem";
import { FactoryAbi, FeeEscrowAbi, LaunchLockerAbi, TickerLauncherAbi, TokenAbi } from "@/lib/abis";
import { poolManagerAbi } from "@/lib/extraAbis";
import { ADDRESSES, BURN, DEPLOYED, START_BLOCK, ZERO, isZero } from "@/lib/addresses";
import { POLL_MS } from "@/lib/constants";
import { launchPoolKey, positionQuoteReserve, slot0Slot, sqrtPriceFromSlot0, tokenPriceInQuote } from "@/lib/pool";
import { liquiditySlot } from "@/lib/route";
import { useQuoteMeta } from "./useQuoteAssets";

/** `Factory.getLaunchedToken`, as the site reads it. */
export type LaunchedToken = {
  token: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
  pairToken: Address;
  phantomQuote: bigint;
  poolFee: number;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  lpTokenId: bigint;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  launchedAt: bigint;
  exists: boolean;
};

export type Socials = { twitter: string; telegram: string; discord: string; website: string; farcaster: string };

const FEES_COLLECTED = parseAbiItem(
  "event FeesCollected(address indexed token, uint256 quoteCollected, uint256 coinCollected, uint256 protocolQuote, uint256 creatorQuote, uint256 clubQuote, uint256 creatorCoin, uint256 burnedCoin)",
);

function ok<T>(r: { status: string; result?: unknown } | undefined): T | undefined {
  return r && r.status === "success" ? (r.result as T) : undefined;
}

/** Stage 1: the launch record. */
export function useLaunchedToken(token?: Address) {
  return useReadContract({
    abi: FactoryAbi,
    address: ADDRESSES.factory,
    functionName: "getLaunchedToken",
    args: token ? [token] : undefined,
    query: { enabled: DEPLOYED && !!token, refetchInterval: POLL_MS },
  });
}

/** What the locker has collected for a coin so far, summed from its own events. */
function useCollectedFees(token?: Address, enabled = true) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["collectedFees", token],
    enabled: !!client && !!token && enabled && !isZero(ADDRESSES.launchLocker),
    refetchInterval: POLL_MS * 2,
    queryFn: async () => {
      if (!client || !token) return { quote: 0n, coin: 0n, burned: 0n, creatorQuote: 0n, creatorCoin: 0n, count: 0 };
      const logs = await client.getLogs({ address: ADDRESSES.launchLocker, event: FEES_COLLECTED, args: { token }, fromBlock: START_BLOCK, toBlock: "latest" });
      let quote = 0n;
      let coin = 0n;
      let burned = 0n;
      let creatorQuote = 0n;
      let creatorCoin = 0n;
      for (const l of logs) {
        quote += l.args.quoteCollected ?? 0n;
        coin += l.args.coinCollected ?? 0n;
        burned += l.args.burnedCoin ?? 0n;
        creatorQuote += l.args.creatorQuote ?? 0n;
        creatorCoin += l.args.creatorCoin ?? 0n;
      }
      return { quote, coin, burned, creatorQuote, creatorCoin, count: logs.length };
    },
  });
}

/** Stage 2: everything the token page shows, polled. */
export function useTokenData(token?: Address) {
  const { address: user } = useAccount();
  const launchQ = useLaunchedToken(token);
  const launch = launchQ.data as LaunchedToken | undefined;
  const exists = !!launch?.exists;
  const pair = launch?.pairToken;
  const nativePair = !!pair && isZero(pair);
  const quote = useQuoteMeta(pair, token);
  const me = user ?? ZERO;

  // the pool: sorted currencies, the fee frozen at launch, no hook
  const key = useMemo(() => (launch && token && pair ? launchPoolKey(token, pair, Number(launch.poolFee), Number(launch.tickSpacing)) : undefined), [launch, token, pair]);

  const contracts: ContractFunctionParameters[] = useMemo(() => {
    if (!exists || !token || !pair || !key) return [];
    const c: ContractFunctionParameters[] = [
      /* 0 */ { abi: TokenAbi, address: token, functionName: "name" },
      /* 1 */ { abi: TokenAbi, address: token, functionName: "symbol" },
      /* 2 */ { abi: TokenAbi, address: token, functionName: "logo" },
      /* 3 */ { abi: TokenAbi, address: token, functionName: "description" },
      /* 4 */ { abi: TokenAbi, address: token, functionName: "socials" },
      /* 5 */ { abi: TokenAbi, address: token, functionName: "decimals" },
      /* 6 */ { abi: TokenAbi, address: token, functionName: "totalSupply" },
      /* 7 */ { abi: poolManagerAbi, address: ADDRESSES.poolManager, functionName: "extsload", args: [slot0Slot(key.id)] },
      /* 8 */ { abi: poolManagerAbi, address: ADDRESSES.poolManager, functionName: "extsload", args: [liquiditySlot(key.id)] },
      /* 9 */ { abi: LaunchLockerAbi, address: ADDRESSES.launchLocker, functionName: "pendingFees", args: [token] },
      /* 10 */ { abi: TokenAbi, address: token, functionName: "balanceOf", args: [BURN] },
      /* 11 */ { abi: TokenAbi, address: token, functionName: "balanceOf", args: [me] },
      /* 12 */ { abi: TokenAbi, address: token, functionName: "allowance", args: [me, ADDRESSES.zapRouter] },
      /* 13 */ nativePair
        ? { abi: FeeEscrowAbi, address: ADDRESSES.feeEscrow, functionName: "balanceOf", args: [me] }
        : { abi: erc20Abi, address: pair, functionName: "balanceOf", args: [me] },
      /* 14 */ nativePair
        ? { abi: FeeEscrowAbi, address: ADDRESSES.feeEscrow, functionName: "balanceOf", args: [me] }
        : { abi: erc20Abi, address: pair, functionName: "allowance", args: [me, ADDRESSES.zapRouter] },
      /* 15 */ nativePair
        ? { abi: FeeEscrowAbi, address: ADDRESSES.feeEscrow, functionName: "balanceOf", args: [me] }
        : { abi: FeeEscrowAbi, address: ADDRESSES.feeEscrow, functionName: "balanceOfToken", args: [me, pair] },
      /* 16 */ { abi: FeeEscrowAbi, address: ADDRESSES.feeEscrow, functionName: "balanceOfToken", args: [me, token] },
      /* 17 */ isZero(ADDRESSES.tickerLauncher)
        ? { abi: TokenAbi, address: token, functionName: "symbol" }
        : { abi: TickerLauncherAbi, address: ADDRESSES.tickerLauncher, functionName: "isTicker", args: [pair] },
      /* 18 */ { abi: FactoryAbi, address: ADDRESSES.factory, functionName: "getLaunchFeePolicy", args: [token] },
      /* 19 */ { abi: FactoryAbi, address: ADDRESSES.factory, functionName: "ctoProposals", args: [token] },
    ];
    return c;
  }, [exists, token, pair, key, nativePair, me]);

  const reads = useReadContracts({
    contracts,
    allowFailure: true,
    query: { enabled: contracts.length > 0, refetchInterval: POLL_MS },
  });
  const collected = useCollectedFees(token, exists);
  const d = reads.data;
  const g = <T,>(i: number) => ok<T>(d?.[i]);

  const tokenDecimals = g<number>(5) ?? 18;
  const quoteDecimals = quote.data?.decimals ?? 18;
  const slot0 = g<Hex>(7);
  const sqrtP = slot0 ? sqrtPriceFromSlot0(slot0) : undefined;
  const liqHex = g<Hex>(8);
  const liquidity = liqHex ? BigInt(liqHex) : undefined;
  const price = sqrtP && sqrtP > 0n && key ? tokenPriceInQuote(sqrtP, key.tokenIs0, tokenDecimals, quoteDecimals) : undefined;
  const totalSupply = g<bigint>(6);
  const marketCap = price !== undefined && totalSupply !== undefined ? price * (Number(totalSupply) / 10 ** tokenDecimals) : undefined;
  // the quote sitting in the locked position, from its liquidity and the price
  const quoteInPool =
    launch && key && sqrtP && sqrtP > 0n
      ? positionQuoteReserve({ liquidity: launch.liquidity, sqrtPriceX96: sqrtP, tickLower: Number(launch.tickLower), tickUpper: Number(launch.tickUpper), tokenIs0: key.tokenIs0 }) /
        10 ** quoteDecimals
      : undefined;

  const pendingRaw = g<readonly [bigint, bigint]>(9);
  const pending = pendingRaw && key ? { quote: key.tokenIs0 ? pendingRaw[1] : pendingRaw[0], coin: key.tokenIs0 ? pendingRaw[0] : pendingRaw[1] } : undefined;
  const isTicker = !isZero(ADDRESSES.tickerLauncher) && g<boolean>(17) === true;
  const policy = g<{ protocolFeeRecipient: Address; creatorShareBps: number; clubShareBps: number; protocolShareBps: number; buybackBurnBps: number; hookFeeBps: number; maxInternalPriceImpactBps: number }>(18);
  // a move of the fee wallet proposed by the owner: public for three days, then anyone may execute it for three more
  const proposal = g<readonly [Address, bigint, bigint]>(19);
  const takeover = proposal && !isZero(proposal[0]) ? { newRecipient: proposal[0], effectiveAt: proposal[1], expiresAt: proposal[2] } : undefined;

  return {
    launchQ,
    reads,
    launch,
    exists,
    notFound: launchQ.isFetched && !exists,
    user,
    quote: quote.data,
    quoteLoading: quote.isLoading,
    nativePair,
    meta: {
      name: g<string>(0),
      symbol: g<string>(1),
      logo: g<string>(2),
      description: g<string>(3),
      socials: g<Socials>(4),
      decimals: tokenDecimals,
      totalSupply,
    },
    pool: { key, poolId: key?.id, sqrtP, liquidity, price, marketCap, quoteInPool },
    policy,
    fees: {
      pending,
      collected: collected.data,
      burned: g<bigint>(10),
    },
    balances: {
      token: g<bigint>(11),
      tokenAllowance: g<bigint>(12),
      quote: nativePair ? undefined : g<bigint>(13),
      quoteAllowance: nativePair ? undefined : g<bigint>(14),
    },
    escrow: {
      native: nativePair ? g<bigint>(13) : undefined,
      quoteToken: nativePair ? undefined : g<bigint>(15),
      coin: g<bigint>(16),
    },
    isTicker,
    takeover,
    refetch: () => {
      launchQ.refetch();
      reads.refetch();
      collected.refetch();
    },
  };
}

export type TokenData = ReturnType<typeof useTokenData>;
