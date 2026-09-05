"use client";

import type { TokenData } from "@/hooks/useTokenData";
import { useTickerClub } from "@/hooks/useTickerClub";
import { useTx } from "@/hooks/useTx";
import { TickerLauncherAbi } from "@/lib/abis";
import { ADDRESSES, sameAddr } from "@/lib/addresses";
import { fmtAmount, pct, shortAddr } from "@/lib/format";
import { TxStatus } from "../TxStatus";

/**
 * The ticker club, as the table it is: every coin under this ticker, its thirty-day pool volume, and the weight
 * that volume gives it in the club's pots. The captain, the founder's coin while it trades, counts double. Nobody
 * owns the ticker; this is the only thing a coin under it earns from the others.
 */
export function TickerClub({ d }: { d: TokenData }) {
  const { launch, quote, user, meta } = d;
  const club = useTickerClub(launch?.pairToken, launch?.token);
  const tx = useTx();
  if (!launch) return null;
  const qs = quote?.symbol ?? "";
  const qd = quote?.decimals ?? 18;
  const c = club.data;
  const me = c?.members.find((m) => sameAddr(m.token, launch.token));
  const isCreator = !!user && sameAddr(user, launch.creatorFeeRecipient);

  const claim = () => {
    if (!c || c.last === undefined) return;
    tx.run([
      {
        label: `claim club for ${meta.symbol ?? "this coin"}`,
        request: (w) => w({ abi: TickerLauncherAbi, address: ADDRESSES.tickerLauncher, functionName: "claimClub", args: [launch.token, c.payers, c.last!] }),
      },
    ]).then((h) => h && club.refetch());
  };

  return (
    <div className="club">
      <p className="detail-note">
        10% of the base fee paid under {qs} goes to the creators of the other coins under {qs}, by their pool volume
        over the same thirty days. volume is booked when a coin&apos;s fees are collected. no volume in the window, no
        share. a coin never pays itself.
      </p>
      <p className="detail-note">
        the founder&apos;s coin is captain and counts double. if it stops trading, the biggest coin takes the seat for that window.
      </p>

      {!c ? (
        <p className="text-muted text-[13px]">{club.isLoading ? "reading the club…" : "no club data"}</p>
      ) : (
        <>
          <div className="fact-grid">
            <Fact k="this window's pot" v={`${fmtAmount(c.potNow, qd)} ${qs}`} sub={`window ${c.epoch.toString()}, closes ${new Date(c.windowEndsAt * 1000).toLocaleDateString()}`} />
            <Fact k="last window's pot" v={`${fmtAmount(c.potLast, qd)} ${qs}`} sub="claimable now, by weight" />
            <Fact k="members with weight" v={String(c.members.filter((m) => m.volume > 0n).length)} sub={`of ${c.members.length} coins under ${qs}`} />
            <Fact
              k={`${meta.symbol ?? "this coin"} can claim`}
              v={me ? `${fmtAmount(c.claimable, qd)} ${qs}` : "-"}
              sub={me && me.lastVolume > 0n ? "from last window" : "no volume last window"}
            />
          </div>

          <table className="club-table">
            <thead>
              <tr>
                <th>coin</th>
                <th className="num">30d volume</th>
                <th className="num">weight</th>
                <th className="num">last window</th>
                <th className="num">paid in</th>
                <th>creator</th>
              </tr>
            </thead>
            <tbody>
              {c.members.map((m) => (
                <tr key={m.token} data-me={sameAddr(m.token, launch.token)}>
                  <td>
                    <span className="num">{m.symbol}</span>
                    {m.captain && <span className="badge sw-yellow ml-2">captain, counts double</span>}
                  </td>
                  <td className="num">{fmtAmount(m.volume, qd)}</td>
                  <td className="num">{m.volume > 0n ? pct(m.weight, 1) : "0%"}</td>
                  <td className="num">
                    {m.lastVolume > 0n ? pct(m.lastWeight, 1) : "0%"}
                    {m.lastCaptain && <span className="text-dim"> captain</span>}
                  </td>
                  <td className="num">{fmtAmount(m.pot, qd)}</td>
                  <td className="num">{shortAddr(m.creator)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {me && c.last !== undefined && (
            <div className="club-claim">
              <button className="btn btn-sm btn-primary" disabled={tx.busy || !user || c.claimable === 0n} onClick={claim}>
                claim club for {meta.symbol ?? "this coin"}
              </button>
              <span className="text-dim text-[13px]">
                anyone can call; it pays {shortAddr(launch.creatorFeeRecipient)}
                {isCreator ? " (you)" : ""}
              </span>
            </div>
          )}
          <TxStatus {...tx} />
        </>
      )}
    </div>
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
