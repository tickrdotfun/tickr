"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useBalance, useBlockNumber, useReadContract, useReadContracts } from "wagmi";
import { erc20Abi } from "viem";
import type { TokenData } from "@/hooks/useTokenData";
import { useTx, type WriteFn } from "@/hooks/useTx";
import { useQuoterQuote } from "@/hooks/useQuoterQuote";
import { useZapPreview, useZapSellPreview, zapParams, zapSellParams } from "@/hooks/useZap";
import { useZapRoute } from "@/hooks/useZapRoute";
import { TokenAbi, ZapRouterAbi } from "@/lib/abis";
import { ADDRESSES, ZERO } from "@/lib/addresses";
import { DEFAULT_SLIPPAGE_BPS } from "@/lib/constants";
import { bpsToPct, fmtAmount, safeParseUnits } from "@/lib/format";
import { applySlippage, quoteExactIn } from "@/lib/pool";
import { reverseRoute } from "@/lib/route";
import { TxStatus } from "../TxStatus";
import { Notice, Panel, Row } from "../ui";
import { GlideIndicator, useGlider } from "../motion/Glide";

/**
 * Every trade goes through the coin's own Uniswap v4 pool, by way of the ZapRouter. Paid in ETH, the router
 * walks the route to the coin's quote asset first; paid in the quote, it is the one pool. Sells run the same
 * path backwards.
 */
