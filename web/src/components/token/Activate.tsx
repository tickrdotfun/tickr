"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useChainId, usePublicClient, useReadContract } from "wagmi";
import { formatEther, formatUnits, parseAbiItem, toEventSelector, type Address } from "viem";
import { FactoryAbi } from "@/lib/abis";
import { ADDRESSES, isZero, sameAddr } from "@/lib/addresses";
import { fmtAmount, shortAddr } from "@/lib/format";
import { useActivation, type ActivationTarget } from "@/hooks/useActivation";
import { useLaunches } from "@/hooks/useLaunches";
import { useTokenData } from "@/hooks/useTokenData";
import { adaptiveLogs } from "@/lib/logs";
import { AMOUNTS, managedKey, poolId } from "@/lib/activation";
import { Confetti } from "../motion/Confetti";
import { Notice, Spinner } from "../ui";
import { DEMO } from "@/lib/demoTransport";

const explorer = (h: string) => `https://robinhoodchain.blockscout.com/tx/${h}`;

/**
 * The last step of a launch under a name: the two buys the reference proved, each its own reviewed and signed
 * transaction through Uniswap's canonical router. The name into the creator's wallet first, then the coin with fresh
 * ETH. A coin is shown as done only when both receipts are canonical, ordered and show the delivery.
 */
