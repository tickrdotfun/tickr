"use client";

import type { TokenData } from "@/hooks/useTokenData";
import { useBuyback } from "@/hooks/useBuyback";
import { useTx } from "@/hooks/useTx";
import { BuybackTreasuryAbi } from "@/lib/abis";
import { ADDRESSES } from "@/lib/addresses";
import { explorerTx, explorerAddress, CHAIN_ID } from "@/lib/chain";
import { fmtAmount, fmtNumber, pct, shortAddr } from "@/lib/format";
import { TxStatus } from "../TxStatus";

/**
 * The buyback and burn panel on the TICKR page: what the protocol's share has set aside, spent and burned, and a
 * button anyone may press once the ten minute wait is up. Every figure is read from the treasury on chain.
 */
export function Buyback({ d }: { d: TokenData }) {
  const { meta } = d;
  const b = useBuyback();
  const tx = useTx();
  const s = b.data;
  if (!s) return null;
  const ts = meta.symbol ?? "TICKR";
  const td = meta.decimals ?? 18;
  const ready = s.readyIn === 0;
  const mins = Math.ceil(s.readyIn / 60);

  const buy = () =>
    tx
      .run([{ label: `buy and burn ${ts}`, request: (w) => w({ abi: BuybackTreasuryAbi, address: ADDRESSES.buybackTreasury, functionName: "buy" }) }], { chainId: CHAIN_ID })
      .then((h) => h && b.refetch());

  return (
    <div className="buyback">
      <div className="fig-k">buyback and burn</div>
      <p className="detail-note" style={{ marginTop: 8 }}>
        {shareLabel(s.shareBps)} of protocol revenue buys {ts} here and burns it. anyone can trigger a buy every ten minutes. burning does not guarantee a higher price. the share can be raised
        by the owner after a three day delay and never lowered.
      </p>
      {s.pendingShareBps !== undefined && s.shareEffectiveAt !== undefined && (
        <p className="detail-note detail-note-tight">
          a raise to {shareLabel(s.pendingShareBps)} is proposed and can be applied by anyone from {new Date(s.shareEffectiveAt * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.
        </p>
      )}

      <div className="fact-grid" style={{ marginTop: 20 }}>
        <Fact k="burned" v={`${fmtAmount(s.burned, td, { sig: 4 })} ${ts}`} sub={s.burnedPct !== undefined ? `${pct(s.burnedPct, 2)} of supply` : "sent to the dead address"} />
        <Fact k="set aside" v={`${fmtNumber(Number(s.earmarked) / 1e6, { sig: 4 })} USDG`} sub="waiting for the next buy" />
        <Fact k="spent so far" v={`${fmtNumber(Number(s.spent) / 1e6, { sig: 4 })} USDG`} sub="on buys, all burned" />
        <Fact k="next buy" v={ready ? "ready" : `${mins}m`} sub={ready ? "anyone can trigger it" : "until the next is allowed"} />
      </div>

      <div className="club-claim" style={{ marginTop: 20 }}>
        <button className="btn btn-sm btn-primary" disabled={tx.busy || !ready || s.previewIn === 0n} onClick={buy}>
          {ready ? `buy and burn ${ts}` : `next buy in ${mins}m`}
        </button>
        <span className="text-dim text-[13px]">
          {s.previewIn > 0n ? `spends ${fmtNumber(Number(s.previewIn) / 1e6, { sig: 4 })} USDG` : "nothing set aside yet"}
        </span>
      </div>
      <TxStatus {...tx} />

      {s.history.length > 0 && (
        <table className="club-table" style={{ marginTop: 22 }}>
          <thead>
            <tr>
              <th>burned</th>
              <th className="num">USDG spent</th>
              <th className="num">by</th>
              <th className="num">tx</th>
            </tr>
          </thead>
          <tbody>
            {s.history.map((h) => (
              <tr key={h.txHash}>
                <td className="num">
                  {fmtAmount(h.tickrOut, td, { sig: 4 })} {ts}
                </td>
                <td className="num">{fmtNumber(Number(h.usdgIn) / 1e6, { sig: 4 })}</td>
                <td className="num">
                  <a href={explorerAddress(h.caller)} target="_blank" rel="noreferrer">
                    {shortAddr(h.caller)}
                  </a>
                </td>
                <td className="num">
                  <a href={explorerTx(h.txHash)} target="_blank" rel="noreferrer">
                    view
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** "half" for the starting share, otherwise the percentage. */
function shareLabel(bps: number): string {
  return bps === 5_000 ? "half" : bps === 10_000 ? "all" : `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
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
