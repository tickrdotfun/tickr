"use client";

import type { TokenData } from "@/hooks/useTokenData";
import { useTickerClub } from "@/hooks/useTickerClub";
import { CHAIN_ID } from "@/lib/chain";
import { useTx } from "@/hooks/useTx";
import { TickerLauncherAbi } from "@/lib/abis";
import { ADDRESSES, sameAddr } from "@/lib/addresses";
import { fmtAmount, pct, shortAddr } from "@/lib/format";
import { TxStatus } from "../TxStatus";

/**
 * The ticker club, as the table it is: every coin under this ticker, the buy volume its fee collections booked over
 * thirty days, and the weight that volume gives it in the club's pots. The captain, the founder's coin while it trades, counts double. Nobody
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

  const claimEpoch = (epoch: bigint) => {
    if (!c) return;
    tx.run([
      {
        label: `claim club for ${meta.symbol ?? "this coin"}`,
        request: (w) => w({ abi: TickerLauncherAbi, address: ADDRESSES.tickerLauncher, functionName: "claimClub", args: [launch.token, c.payers, epoch] }),
      },
    ], { account: user, chainId: CHAIN_ID }).then((h) => h && club.refetch());
  };
  const claim = () => {
    if (!c || c.last === undefined) return;
    claimEpoch(c.last);
  };

  return (
    <div className="club">
      <p className="detail-note detail-note-tight">
        10% of the base fee on buys under {qs}, the quote side, goes to a pot shared by the creators of the other coins under it, by the buy volume their fee collections stand for, over the same thirty days. the coin side&apos;s club share is burned, not shared. the founder&apos;s coin is captain and counts double while it trades.
      </p>

      {!c ? (
        <p className="text-muted text-[13px]">{club.isLoading ? "reading the club…" : "no club data"}</p>
      ) : (
        <>
          <dl className="detail-rows">
            <div className="detail-row">
              <dt>this window&apos;s pot</dt>
              <dd>
                <span className="num">
                  {fmtAmount(c.potNow, qd)} {qs}
                </span>
                <span className="text-dim"> closes {new Date(c.windowEndsAt * 1000).toLocaleDateString()}</span>
              </dd>
            </div>
            <div className="detail-row">
              <dt>last window&apos;s pot</dt>
              <dd>
                <span className="num">
                  {fmtAmount(c.potLast, qd)} {qs}
                </span>
                <span className="text-dim"> claimable now</span>
              </dd>
            </div>
            <div className="detail-row detail-row-action">
              <dt>{meta.symbol ?? "this coin"} can claim</dt>
              <dd>
                <span className="num">{me ? `${fmtAmount(c.claimable, qd)} ${qs}` : "-"}</span>
                {me && c.last !== undefined && (
                  <button className="btn btn-xs btn-primary" disabled={tx.busy || !user || c.claimable === 0n} onClick={claim}>
                    claim
                  </button>
                )}
              </dd>
            </div>
            {(c.historyPartial || c.historyOlder) && (
              <div className="detail-row">
                <dt>earlier windows</dt>
                <dd className="text-dim">
                  {c.historyPartial ? "some windows could not be read just now. " : ""}
                  {c.historyOlder ? "windows older than sixty are still claimable on the contract, with claimClub." : ""}
                </dd>
              </div>
            )}
            {c.claimableByEpoch.map((e) => (
              <div key={e.epoch.toString()} className="detail-row detail-row-action">
                <dt>still to claim, window {e.epoch.toString()}</dt>
                <dd>
                  <span className="num">
                    {fmtAmount(e.amount, qd)} {qs}
                  </span>
                  <button className="btn btn-xs btn-primary" disabled={tx.busy || !user} onClick={() => claimEpoch(e.epoch)}>
                    claim
                  </button>
                </dd>
              </div>
            ))}
          </dl>

          <table className="club-table">
            <thead>
              <tr>
                <th>coin</th>
                <th className="num">30d volume</th>
                <th className="num">weight</th>
                <th className="num">last window</th>
              </tr>
            </thead>
            <tbody>
              {c.members.map((m) => (
                <tr key={m.token} data-me={sameAddr(m.token, launch.token)} data-out={m.volume === 0n}>
                  <td>
                    <span className="num">{m.symbol}</span>
                    {m.captain && <span className="club-captain">captain ×2</span>}
                  </td>
                  <td className="num">{fmtAmount(m.volume, qd)}</td>
                  <td className="num">{m.volume > 0n ? pct(m.weight, 1) : "0%"}</td>
                  <td className="num">
                    {m.lastVolume > 0n ? pct(m.lastWeight, 1) : "0%"}
                    {m.lastCaptain && <span className="text-dim"> ×2</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {isCreator && <p className="detail-note detail-note-tight">claims pay {shortAddr(launch.creatorFeeRecipient)}, you.</p>}
          <TxStatus {...tx} />
        </>
      )}
    </div>
  );
}
