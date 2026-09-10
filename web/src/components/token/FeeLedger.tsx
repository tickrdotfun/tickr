"use client";

import type { TokenData } from "@/hooks/useTokenData";
import { gasWithHeadroom } from "@/lib/gasHeadroom";
import { useTx } from "@/hooks/useTx";
import { usePublicClient } from "wagmi";
import { FeeEscrowAbi, LaunchLockerAbi } from "@/lib/abis";
import { ADDRESSES, sameAddr } from "@/lib/addresses";
import { fmtAmount, shortAddr, type FeeSplit, fmtUsd } from "@/lib/format";
import { TxStatus } from "../TxStatus";
import { MoveFees } from "./CreatorControls";

/**
 * Fees, as the pipeline they are: they accrue in the locked position, anyone collects them into the escrow
 * under the launch's frozen split, and whoever earned them pulls them from there. The protocol's coin share is
 * burned on the way.
 */
export function FeeLedger({ d, split, burnedUsd }: { d: TokenData; split?: FeeSplit; burnedUsd?: number }) {
  const { user, quote, nativePair, fees, escrow, launch, meta } = d;
  const client = usePublicClient();
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

  /**
   * Collecting costs more when a sell has landed since the estimate, because the coin side has to be burned.
   * The wallet estimates for itself and is subject to the same race, so the limit is set here with headroom
   * measured on chain rather than left to whatever the wallet last saw.
   */
  const collect = () =>
    tx
      .run([
        {
          label: "collect fees",
          request: async (w) => {
            const call = { abi: LaunchLockerAbi, address: ADDRESSES.launchLocker, functionName: "collectFees", args: [launch.token] } as const;
            // No fallback to the wallet's own estimate. The wallet estimates without headroom and is subject
            // to the same race: a sell landing between its estimate and inclusion adds the burn leg and the
            // transaction fails on gas, having paid for the whole limit. If the limit cannot be established
            // here, the collection does not go out.
            if (!client) throw new Error("cannot reach the chain to size this transaction. try again in a moment.");
            if (!user) throw new Error("connect a wallet to collect fees.");
            const estimate = await client.estimateContractGas({ ...call, account: user }).catch(() => {
              throw new Error("could not work out the gas this collection needs. try again in a moment.");
            });
            const sized = gasWithHeadroom(estimate);
            if (!sized.ok) throw new Error(sized.reason);
            return w({ ...call, gas: sized.gas });
          },
        },
      ])
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
      <MoveFees d={d} />
      <p className="detail-note detail-note-tight">
        the pool&apos;s fee sits in the locked position until anyone collects it. both sides split {split ? `${Math.round(split.creatorShareBps / 100)} / ${split.clubShareBps > 0 ? `${Math.round(split.clubShareBps / 100)} / ` : ""}${Math.round(split.protocolShareBps / 100)}` : ""}: the creator&apos;s share and the tax are theirs, the rest of the coin side burns.
       on the coin side, what sells pay, the protocol&apos;s and the club&apos;s parts are burned; the creator&apos;s part and tax are credited in the coin.</p>
      <TxStatus {...tx} />
    </div>
  );
}
