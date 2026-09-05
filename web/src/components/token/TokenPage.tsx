"use client";

import type { Address } from "viem";
import { useTokenData } from "@/hooks/useTokenData";
import { DEPLOYED } from "@/lib/addresses";
import { fmtAmount, fmtNumber, fmtPrice, shortAddr, fmtUsd } from "@/lib/format";
import { isOfficialCoin, isZero, ADDRESSES } from "@/lib/addresses";
import { TokenLogo } from "../TokenLogo";
import { Panel, Spinner } from "../ui";
import { TradePanel } from "./TradePanel";
import { TokenDetails } from "./TokenDetails";
import { PriceChart } from "./PriceChart";
import { Buyback } from "./Buyback";
import { useMarketData } from "@/hooks/useMarketData";
import { sameAddr } from "@/lib/addresses";

/** The chart sites index Robinhood Chain by its v4 pool id. Only the public chain is listed there. */
export const dexScreenerUrl = (poolId: string) => `https://dexscreener.com/robinhood/${poolId}`;

export function TokenPage({ address }: { address: Address }) {
  // hooks first: the page returns early while it loads
  const market = useMarketData();
  const d = useTokenData(address);

  if (!DEPLOYED) return <div className="text-muted">Contracts are not deployed; nothing to show.</div>;
  if (d.launchQ.isLoading)
    return (
      <div className="text-muted inline-flex items-center gap-2">
        <Spinner /> Loading…
      </div>
    );
  if (d.notFound)
    return (
      <div>
        <div className="font-semibold text-[18px]">Unknown token</div>
        <div className="text-muted mt-2 num">{address} was not launched by this factory.</div>
      </div>
    );
  const { launch, meta, quote, pool, fees } = d;
  if (!launch) return null;

  const qd = quote?.decimals ?? 18;
  const qs = quote?.symbol ?? "";
  const price = pool.price;
  const mcap = pool.marketCap;
  const feesQuote = (fees.pending?.quote ?? 0n) + (fees.collected?.quote ?? 0n);
  const burnedPct = meta.totalSupply && meta.totalSupply > 0n ? (Number(((fees.burned ?? 0n) * 10_000n) / meta.totalSupply) / 100).toFixed(2) : undefined;
  // the burn in dollars: burned coins at the pool price, through the quote's dollar rate the home grid already knows
  const row = market.data?.rows.find((r) => sameAddr(r.launch.token, address));
  const rate = row?.marketCapUsd !== undefined && row.marketCap ? row.marketCapUsd / row.marketCap : undefined;
  const burnedCoins = Number(fees.burned ?? 0n) / 10 ** (meta.decimals ?? 18);
  const burnedUsd = rate !== undefined && price !== undefined ? burnedCoins * price * rate : undefined;
  const socials = meta.socials;
  const links = socials
    ? (
        [
          ["Twitter", socials.twitter],
          ["Discord", socials.discord],
          ["Website", socials.website],
          ["Farcaster", socials.farcaster],
        ] as const
      ).filter(([, v]) => !!v)
    : [];

  return (
    <div>
      <div className="flex flex-col lg:flex-row gap-12">
        <div className="flex-1 min-w-0 space-y-12">
          {/* Header */}
          <Panel>
            <div className="flex items-start gap-3">
              <TokenLogo src={meta.logo} symbol={meta.symbol} size={64} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate">{meta.name ?? shortAddr(address)}</h1>
                  <span className="num text-muted text-[18px]">{meta.symbol}</span>
                  <span className="badge sw-signal">live</span>
                  {isOfficialCoin(address) && <span className="badge sw-green">official coin</span>}
                </div>
                {meta.description && <p className="text-muted mt-3 max-w-2xl whitespace-pre-wrap break-words">{meta.description}</p>}
                {links.length > 0 && (
                  <div className="flex flex-wrap gap-4 mt-3 text-[14px]">
                    {links.map(([k, v]) => (
                      <a key={k} href={/^https?:\/\//i.test(v) ? v : `https://${v}`} target="_blank" rel="noreferrer">
                        {k}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Panel>

          <PriceChart d={d} />

          {/* Stats */}
          <Panel>
            <div className="fig-grid">
              <Figure hue="signal" label="pool price" n={fmtPrice(price)} unit={qs} sub={`per ${meta.symbol ?? "token"}`} />
              <Figure hue="blue" label="market cap" n={mcap !== undefined ? fmtNumber(mcap) : "-"} unit={mcap !== undefined ? qs : ""} sub={`opened at ${fmtAmount(launch.phantomQuote, qd, { sig: 4 })} ${qs}`} />
              <Figure hue="yellow" label="liquidity" n={pool.quoteInPool !== undefined ? fmtNumber(pool.quoteInPool) : "-"} unit={qs} sub="in the locked position, quote side" />
              <Figure hue="orange" label="fees earned" n={fmtAmount(feesQuote, qd, { sig: 4 })} unit={qs} sub="in the quote, on buys. sells pay in the coin, split the same way" />
              <Figure hue="pink" label="burned" n={fmtAmount(fees.burned ?? 0n, meta.decimals, { sig: 4 })} unit={meta.symbol ?? ""} sub={`${burnedPct !== undefined ? `${burnedPct}% of supply` : "dead address balance"}${burnedUsd !== undefined && burnedUsd > 0 ? `, about ${fmtUsd(burnedUsd)}` : ""}`} />
            </div>
          </Panel>

          {isOfficialCoin(address) && !isZero(ADDRESSES.buybackTreasury) && (
            <Panel>
              <Buyback d={d} />
            </Panel>
          )}

          <TokenDetails d={d} address={address} burnedUsd={burnedUsd} />
        </div>

        <div className="lg:w-[380px] shrink-0">
          <TradePanel d={d} />
        </div>
      </div>
    </div>
  );
}

/** One number that matters, given its own hue on a short dash, a bold figure and a quiet unit. */
function Figure({ hue, label, n, unit, sub }: { hue: "yellow" | "orange" | "signal" | "blue" | "pink"; label: string; n: string; unit: string; sub?: string }) {
  return (
    <div className={`fig fig-${hue}`}>
      <div className="fig-k">{label}</div>
      <div className="fig-v">
        <span className="num fig-n">{n}</span>
        {unit && <span className="fig-u">{unit}</span>}
      </div>
      {sub && <div className="fig-s">{sub}</div>}
    </div>
  );
}
