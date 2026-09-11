"use client";

import type { Address } from "viem";
import { usePairApi, usePairOnChain, type PairKind } from "@/hooks/usePairInfo";

import { explorerAddress, explorerToken } from "@/lib/chain";
import { StockLogo } from "../StockLogo";
import { fmtAmount, fmtUsd, shortAddr, timeAgo } from "@/lib/format";
import { OfficialBadge } from "../QuoteChip";

const KIND_LINE: Record<PairKind, string> = {
  stock: "official Stock Token, in the Robinhood Assets registry",
  ticker: "redeemable name: a one-for-one wrapper of USDG",
  coin: "a coin launched on tickr",
  usdg: "USDG, the dollar stablecoin on Robinhood Chain",
  native: "native ETH",
  other: "not a pair on tickr",
};

/**
 * Everything worth knowing about an address before pricing a coin in it, from three sources that do not trust
 * each other: the Robinhood Assets registry (is it genuine), the chain (what it is and what it holds), and the explorer
 * (who holds it, how much it trades, and how many lookalikes wear its name).
 */
export function PairCard({ address }: { address: Address }) {
  const api = usePairApi(address);
  const chain = usePairOnChain(address);
  const a = api.data;
  const c = chain.data;
  const kind: PairKind = c?.kind ?? (a?.genuine ? "stock" : "other");
  const symbol = c?.symbol ?? a?.genuine?.symbol ?? a?.token?.symbol ?? "?";
  const name = a?.genuine?.name ?? c?.name ?? a?.token?.name ?? "";
  const priceUsd = c?.feedPriceUsd ?? a?.token?.priceUsd ?? (kind === "usdg" || kind === "ticker" ? 1 : undefined);
  const canPair = kind === "stock" || kind === "ticker" || kind === "usdg" || kind === "native" || kind === "coin";
  const lookalike = a?.lookalike === true;

  return (
    <div className={`pair-card ${lookalike ? "is-lookalike" : canPair ? "is-ok" : ""}`} data-kind={kind}>
      <div className="pc-head">
        <span className="pc-title">
          {kind === "stock" && <StockLogo ticker={symbol} size={20} />}
          <span className="num text-white font-semibold">{symbol}</span>
          {name && <span className="text-muted"> · {name}</span>}
        </span>
        <span className="pc-badges">
          {kind === "stock" && <OfficialBadge />}
          {lookalike && <span className="badge sw-red">lookalike</span>}
          {kind === "ticker" && <span className="badge sw-pink">creator-issued</span>}
          {kind === "coin" && <span className="badge sw-accent">tickr coin</span>}
          {(api.isLoading || chain.isLoading) && <span className="text-dim text-[12px]">reading…</span>}
        </span>
      </div>
      <p className="pc-kind">
        {lookalike
          ? `the name says "Robinhood Token" but the address is not in the Robinhood Assets registry. it is not issued by Robinhood Assets.`
          : KIND_LINE[kind]}
      </p>

      <dl className="pc-grid">
        {a?.genuine && (
          <>
            <Row k="price feed" v={a.genuine.feed.startsWith("0x0000") ? "none published yet: cannot be quoted today" : `Chainlink ${shortAddr(a.genuine.feed)}`} mono={!a.genuine.feed.startsWith("0x0000")} />
          </>
        )}
        {priceUsd !== undefined && <Row k="price" v={fmtUsd(priceUsd)} mono sub={c?.feedPriceUsd !== undefined ? "from the feed the launcher uses" : a?.token?.priceUsd !== undefined ? "explorer" : "by construction"} />}
        {kind !== "stock" && c?.decimals !== undefined && c.totalSupply !== undefined && <Row k="supply on chain" v={`${fmtAmount(c.totalSupply, c.decimals, { sig: 4 })} ${symbol}`} mono />}
        {kind === "ticker" && c?.reserve !== undefined && (
          <Row k="backing" v={`${fmtAmount(c.reserve, 6)} USDG held for ${fmtAmount(c.totalSupply ?? 0n, 6)} ${symbol}`} mono sub={`${c.coinsUnder ?? 0} coin${c.coinsUnder === 1 ? "" : "s"} under it`} />
        )}
        {kind === "coin" && c && (
          <>
            <Row k="state" v="live, pool locked" sub={c.launchedAt ? `launched ${timeAgo(BigInt(c.launchedAt))}` : undefined} />
            {c.creator && <Row k="creator" v={shortAddr(c.creator)} mono />}
          </>
        )}
        {kind !== "stock" && a?.token?.holders !== undefined && <Row k="holders" v={a.token.holders.toLocaleString()} mono />}
        {kind !== "stock" && a?.token?.volume24hUsd !== undefined && <Row k="24h volume" v={fmtUsd(a.token.volume24hUsd)} mono sub="explorer, all venues" />}
        {kind !== "stock" && a?.token?.marketCapUsd !== undefined && <Row k="market cap" v={fmtUsd(a.token.marketCapUsd)} mono />}
        {kind !== "stock" && a?.contract?.createdAt && <Row k="deployed" v={timeAgo(BigInt(Math.floor(new Date(a.contract.createdAt).getTime() / 1000)))} sub={a.contract.verified ? "source verified on the explorer" : "source not verified on the explorer"} />}
        {a && kind !== "stock" && (
          <Row
            k="lookalikes"
            v={a.lookalikes.count === 0 ? "none found" : `${a.lookalikes.count} other contract${a.lookalikes.count === 1 ? "" : "s"} named ${symbol}`}
            sub={a.lookalikes.count > 0 ? `${a.lookalikes.holders.toLocaleString()} wallets hold one of them. tickr only pairs with the registry address.` : undefined}
          />
        )}
        {c && !c.hasCode && kind !== "native" && <Row k="code" v="no contract at this address" />}
      </dl>

      {kind !== "stock" && (
      <div className="pc-foot">
        <a href={explorerToken(address)} target="_blank" rel="noreferrer" className="num text-[12.5px]">
          {shortAddr(address)} on the explorer
        </a>
        {kind === "coin" && (
          <a href={`/t/${address}`} className="text-[12.5px]">
            its page on tickr
          </a>
        )}
        {kind === "other" && (
          <a href={explorerAddress(address)} target="_blank" rel="noreferrer" className="text-[12.5px]">
            address
          </a>
        )}
      </div>
      )}
    </div>
  );
}

function Row({ k, v, sub, mono = false }: { k: string; v: string; sub?: string; mono?: boolean }) {
  return (
    <div className="pc-row">
      <dt>{k}</dt>
      <dd className={mono ? "num" : ""}>
        {v}
        {sub && <span className="pc-sub">{sub}</span>}
      </dd>
    </div>
  );
}