export function TradePanel({ d }: { d: TokenData }) {
  const { user, quote, nativePair, balances, meta, launch, pool, policy } = d;
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState((DEFAULT_SLIPPAGE_BPS / 100).toString());
  const [slipOpen, setSlipOpen] = useState(false);
  const [payEth, setPayEth] = useState(true);
  const tx = useTx();
  const { trackRef: sideTrack, indRef: sideInd } = useGlider(side);
  const native = useBalance({ address: user, query: { enabled: !!user, refetchInterval: 5_000 } });

  const qd = quote?.decimals ?? 18;
  const qs = quote?.symbol ?? "QUOTE";
  const td = meta.decimals;
  const ts = meta.symbol ?? "TOKEN";
  /**
   * Slippage as basis points. An empty or unreadable box is the default, never zero: a zero here reads as
   * "revert unless I get the exact quote", which fails every time and looks like a broken button. The ceiling
   * is 50%, above which a trade is not slippage protection any more.
   */
  const slipPct = Math.min(50, Math.max(0.05, Number(slippage) || DEFAULT_SLIPPAGE_BPS / 100));
  const slipBps = Math.round(slipPct * 100);
  const slipHigh = slipPct >= 5;
  const slipTyped = Number(slippage);
  const slipInvalid = slippage.trim() !== "" && (!Number.isFinite(slipTyped) || slipTyped < 0.05 || slipTyped > 50);
  const amtForRoute = safeParseUnits(amount, 18);

  // the route is chosen for the size being typed: several markets can reach the quote asset, and the one that
  // pays best for this trade is not always the one with the biggest liquidity number
  const route = useZapRoute(launch?.token, launch?.pairToken, side === "buy" ? amtForRoute : undefined, user, side, side === "sell" ? safeParseUnits(amount, td) : undefined);
  const own = route.data?.own;
  const ethPath = route.data?.path ?? null;
  // ETH is the default way in when a route exists; the quote asset is always an option on an ERC-20 pair
  const ethAvailable = nativePair || !!ethPath;
  const inEth = nativePair || (payEth && !!ethPath);
  const payDecimals = inEth ? 18 : qd;
  const paySymbol = inEth ? "ETH" : qs;
  const outSymbol = inEth ? "ETH" : qs;
  const outDecimals = inEth ? 18 : qd;
  const amt = safeParseUnits(amount, side === "buy" ? payDecimals : td);
  // the coin's first five seconds: a buy pays the snipe tax on its way out of the pool. the coin itself says the
  // rate for this wallet this second, so the panel asks it while a launch is fresh and shows what will arrive
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, []);
  const fresh = now > 0 && !!launch && now - Number(launch.launchedAt) < 30;
  const snipe = useReadContract({
    abi: TokenAbi,
    address: launch?.token,
    functionName: "currentSnipeTaxBps",
    args: [user ?? ZERO],
    query: { enabled: fresh && !!launch, refetchInterval: 1_000 },
  });
  const snipeBps = fresh ? Number(snipe.data ?? 0n) : 0;
  // launch protection, in blocks: the end block is a constant of the coin, the current block is watched until it is
  // past, and the wallet's own room is asked every second while the window is open. no clock decides any of it
  const endsQ = useReadContract({ abi: TokenAbi, address: launch?.token, functionName: "protectionEndsAtBlock", query: { enabled: !!launch, staleTime: Infinity } });
  const endsAt = endsQ.data;
  const blockNo = useBlockNumber({
    query: { enabled: !!launch && endsAt !== undefined, refetchInterval: (q) => (endsAt !== undefined && q.state.data !== undefined && q.state.data >= endsAt ? false : 1_000) },
  });
  const blockNow = blockNo.data;
  const guarded = endsAt !== undefined && blockNow !== undefined && blockNow < endsAt;
  const guard = useReadContracts({
    contracts: [
      { abi: TokenAbi, address: launch?.token, functionName: "launchedBlock" },
      { abi: TokenAbi, address: launch?.token, functionName: "remainingBuy", args: [user ?? ZERO] },
      { abi: TokenAbi, address: launch?.token, functionName: "remainingHold", args: [user ?? ZERO] },
    ],
    query: { enabled: guarded && !!launch, refetchInterval: 1_000 },
  });
  const g = (i: number) => (guard.data?.[i]?.status === "success" ? (guard.data[i].result as bigint) : undefined);
  const launchedBlock = g(0);
  const remainingBuy = g(1);
  const remainingHold = g(2);
  const launchBlock = guarded && launchedBlock !== undefined && blockNow === launchedBlock;
  const unlimited = (v?: bigint) => v === undefined || v === (2n ** 256n - 1n);
  const allowance = guarded && !unlimited(remainingBuy) && !unlimited(remainingHold) ? (remainingBuy! < remainingHold! ? remainingBuy! : remainingHold!) : undefined;

  // buys: ETH through the route, or the quote through the one pool
  const buyPath = inEth ? (nativePair && own ? [own] : ethPath) : own ? [own] : null;
  const zp = useZapPreview(side === "buy" && inEth ? launch?.token : undefined, buyPath, side === "buy" && inEth ? amt : undefined, user);
  // a buy paid in the quote asset goes straight through the coin's own pool: the quoter runs that swap across every
  // position the pool has, where one is wired; the local arithmetic, exact for the pool's one launch position, stands in
  const quoter = useQuoterQuote(side === "buy" && !inEth && pool.key ? pool.key : undefined, pool.key ? !pool.key.tokenIs0 : undefined, side === "buy" && !inEth ? amt : undefined);
  const localBuy = useMemo(() => {
    if (side !== "buy" || inEth || !amt || !launch || !pool.key || pool.liquidity === undefined || !pool.sqrtP) return undefined;
    return quoteExactIn({ amountIn: amt, liquidity: pool.liquidity, sqrtPriceX96: pool.sqrtP, feePips: Number(launch.poolFee), zeroForOne: !pool.key.tokenIs0 });
  }, [side, inEth, amt, launch, pool.key, pool.liquidity, pool.sqrtP]);
  const quotedBuy = quoter.data ?? localBuy;
  const buyIsEstimate = side === "buy" && !inEth && quotedBuy !== undefined && !quoter.data;
  // the zap's preview already reports what the buyer keeps; the quoter and the local arithmetic report the pool's count
  const buyOut = inEth ? zp.data?.tokensOut : quotedBuy !== undefined && snipeBps > 0 ? quotedBuy - (quotedBuy * BigInt(snipeBps)) / 10_000n : quotedBuy;

  // sells: the own pool first, then the route backwards to ETH, or the quote straight out of the one pool
  const sellPath = inEth ? (nativePair && own ? [own] : ethPath ? reverseRoute(ethPath) : null) : own ? [own] : null;
  const sellOut = inEth ? ZERO : (launch?.pairToken ?? ZERO);
  const zs = useZapSellPreview(side === "sell" ? launch?.token : undefined, sellPath, side === "sell" ? amt : undefined, user, sellOut);

  const quoteBal = inEth ? native.data?.value : balances.quote;
  const tokenBal = balances.token;
  const insufficient = side === "buy" ? amt !== undefined && quoteBal !== undefined && amt > quoteBal : amt !== undefined && tokenBal !== undefined && amt > tokenBal;
  const routePending = !route.data;

  // the buy would break a launch cap, or it is the launch block: say so instead of letting it revert
  const guardReason =
    side === "buy" && guarded
      ? launchBlock && !unlimited(remainingBuy)
        ? "buying opens next block"
        : allowance !== undefined && buyOut !== undefined && buyOut > allowance
          ? "over the 5% wallet cap for these blocks"
          : undefined
      : undefined;
  const guardBlocks = !!guardReason;
  const canSubmit =
    !!user &&
    !!launch &&
    !!amt &&
    amt > 0n &&
    !insufficient &&
    !guardBlocks &&
    !tx.busy &&
    !routePending &&
    (side === "buy" ? !!buyPath && buyOut !== undefined && buyOut > 0n : !!sellPath && !!zs.data && zs.data.amountOut > 0n);

  async function submit() {
    if (!user || !launch || !amt) return;
    const steps = [];
    if (side === "buy" && buyPath && buyOut !== undefined) {
      const minOut = applySlippage(buyOut, slipBps);
      if (inEth) {
        steps.push({
          label: `Buy ${ts} with ETH`,
          request: (w: WriteFn) =>
            w({ abi: ZapRouterAbi, address: ADDRESSES.zapRouter, functionName: "zapBuy", args: [zapParams(launch.token, buyPath, user, minOut)], value: amt }),
        });
      } else {
        if ((balances.quoteAllowance ?? 0n) < amt) {
          steps.push({
            label: `Approve ${qs}`,
            request: (w: WriteFn) => w({ abi: erc20Abi, address: launch.pairToken, functionName: "approve", args: [ADDRESSES.zapRouter, amt] }),
          });
        }
        steps.push({
          label: `Buy ${ts} with ${qs}`,
          request: (w: WriteFn) =>
            w({ abi: ZapRouterAbi, address: ADDRESSES.zapRouter, functionName: "zapBuy", args: [zapParams(launch.token, buyPath, user, minOut, launch.pairToken, amt)] }),
        });
      }
    } else if (side === "sell" && sellPath && zs.data) {
      const minOut = applySlippage(zs.data.amountOut, slipBps);
      if ((balances.tokenAllowance ?? 0n) < amt) {
        steps.push({
          label: `Approve ${ts}`,
          request: (w: WriteFn) => w({ abi: TokenAbi, address: launch.token, functionName: "approve", args: [ADDRESSES.zapRouter, amt] }),
        });
      }
      steps.push({
        label: `Sell ${ts} for ${outSymbol}`,
        request: (w: WriteFn) =>
          w({ abi: ZapRouterAbi, address: ADDRESSES.zapRouter, functionName: "zapSell", args: [zapSellParams(launch.token, amt, sellPath, user, minOut, sellOut)] }),
      });
    }
    const h = await tx.run(steps);
    if (h) {
      setAmount("");
      d.refetch();
    }
  }

  /** A share of what the wallet holds, in the box: the whole balance at 10,000, with gas headroom kept when paying in ETH. */
  const setShare = (bps: bigint) => {
    if (side === "buy") {
      if (quoteBal === undefined) return;
      const spendable = inEth ? (quoteBal > 10n ** 15n ? quoteBal - 10n ** 15n : 0n) : quoteBal;
      setAmount(fmtRaw((spendable * bps) / 10_000n, payDecimals));
    } else if (tokenBal !== undefined) setAmount(fmtRaw((tokenBal * bps) / 10_000n, td));
  };
  const setMax = () => setShare(10_000n);
  const amountBox = useRef<HTMLInputElement>(null);

  const poolFeeBps = launch ? Number(launch.poolFee) / 100 : undefined;
  const baseBps = policy ? Number(policy.hookFeeBps) : undefined;

  return (
    <Panel
      title={
        <div ref={sideTrack} className="glide-track flex gap-1">
          <GlideIndicator indRef={sideInd} />
          <button className="tab glide-item" data-active={side === "buy"} data-glide-active={side === "buy"} onClick={() => setSide("buy")}>
            Buy
          </button>
          <button className="tab glide-item" data-active={side === "sell"} data-glide-active={side === "sell"} onClick={() => setSide("sell")}>
            Sell
          </button>
        </div>
      }
      right={
        <button
          type="button"
          className={`slip-toggle ${slipHigh ? "is-high" : ""}`}
          aria-expanded={slipOpen}
          onClick={() => setSlipOpen((v) => !v)}
          title="the worst price you will accept"
        >
          max slip <span className="num">{slipPct}%</span>
        </button>
      }
      className="lg:sticky lg:top-24"
    >
      <div className="space-y-4">
        <div>
          <div className="flex justify-between text-[13px] text-muted mb-1.5">
            <span className="label label-muted">{side === "buy" ? `Pay (${paySymbol})` : `Sell (${ts})`}</span>
            <button className="hover:text-white num" onClick={setMax} type="button">
              bal {side === "buy" ? fmtAmount(quoteBal, payDecimals, { sig: 4 }) : fmtAmount(tokenBal, td, { sig: 4 })}
            </button>
          </div>
          <input ref={amountBox} className="num !text-[20px]" inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} />
          {/* a share of the balance in one tap; the pencil is for typing a number */}
          <div className="amount-quick" role="group" aria-label="amount as a share of the balance">
            {[1_000n, 2_500n, 5_000n, 10_000n].map((bps) => (
              <button key={bps.toString()} type="button" className="num" onClick={() => setShare(bps)} disabled={side === "buy" ? quoteBal === undefined : tokenBal === undefined}>
                {Number(bps) / 100}%
              </button>
            ))}
            <button type="button" aria-label="type an amount" title="type an amount" onClick={() => amountBox.current?.focus()}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
          </div>
          {!nativePair && ethAvailable && (
            <button
              type="button"
              className="mt-1.5 text-[13px] text-muted hover:text-white"
              onClick={() => {
                setPayEth(!payEth);
                if (side === "buy") setAmount("");
              }}
            >
              {side === "buy" ? (payEth ? `pay in ${qs} instead` : "pay in ETH instead") : payEth ? `receive ${qs} instead` : "receive ETH instead"}
            </button>
          )}
        </div>

        <div className="pt-1">
          {side === "buy" ? (
            <>
              <Row k={`Receive (${ts})`} v={buyOut !== undefined ? fmtAmount(buyOut, td) : amt && zp.isFetching ? "quoting" : "-"} />
              <Row k="Min. after slippage" v={buyOut !== undefined ? `${fmtAmount(applySlippage(buyOut, slipBps), td)} ${ts}` : "-"} />
              {inEth && zp.isError && <div className="text-[13px] text-danger">no quote at this size. try a smaller amount{nativePair ? "" : `, or pay in ${qs}`}.</div>}
              {guarded && (
                <div className="text-[13px] text-signal">
                  first two blocks: 5% per wallet.{" "}
                  {launchBlock ? "buying opens next block." : allowance !== undefined ? `you may still buy ${fmtAmount(allowance, td, { sig: 4 })} ${ts}.` : ""}
                </div>
              )}
              {snipeBps > 0 && (
                <div className="text-[13px] text-signal">
                  launch window: a buy this second pays a {(snipeBps / 100).toFixed(snipeBps % 100 === 0 ? 0 : 1)}% snipe tax, burned. it is gone within five seconds of launch.
                </div>
              )}
              <details className="trade-more">
                <summary>breakdown</summary>
                <Row k="Route" v={inEth ? (route.data?.label ?? "") : `${qs} → coin`} />
                {!inEth && <Row k="Quote" v={buyIsEstimate ? "estimate from the pool's one position" : "the quoter, across every position"} />}
                {inEth && !nativePair && <Row k={`Swapped to ${qs}`} v={zp.data ? `${fmtAmount(zp.data.quoteOut, qd)} ${qs}` : "-"} />}
                <Row k="Pool fee" v={poolFeeBps !== undefined ? bpsToPct(poolFeeBps) : "-"} />
              </details>
            </>
          ) : (
            <>
              <Row k={`Receive (${outSymbol})`} v={zs.data ? fmtAmount(zs.data.amountOut, outDecimals) : amt && zs.isFetching ? "quoting" : "-"} />
              <Row k="Min. after slippage" v={zs.data ? `${fmtAmount(applySlippage(zs.data.amountOut, slipBps), outDecimals)} ${outSymbol}` : "-"} />
              {zs.isError && <div className="text-[13px] text-danger">no quote at this size. try a smaller amount{inEth && !nativePair ? `, or receive ${qs}` : ""}.</div>}
              <details className="trade-more">
                <summary>breakdown</summary>
                <Row k="Route" v={inEth ? `coin → ${route.data?.label?.replace(/ → coin$/, "").split(" → ").reverse().join(" → ") ?? "ETH"}` : `coin → ${qs}`} />
                <Row k="Pool fee" v={poolFeeBps !== undefined ? bpsToPct(poolFeeBps) : "-"} />
              </details>
            </>
          )}
        </div>

        {slipOpen && (
          <div className="slip">
            <div className="slip-head">
              <span className="label label-muted">max slippage</span>
              <span className="text-dim text-[12.5px]">the trade reverts if the price moves further than this</span>
            </div>
            <div className="slip-row">
              {[0.5, 1, 2].map((v) => (
                <button key={v} type="button" className="slip-chip" data-active={!slipInvalid && slipPct === v} onClick={() => setSlippage(String(v))}>
                  {v}%
                </button>
              ))}
              <span className="slip-custom">
                <input
                  className="num"
                  inputMode="decimal"
                  aria-label="custom slippage percent"
                  placeholder="custom"
                  value={slippage}
                  onChange={(e) => setSlippage(e.target.value.replace(/[^0-9.]/g, "").slice(0, 5))}
                />
                <span aria-hidden="true">%</span>
              </span>
            </div>
            {slipInvalid ? (
              <p className="slip-note is-warn">between 0.05% and 50%. using {slipPct}%.</p>
            ) : slipHigh ? (
              <p className="slip-note is-warn">high: you could pay up to {slipPct}% worse than the quote.</p>
            ) : (
              <p className="slip-note">a small buffer for price movement between your click and the block.</p>
            )}
          </div>
        )}

        {!user ? (
          <Notice>Connect a wallet to trade.</Notice>
        ) : (
          <button className={`btn w-full ${side === "buy" ? "btn-buy" : "btn-sell"}`} disabled={!canSubmit} onClick={submit}>
            {tx.busy ? (
              (tx.step ?? "Working…")
            ) : routePending ? (
              route.isFetching ? (
                "finding this pool"
              ) : (
                "no route to this pool"
              )
            ) : guardReason ? (
              guardReason
            ) : insufficient ? (
              "Insufficient balance"
            ) : (
              <>
                {side === "buy" ? "buy" : "sell"} <span className="num">{ts}</span>
                {side === "sell" ? ` for ${outSymbol}` : ""}
              </>
            )}
          </button>
        )}
        {routePending && !route.isFetching && (
          <button type="button" className="btn btn-sm w-full" onClick={() => route.refetch()}>
            try again
          </button>
        )}
        <TxStatus {...tx} />
        <div className="text-[12.5px] text-dim">
          pool fee {poolFeeBps !== undefined ? bpsToPct(poolFeeBps) : "-"}
          {launch && launch.creatorTaxBps > 0 && baseBps !== undefined ? ` (${bpsToPct(baseBps)} base + ${bpsToPct(launch.creatorTaxBps)} creator tax)` : ""}, inside the swap.
        </div>
      </div>
    </Panel>
  );
}

function fmtRaw(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals);
  const f = s.slice(s.length - decimals).replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}
