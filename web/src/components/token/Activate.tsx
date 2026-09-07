"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
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
export function ActivateCard({ token, title }: { token: Address; title?: string }) {
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
  const qs = d.quote?.symbol ?? "the name";
  const ts = d.meta.symbol ?? "the coin";
  const symbol = a.phase === "quote" ? qs : ts;
  const decimals = a.phase === "quote" ? (d.quote?.decimals ?? 6) : d.meta.decimals;

  if (!d.isTicker) return null;
  if (!a.ready) {
    return (
      <div className="activate">
        <div className="label">{title ?? "activate"}</div>
        <p className="text-muted text-[14px] mt-3">{DEMO ? "this is a preview: the two activation buys are sent from the live site." : isZero(ADDRESSES.universalRouter) ? "no router is recorded for this deployment; the activation buys cannot be prepared here." : "connect the wallet that launched this coin to activate it."}</p>
      </div>
    );
  }
  const records = a.inspection?.records ?? [];
  const blocked = a.inspection?.blocked ?? "";
  return (
    <div className="activate" data-state={a.done ? "done" : a.busy ? "busy" : "ready"}>
      <Confetti fire={a.celebrate} />
      <div className="label">{title ?? "activate"}</div>
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
          <div className="text-[20px] font-semibold">{ts} is live, not activated yet</div>
          <p className="text-muted text-[14px] mt-2">
            two separate purchases, each reviewed and signed in your wallet, through uniswap&apos;s router: first {formatEther(AMOUNTS.quote)} eth of {qs} delivered to your
            wallet, then, after that receipt is confirmed, {formatEther(AMOUNTS.coin)} eth of {ts} with fresh eth. the {qs} from the first stays in your wallet. gas is on
            top. nothing is sent automatically, and nothing is ever sent twice.
          </p>
          <ul className="activate-steps mt-4">
            <li data-done={a.next >= 1}>
              <span className="num">1</span> buy {qs} through its own pool, into your wallet {a.next >= 1 && <em>confirmed</em>}
            </li>
            <li data-done={a.next >= 2}>
              <span className="num">2</span> buy {ts}, after step 1 is confirmed {a.next >= 2 && <em>confirmed</em>}
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
              <button type="button" className="btn" disabled={!!a.busy} onClick={() => void a.dismissUnsent()}>
                the wallet sent nothing
              </button>
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
      const bridgeId = poolId(managedKey(ticker));
      // the name: a swap on its pool whose transaction handed the name to an account without code
      const nameSwaps = await adaptiveLogs((a, b) => client.getLogs({ address: ADDRESSES.poolManager, event: SWAP, args: { id: bridgeId }, fromBlock: a, toBlock: b }), from, latest);
      let name: boolean | null = nameSwaps.partial ? null : false;
      for (const l of nameSwaps.logs.slice(-12).reverse()) {
        if (!l.transactionHash) continue;
        const rc = await client.getTransactionReceipt({ hash: l.transactionHash }).catch(() => null);
        if (!rc) {
          name = name === false ? null : name;
          continue;
        }
        for (const x of rc.logs) {
          if (!sameAddr(x.address, ticker) || x.topics.length !== 3 || x.topics[0] !== TRANSFER_TOPIC) continue;
          const fromTopic = x.topics[1];
          const toTopic = x.topics[2];
          if (!fromTopic || !toTopic || !sameAddr(`0x${fromTopic.slice(26)}`, ADDRESSES.poolManager)) continue;
          const to = `0x${toTopic.slice(26)}` as Address;
          const code = await client.getCode({ address: to }).catch(() => undefined);
          if (code === undefined) {
            name = name === false ? null : name;
            continue;
          }
          if (code === "0x") name = true;
        }
        if (name === true) break;
      }
      // the coin: a swap on its pool in a transaction other than the pool's first, delivering the coin to a wallet
      const coinSwaps = await adaptiveLogs((a, b) => client.getLogs({ address: ADDRESSES.poolManager, event: SWAP, args: { id: own.id }, fromBlock: a, toBlock: b }), from, latest);
      let coin: boolean | null = coinSwaps.partial ? null : false;
      const first = coinSwaps.logs[0]?.transactionHash;
      for (const l of coinSwaps.logs.slice(-12).reverse()) {
        if (!l.transactionHash || (first && l.transactionHash === first && coinSwaps.logs.length === 1)) continue;
        if (first && l.transactionHash === first) continue;
        const rc = await client.getTransactionReceipt({ hash: l.transactionHash }).catch(() => null);
        if (!rc) {
          coin = coin === false ? null : coin;
          continue;
        }
        const delivered = rc.logs.some((x) => sameAddr(x.address, token) && x.topics.length === 3 && x.topics[0] === TRANSFER_TOPIC && !!x.topics[1] && sameAddr(`0x${x.topics[1].slice(26)}`, ADDRESSES.poolManager));
        if (delivered) {
          coin = true;
          break;
        }
      }
      // the pool's first transaction is the launch: only a later one counts, so a single swap in the launch transaction is nothing
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
  if (mine) return <ActivateCard token={token} title="not activated yet" />;
  if (signals.data?.activated !== false) return null;
  return <Notice kind="warn">not activated yet, as far as this page can tell: the two buys that follow a launch under a name have not landed. it trades here as usual.</Notice>;
}
