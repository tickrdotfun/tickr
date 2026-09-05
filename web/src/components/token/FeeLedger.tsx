"use client";

import type { TokenData } from "@/hooks/useTokenData";
import { useTx } from "@/hooks/useTx";
import { FeeEscrowAbi, LaunchLockerAbi } from "@/lib/abis";
import { ADDRESSES, sameAddr } from "@/lib/addresses";
import { fmtAmount, shortAddr, type FeeSplit, fmtUsd } from "@/lib/format";
import { TxStatus } from "../TxStatus";

/**
 * Fees, as the pipeline they are: they accrue in the locked position, anyone collects them into the escrow
 * under the launch's frozen split, and whoever earned them pulls them from there. The protocol's coin share is
 * burned on the way.
 */
export function FeeLedger({ d, split, burnedUsd }: { d: TokenData; split?: FeeSplit; burnedUsd?: number }) {
  const { user, quote, nativePair, fees, escrow, launch, meta } = d;
  const tx = useTx();
  if (!launch) return null;

  const qd = quote?.decimals ?? 18;
  const qs = quote?.symbol ?? "";
  const ts = meta.symbol ?? "token";
  const isCreator = !!user && sameAddr(user, launch.creatorFeeRecipient);
  const pendingQuote = fees.pending?.quote ?? 0n;
  const pendingCoin = fees.pending?.coin ?? 0n;
  const burnedPct = meta.totalSupply && meta.totalSupply > 0n ? (Number(((fees.burned ?? 0n) * 10_000n) / meta.totalSupply) / 100).toFixed(2) : undefined;
  const inPool = pendingQuote > 0n || pendingCoin > 0n;
  const quoteClaimable = (nativePair ? escrow.native : escrow.quoteToken) ?? 0n;
  const coinClaimable = escrow.coin ?? 0n;
  const collected = fees.collected;

  const collect = () =>
    tx
      .run([{ label: "collect fees", request: (w) => w({ abi: LaunchLockerAbi, address: ADDRESSES.launchLocker, functionName: "collectFees", args: [launch.token] }) }])
      .then((h) => h && d.refetch());

  const claimCoin = () =>
    tx
      .run([{ label: `claim ${ts}`, request: (w) => w({ abi: FeeEscrowAbi, address: ADDRESSES.feeEscrow, functionName: "claimToken", args: [launch.token] }) }])
      .then((h) => h && d.refetch());

  const claimQuote = () =>
    tx
      .run([
        nativePair
          ? { label: "claim ETH", request: (w) => w({ abi: FeeEscrowAbi, address: ADDRESSES.feeEscrow, functionName: "claim" }) }
          : { label: `claim ${qs}`, request: (w) => w({ abi: FeeEscrowAbi, address: ADDRESSES.feeEscrow, functionName: "claimToken", args: [launch.pairToken] }) },
      ])
      .then((h) => h && d.refetch());

  return (
    <div className="ledger-wrap">
      <dl className="detail-rows detail-rows-first">
        <div className="detail-row">
          <dt>collected so far</dt>
          <dd>
            <span className="num">
              {fmtAmount(collected?.quote, qd)} {qs}
            </span>
            {collected && collected.count > 0 && (
              <span className="text-dim">
                {" "}
                in {collected.count} collection{collected.count === 1 ? "" : "s"}
              </span>
            )}
          </dd>
        </div>
        <div className="detail-row">
          <dt>to the creator</dt>
          <dd>
            <span className="num">
              {fmtAmount(collected?.creatorQuote, qd)} {qs}
            </span>
            <span className="text-dim">
              {" "}
              {shortAddr(launch.creatorFeeRecipient)}
              {isCreator ? ", you" : ""}
            </span>
          </dd>
        </div>
        <div className="detail-row">
          <dt>burned</dt>
          <dd>
            <span className="num">
              {fmtAmount(fees.burned, meta.decimals, { sig: 4 })} {ts}
            </span>
            <span className="text-dim">
              {" "}
              {burnedPct ?? "0.00"}% of supply{burnedUsd !== undefined && burnedUsd > 0 ? `, about ${fmtUsd(burnedUsd)}` : ""}
            </span>
          </dd>
        </div>
        <div className="detail-row detail-row-action">
          <dt>in the pool now</dt>
          <dd>
            <span className="num">
              {fmtAmount(pendingQuote, qd)} {qs}
            </span>
            <span className="text-dim">
              {" "}
              + {fmtAmount(pendingCoin, meta.decimals, { sig: 4 })} {ts}
            </span>
            <button className="btn btn-xs" disabled={tx.busy || !user || !inPool} onClick={collect}>
              collect
            </button>
          </dd>
        </div>
        <div className="detail-row detail-row-action">
          <dt>yours to claim</dt>
          <dd>
            {user ? (
              <span className="num">
                {fmtAmount(quoteClaimable, qd)} {nativePair ? "ETH" : qs}
              </span>
            ) : (
              <span className="text-dim">connect a wallet</span>
            )}
            <button className="btn btn-xs btn-primary" disabled={tx.busy || !user || quoteClaimable === 0n} onClick={claimQuote}>
              claim
            </button>
          </dd>
        </div>
        <div className="detail-row detail-row-action">
          <dt>yours to claim, in {ts}</dt>
          <dd>
            {user ? (
              <span className="num">
                {fmtAmount(coinClaimable, meta.decimals, { sig: 4 })} {ts}
              </span>
            ) : (
              <span className="text-dim">connect a wallet</span>
            )}
            <button className="btn btn-xs btn-primary" disabled={tx.busy || !user || coinClaimable === 0n} onClick={claimCoin}>
              claim
            </button>
          </dd>
        </div>
      </dl>
      <p className="detail-note detail-note-tight">
        the pool&apos;s fee sits in the locked position until anyone collects it. both sides split {split ? `${Math.round(split.creatorShareBps / 100)} / ${split.clubShareBps > 0 ? `${Math.round(split.clubShareBps / 100)} / ` : ""}${Math.round(split.protocolShareBps / 100)}` : ""}: the creator&apos;s share and the tax are theirs, the rest of the coin side burns.
      </p>
      <TxStatus {...tx} />
    </div>
  );
}