export function ActivateCard({ token, title, onDone }: { token: Address; title?: string; onDone?: () => void }) {
  const d = useTokenData(token);
  const own = useReadContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "poolKeyOf", args: [token], query: { enabled: !!d.launch, staleTime: Infinity } });
  const target = useMemo((): ActivationTarget | undefined => {
    if (!d.launch || !own.data || !d.isTicker) return undefined;
    return { token, ticker: d.launch.pairToken, own: { currency0: own.data.currency0, currency1: own.data.currency1, fee: Number(own.data.fee), tickSpacing: Number(own.data.tickSpacing), hooks: own.data.hooks } };
  }, [d.launch, d.isTicker, own.data, token]);
  const a = useActivation(target);
  const [hash, setHash] = useState("");
  const [ack, setAck] = useState(false);
  const reviewKey = a.review ? `${a.review.phase}:${a.review.preparedAt}` : "none";
  const doneOnce = useRef(false);
  useEffect(() => {
    if (!a.done || !onDone || doneOnce.current) return;
    doneOnce.current = true;
    onDone();
  }, [a.done, onDone]);
  const qs = d.quote?.symbol ?? "the name";
  const ts = d.meta.symbol ?? "the coin";
  const symbol = a.phase === "quote" ? qs : ts;
  const decimals = a.phase === "quote" ? (d.quote?.decimals ?? 6) : d.meta.decimals;

  if (!d.isTicker) return null;
  if (!a.ready) {
    return (
      <div className="activate">
        <div className="label">{title ?? "listing"}</div>
        <p className="text-muted text-[14px] mt-3">{DEMO ? "this is a preview: the two listing buys are sent from the live site." : isZero(ADDRESSES.universalRouter) ? "no router is recorded for this deployment; the listing buys cannot be prepared here." : "connect the wallet that launched this coin to activate it."}</p>
      </div>
    );
  }
  const records = a.inspection?.records ?? [];
  const blocked = a.inspection?.blocked ?? "";
  return (
    <div className="activate" data-state={a.done ? "done" : a.busy ? "busy" : "ready"}>
      <Confetti fire={a.celebrate} />
      <div className="label">{title ?? "listing"}</div>
      {a.done ? (
        <div className="mt-3">
          <div className="text-[20px] font-semibold">on-chain sequence confirmed. external trading still unverified.</div>
          <p className="text-muted text-[14px] mt-2">
            both purchases landed in your wallet in order, as their receipts show. chart sites and trackers index on their own clock: the reference&apos;s name showed
            up minutes later, and a price on a chart is not yet a trade. total cost {formatEther(a.inspection?.cost ?? 0n)} eth, gas included.
          </p>
          <ul className="activate-steps mt-4">
            {records.map((r, i) => (
              <li key={i} data-done="true">
                <span className="num">{i + 1}</span> {r.phase === "quote" ? `${qs} into your wallet` : `${ts} into your wallet`}: {fmtAmount(r.received, r.phase === "quote" ? (d.quote?.decimals ?? 6) : d.meta.decimals, { sig: 4 })}{" "}
                {r.hash && (
                  <a href={explorer(r.hash)} target="_blank" rel="noreferrer" className="num">
                    {shortAddr(r.hash)}
                  </a>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-5">
            <Link href={`/t/${token}`} className="btn btn-primary no-underline">
              open {ts}
            </Link>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <div className="text-[20px] font-semibold">{ts} is live, listing pending</div>
          <p className="text-muted text-[14px] mt-2">
            two separate purchases, each reviewed and signed in your wallet, through uniswap&apos;s router: first {formatEther(AMOUNTS.quote)} eth of {qs} delivered to your
            wallet, then, after that receipt is confirmed, {formatEther(AMOUNTS.coin)} eth of {ts} with fresh eth. the {qs} from the first stays in your wallet. gas is on
            top. nothing is sent automatically, and nothing is ever sent twice.
          </p>
          <ul className="activate-steps mt-4">
            <li data-done={a.stageStatus(0) === "confirmed"}>
              <span className="num">1</span> buy {qs} through its own pool, into your wallet <em>{a.stageStatus(0)}</em>
            </li>
            <li data-done={a.stageStatus(1) === "confirmed"}>
              <span className="num">2</span> buy {ts}, after step 1 is confirmed <em>{a.stageStatus(1)}</em>
            </li>
          </ul>
          {a.busy && (
            <p className="text-muted text-[14px] mt-4 inline-flex items-center gap-2" role="status">
              <Spinner /> {a.busy}
            </p>
          )}
          {(a.error || blocked) && (
            <div className="mt-4">
              <Notice kind={a.readsDown ? "warn" : "danger"}>{a.error || blocked} the saved record is kept. do not resend, replace, cancel or speed up anything in the wallet.</Notice>
            </div>
          )}
          {a.unknown && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <input className="input num" style={{ minWidth: 340 }} value={hash} placeholder="0x… the transaction hash the wallet shows, never a key" onChange={(e) => setHash(e.target.value)} aria-label="transaction hash to recover" />
              <button type="button" className="btn" disabled={!!a.busy || !hash} onClick={() => void a.recover(hash)}>
                match this hash
              </button>
              <span className="text-muted text-[13px]">the wallet&apos;s history shows the hash. if it shows nothing at all, the request is kept until it does; nothing is sent again.</span>
            </div>
          )}
          {!a.unknown && !a.unverified && !a.review && (
            <div className="flex flex-wrap items-center gap-3 mt-5">
              <button type="button" className="btn btn-gradient" disabled={!!a.busy} onClick={() => void a.prepare(a.phase)}>
                {a.busy ? "checking" : `check the ${symbol} purchase (${formatEther(AMOUNTS[a.phase])} eth)`}
              </button>
              <button type="button" className="btn" disabled={!!a.busy} onClick={() => void a.refresh()}>
                refresh receipts, no spending
              </button>
            </div>
          )}
          {a.review && !a.unknown && (
            <div className="mt-5 activate-review">
              <div className="label">review this {symbol} purchase</div>
              <dl className="facts mt-3">
                <dt>you pay</dt>
                <dd className="num">{formatEther(BigInt(a.review.request.value))} eth</dd>
                <dt>quoted now</dt>
                <dd className="num">
                  {formatUnits(BigInt(a.review.quote), decimals)} {symbol}
                </dd>
                <dt>the least you accept (1% under)</dt>
                <dd className="num">
                  {formatUnits(BigInt(a.review.minimum), decimals)} {symbol}
                </dd>
                <dt>most this can cost, gas included</dt>
                <dd className="num">{formatEther(BigInt(a.review.maximum))} eth</dd>
                <dt>delivered to</dt>
                <dd className="num">{shortAddr(a.review.request.from)}</dd>
                <dt>quote expires</dt>
                <dd className="num">{new Date(a.review.deadline * 1000).toLocaleTimeString()}</dd>
              </dl>
              <label className="flex items-start gap-2 mt-4 text-[14px]" key={reviewKey}>
                <input type="checkbox" checked={ack && !!a.review} onChange={(e) => setAck(e.target.checked)} />
                <span>i will review this one transaction in my wallet and sign it once. if the wallet stalls i will not resend it.</span>
              </label>
              <div className="flex flex-wrap items-center gap-3 mt-4">
                <button type="button" className="btn btn-gradient" disabled={!!a.busy || !ack || a.expired} onClick={() => void a.send()}>
                  {a.expired ? "quote expired, check again" : `open the wallet for ${symbol}`}
                </button>
                <button type="button" className="btn" disabled={!!a.busy} onClick={() => void a.prepare(a.phase)}>
                  check again
                </button>
              </div>
            </div>
          )}
          {records.length > 0 && (
            <ul className="mt-4 text-[13px] text-muted space-y-1">
              {records.map((r, i) => (
                <li key={i}>
                  {r.phase === "quote" ? `${qs} purchase` : `${ts} purchase`}: {r.status}
                  {r.hash && (
                    <>
                      {" "}
                      <a href={explorer(r.hash)} target="_blank" rel="noreferrer" className="num">
                        {shortAddr(r.hash)}
                      </a>
                    </>
                  )}
                  {r.note && <> · {r.note}</>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const SWAP = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
const INITIALIZE = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const TRANSFER_TOPIC = toEventSelector("event Transfer(address indexed from, address indexed to, uint256 value)");

/**
 * What the chain shows about a coin's activation for someone who is not its creator: the display only. Nothing here
 * removes a step or is remembered. True only when a swap on the name's pool delivered the name to an ordinary wallet
 * and a swap on the coin's pool, in a transaction other than the pool's first, delivered the coin to a wallet; an
 * incomplete read is unknown, never a verdict.
 */
export function useActivationSignals(token?: Address, ticker?: Address, own?: { id: `0x${string}` }, launchBlock?: bigint, enabled = true) {
  const client = usePublicClient();
  const chainId = useChainId();
  return useQuery({
    queryKey: ["activationSignals", chainId, token, ticker, own?.id, launchBlock?.toString()],
    enabled: !!client && !!token && !!ticker && !!own && enabled && !isZero(ADDRESSES.poolManager),
    staleTime: 20_000,
    refetchInterval: (q) => (q.state.data?.activated === true ? false : 8_000),
    retry: 2,
    queryFn: async (): Promise<{ activated: boolean | null; name: boolean | null; coin: boolean | null }> => {
      if (!client || !token || !ticker || !own) return { activated: null, name: null, coin: null };
      const latest = await client.getBlockNumber();
      const from = launchBlock ?? 0n;
      // no code: the client reports an empty account as "0x" or as undefined; a thrown read is unknown, not "no code"
      const isWallet = async (addr: Address): Promise<boolean | null> => {
        try {
          const code = await client.getCode({ address: addr });
          return code === undefined || code === "0x";
        } catch {
          return null;
        }
      };
      const deliveredTo = (rc: { logs: { address: Address; topics: readonly `0x${string}`[] }[] }, asset: Address): Address[] =>
        rc.logs.filter((x) => sameAddr(x.address, asset) && x.topics.length === 3 && x.topics[0] === TRANSFER_TOPIC && !!x.topics[1] && sameAddr(`0x${x.topics[1].slice(26)}`, ADDRESSES.poolManager)).map((x) => `0x${x.topics[2]!.slice(26)}` as Address);
      // the name: a swap on its pool whose transaction handed the name to an ordinary wallet
      const bridgeId = poolId(managedKey(ticker));
      const nameSwaps = await adaptiveLogs((a, b) => client.getLogs({ address: ADDRESSES.poolManager, event: SWAP, args: { id: bridgeId }, fromBlock: a, toBlock: b }), from, latest);
      // the scan looks at the latest few receipts: when there are more than it looks at and none of those qualify,
      // an earlier one might, so the answer is unknown, never "no"
      const SCAN = 12;
      let name: boolean | null = nameSwaps.partial ? null : nameSwaps.logs.length > SCAN ? null : false;
      for (const l of nameSwaps.logs.slice(-SCAN).reverse()) {
        if (!l.transactionHash) continue;
        const rc = await client.getTransactionReceipt({ hash: l.transactionHash }).catch(() => null);
        if (!rc) {
          name = null;
          continue;
        }
        for (const to of deliveredTo(rc, ticker)) {
          const w = await isWallet(to);
          if (w === null) name = null;
          else if (w) name = true;
          if (name === true) break;
        }
        if (name === true) break;
      }
      // the coin: a swap on its pool in a transaction other than the one that initialised it, delivering the coin to
      // a wallet. the launch transaction is found by its Initialize log; if that read fails, nothing is claimed
      const inits = await client.getLogs({ address: ADDRESSES.poolManager, event: INITIALIZE, args: { id: own.id }, fromBlock: from, toBlock: latest }).catch(() => null);
      const launchTx = inits?.[0]?.transactionHash?.toLowerCase();
      const coinSwaps = await adaptiveLogs((a, b) => client.getLogs({ address: ADDRESSES.poolManager, event: SWAP, args: { id: own.id }, fromBlock: a, toBlock: b }), from, latest);
      const later = coinSwaps.logs.filter((l) => !!l.transactionHash && l.transactionHash.toLowerCase() !== launchTx);
      let coin: boolean | null = coinSwaps.partial || !launchTx ? null : later.length > SCAN ? null : false;
      if (launchTx) {
        for (const l of later.slice(-SCAN).reverse()) {
          const rc = await client.getTransactionReceipt({ hash: l.transactionHash! }).catch(() => null);
          if (!rc) {
            coin = null;
            continue;
          }
          for (const to of deliveredTo(rc, token)) {
            const w = await isWallet(to);
            if (w === null) coin = null;
            else if (w) coin = true;
            if (coin === true) break;
          }
          if (coin === true) break;
        }
      }
      const activated = name === true && coin === true ? true : name === null || coin === null ? null : false;
      return { activated, name, coin };
    },
  });
}

/** On a coin's page: the creator's own card while the coin is not activated; a line for everyone else. */
export function ActivationNotice({ token, deployer }: { token: Address; deployer?: Address }) {
  const d = useTokenData(token);
  const launches = useLaunches();
  const found = launches.data?.find((l) => sameAddr(l.token, token));
  const signals = useActivationSignals(d.isTicker ? token : undefined, d.launch?.pairToken, d.pool.poolId ? { id: d.pool.poolId } : undefined, found?.blockNumber, d.isTicker);
  if (!d.isTicker || !d.launch) return null;
  const mine = !!d.user && (sameAddr(d.user, deployer ?? d.launch.deployer) || sameAddr(d.user, d.launch.creatorFeeRecipient));
  if (mine) return <ActivateCard token={token} title="listing pending" />;
  if (signals.data?.activated !== false) return null;
  return <Notice kind="warn">listing pending, as far as this page can tell: the two buys that follow a launch under a name have not landed. it trades here as usual.</Notice>;
}
