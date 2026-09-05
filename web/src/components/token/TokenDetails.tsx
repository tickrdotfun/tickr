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
          <>
            <div className="fact-grid">
              <Fact
                k="pool fee"
                v={pct(Number(launch.poolFee) / 1_000_000, 2)}
                sub={baseBps !== undefined ? `${pct(baseBps / 10_000, 2)} base${launch.creatorTaxBps > 0 ? ` + ${pct(launch.creatorTaxBps / 10_000, 2)} creator tax` : ""}` : "uniswap v4, set at launch"}
              />
              <Fact
                k="base fee split"
                v={split ? [split.creatorShareBps, ...(split.clubShareBps > 0 ? [split.clubShareBps] : []), split.protocolShareBps].map((b) => String(Math.round(b / 100))).join(" / ") : "-"}
                sub={split ? `percent to ${split.clubShareBps > 0 ? "creator, ticker club, protocol" : "creator, protocol"}. frozen at launch` : "frozen at launch"}
              />
              <Fact
                k="creator tax"
                v={launch.creatorTaxBps > 0 ? pct(launch.creatorTaxBps / 10_000, 2) : "none"}
                sub={launch.creatorTaxBps > 0 ? "all of it to the creator" : "the creator set none"}
              />
              <Fact k="liquidity" v="locked" sub="the position cannot be withdrawn" />
            </div>
            <dl className="detail-rows">
              <DRow k="lp position">
                <span className="num">#{launch.lpTokenId.toString()}</span> <span className="chip-lock">locked forever</span>
              </DRow>
              {pool.poolId && (
                <DRow k="pool id">
                  <span className="num detail-hex" title={pool.poolId}>
                    {pool.poolId.slice(0, 10)}…{pool.poolId.slice(-8)}
                  </span>
                </DRow>
              )}
            </dl>
          </>
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

function Fact({ k, v, sub }: { k: string; v: string; sub: string }) {
  return (
    <div className="fact">
      <div className="fact-k">{k}</div>
      <div className="fact-v num">{v}</div>
      <div className="fact-s">{sub}</div>
    </div>
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
