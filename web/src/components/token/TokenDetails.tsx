"use client";

import { useState } from "react";
import type { Address } from "viem";
import type { TokenData } from "@/hooks/useTokenData";
import { ADDRESSES, isZero } from "@/lib/addresses";
import { explorerAddress, explorerToken } from "@/lib/chain";
import { pct } from "@/lib/format";
import { CopyAddr } from "./CopyAddr";
import { FeeLedger } from "./FeeLedger";
import { TickerClub } from "./TickerClub";

type Tab = "market" | "fees" | "club" | "addresses";

/**
 * Everything below the figures, one thing at a time. The page asks what you came for and shows only that.
 */
export function TokenDetails({ d, address, burnedUsd }: { d: TokenData; address: Address; burnedUsd?: number }) {
  const { launch, pool, policy, isTicker } = d;
  const [tab, setTab] = useState<Tab>("market");
  if (!launch) return null;

  const split = policy ? { creatorShareBps: Number(policy.creatorShareBps), clubShareBps: Number(policy.clubShareBps), protocolShareBps: Number(policy.protocolShareBps) } : undefined;
  const baseBps = policy ? Number(policy.hookFeeBps) : undefined;

  const tabs: [Tab, string][] = [
    ["market", "the pool"],
    ["fees", "fees"],
    ...(isTicker ? ([["club", "ticker club"]] as [Tab, string][]) : []),
    ["addresses", "addresses"],
  ];

  return (
    <section className="detail">
      <div className="detail-tabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className="detail-tab" data-active={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      <div className="detail-body">
        {tab === "market" && (
          <dl className="detail-rows detail-rows-first">
            <DRow k="pool fee">
              <span className="num">{pct(Number(launch.poolFee) / 1_000_000, 2)}</span>
              {baseBps !== undefined && launch.creatorTaxBps > 0 && <span className="text-dim"> {pct(baseBps / 10_000, 2)} base + {pct(launch.creatorTaxBps / 10_000, 2)} creator tax</span>}
            </DRow>
            <DRow k="fee split">
              <span className="num">{split ? [split.creatorShareBps, ...(split.clubShareBps > 0 ? [split.clubShareBps] : []), split.protocolShareBps].map((b) => String(Math.round(b / 100))).join(" / ") : "-"}</span>
              <span className="text-dim"> {split ? (split.clubShareBps > 0 ? "creator, ticker club, protocol" : "creator, protocol") : ""}, frozen at launch</span>
            </DRow>
            <DRow k="creator tax">{launch.creatorTaxBps > 0 ? <span className="num">{pct(launch.creatorTaxBps / 10_000, 2)}</span> : "none"}</DRow>
            <DRow k="liquidity">
              locked forever <span className="text-dim">position </span>
              <span className="num">#{launch.lpTokenId.toString()}</span>
            </DRow>
            {pool.poolId && (
              <DRow k="pool id">
                <span className="num detail-hex" title={pool.poolId}>
                  {pool.poolId.slice(0, 10)}…{pool.poolId.slice(-8)}
                </span>
              </DRow>
            )}
          </dl>
        )}

        {tab === "fees" && <FeeLedger d={d} split={split} burnedUsd={burnedUsd} />}

        {tab === "club" && isTicker && <TickerClub d={d} />}

        {tab === "addresses" && (
          <dl className="detail-rows">
            <ARow k="coin" a={address} token />
            <ARow k="deployer" a={launch.deployer} />
            <ARow k="creator fee recipient" a={launch.creatorFeeRecipient} />
            <ARow k="pair asset" a={launch.pairToken} token={!isZero(launch.pairToken)} nativeLabel />
            <ARow k="locker" a={ADDRESSES.launchLocker} />
            <ARow k="fee escrow" a={ADDRESSES.feeEscrow} />
          </dl>
        )}
      </div>
    </section>
  );
}

function DRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="detail-row">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ARow({ k, a, token = false, nativeLabel = false }: { k: string; a: Address; token?: boolean; nativeLabel?: boolean }) {
  if (isZero(a) && nativeLabel)
    return (
      <div className="detail-row">
        <dt>{k}</dt>
        <dd>native ETH</dd>
      </div>
    );
  return (
    <div className="detail-row">
      <dt>{k}</dt>
      <dd>
        <CopyAddr a={a} href={token ? explorerToken(a) : explorerAddress(a)} />
      </dd>
    </div>
  );
}
