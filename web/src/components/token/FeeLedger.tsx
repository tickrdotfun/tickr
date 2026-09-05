"use client";

import type { TokenData } from "@/hooks/useTokenData";
import { useTx } from "@/hooks/useTx";
import { FeeEscrowAbi, LaunchLockerAbi } from "@/lib/abis";
import { ADDRESSES, BURN, sameAddr } from "@/lib/addresses";
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
  const collected = fees.collected;

  const collect = () =>
    tx
      .run([{ label: "collect fees", request: (w) => w({ abi: LaunchLockerAbi, address: ADDRESSES.launchLocker, functionName: "collectFees", args: [launch.token] }) }])
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
      <div className="ledger-head">
        <span className="ledger-split">
          <span className="num">{split ? `${Math.round(split.creatorShareBps / 100)}%` : "-"}</span> creator
          {split && split.clubShareBps > 0 && (
            <>
              <span className="ledger-dot" />
              <span className="num">{Math.round(split.clubShareBps / 100)}%</span> ticker club
            </>
          )}
          <span className="ledger-dot" />
          <span className="num">{split ? `${Math.round(split.protocolShareBps / 100)}%` : "-"}</span> protocol
          <span className="ledger-frozen">frozen at launch</span>
        </span>
        <span className="ledger-recip">
          creator fees to <span className="num">{shortAddr(launch.creatorFeeRecipient)}</span>
          {isCreator && <span className="text-signal"> (you)</span>}
        </span>
      </div>

      <ol className="ledger">
        <Stage
          n={1}
          label="accrues"
          title="the pool"
          amount={`${fmtAmount(pendingQuote, qd)} ${qs}`}
          note={`plus ${fmtAmount(pendingCoin, meta.decimals, { sig: 4 })} ${ts} on the coin side. buys pay in ${qs || "the quote"}, sells pay in ${ts}.`}
          action="collect"
          onAction={collect}
          disabled={tx.busy || !user || !inPool}
          live={inPool}
        />
        <Stage
          n={2}
          label="escrowed"
          title="the escrow"
          amount={user ? `${fmtAmount(quoteClaimable, qd)} ${nativePair ? "ETH" : qs}` : "connect"}
          note={user ? `your balance in ${shortAddr(ADDRESSES.feeEscrow)}. buys paid this in ${nativePair ? "ETH" : qs || "the quote"}` : "connect a wallet to see your balance"}
          action={`claim ${nativePair ? "ETH" : qs}`}
          onAction={claimQuote}
          disabled={tx.busy || !user || quoteClaimable === 0n}
          live={quoteClaimable > 0n}
          primary
        />
        <Stage
          n={3}
          label="burned"
          title={shortAddr(BURN)}
          amount={`${fmtAmount(fees.burned, meta.decimals, { sig: 4 })} ${ts}`}
          note={`every sell burns its fee in the coin. ${fmtAmount(fees.burned ?? 0n, meta.decimals, { sig: 4 })} burned, ${burnedPct ?? "0.00"}% of supply${burnedUsd !== undefined && burnedUsd > 0 ? `, about ${fmtUsd(burnedUsd)}` : ""}.`}
          live={(fees.burned ?? 0n) > 0n}
        />
      </ol>

      <dl className="detail-rows">
        <div className="detail-row">
          <dt>collected so far</dt>
          <dd>
            <span className="num">
              {fmtAmount(collected?.quote, qd)} {qs}
            </span>{" "}
            and{" "}
            <span className="num">
              {fmtAmount(collected?.coin, meta.decimals, { sig: 4 })} {ts}
            </span>
            {collected ? <span className="text-dim"> over {collected.count} collection{collected.count === 1 ? "" : "s"}</span> : null}
          </dd>
        </div>
        <div className="detail-row">
          <dt>of that, to the creator</dt>
          <dd>
            <span className="num">
              {fmtAmount(collected?.creatorQuote, qd)} {qs}
            </span>
            <span className="text-dim"> and none of the coin, which burns</span>
          </dd>
        </div>
      </dl>

      <details className="ledger-more">
        <summary>how collecting works</summary>
        <p>
          the pool&apos;s fee lands in the locked position like any uniswap fee. collecting is permissionless: anyone can call it, and it
          splits under the policy frozen into this launch. the quote side goes to the escrow for the protocol and the creator
          {split && split.clubShareBps > 0 ? ", and to the ticker club" : ""}. the coin side, what sells paid in the coin, is burned in full to the dead
          address. the creator&apos;s tax on buys is the creator&apos;s alone.
        </p>
      </details>

      <TxStatus {...tx} />
    </div>
  );
}

function Stage({
  n,
  label,
  title,
  amount,
  note,
  action,
  onAction,
  disabled,
  live = false,
  primary = false,
  secondAction,
  onSecondAction,
  secondDisabled,
}: {
  n: number;
  label: string;
  title: string;
  amount: string;
  note: string;
  action?: string;
  onAction?: () => void;
  disabled?: boolean;
  live?: boolean;
  primary?: boolean;
  secondAction?: string;
  onSecondAction?: () => void;
  secondDisabled?: boolean;
}) {
  return (
    <li className="stage" data-live={live}>
      <div className="stage-k">
        <span className="stage-n num">{n}</span>
        {label}
      </div>
      <div className="stage-t">{title}</div>
      <div className="stage-v num">{amount}</div>
      <div className="stage-n-note">{note}</div>
      {action && (
        <button className={`btn btn-sm ${primary ? "btn-primary" : ""} stage-btn`} disabled={disabled} onClick={onAction}>
          {action}
        </button>
      )}
      {secondAction && (
        <button className="btn btn-sm stage-btn" disabled={secondDisabled} onClick={onSecondAction}>
          {secondAction}
        </button>
      )}
    </li>
  );
}
