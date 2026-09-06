"use client";

import { useEffect, useState } from "react";
import { getAddress, isAddress } from "viem";
import type { TokenData } from "@/hooks/useTokenData";
import { useTx } from "@/hooks/useTx";
import { FactoryAbi } from "@/lib/abis";
import { ADDRESSES, sameAddr } from "@/lib/addresses";
import { explorerAddress } from "@/lib/chain";
import { shortAddr } from "@/lib/format";
import { TxStatus } from "../TxStatus";

/** The clock, in whole seconds, ticking in an effect so nothing reads Date.now() during a render. */
function useNow(ms = 10_000) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const when = (t: bigint) => new Date(Number(t) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * One line every visitor sees while the owner has proposed moving this coin's fee wallet: to whom, from when,
 * until when. The proposal is public for three days before anyone can execute it and lapses three days later.
 */
export function TakeoverNotice({ d }: { d: TokenData }) {
  const { launch, takeover, user } = d;
  const now = useNow();
  const tx = useTx();
  if (!launch || !takeover || now === 0 || now > Number(takeover.expiresAt)) return null;
  const open = now >= Number(takeover.effectiveAt);
  const execute = () =>
    tx
      .run([{ label: "execute the move", request: (w) => w({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "executeCreatorFeeRecipientChange", args: [launch.token] }) }])
      .then((h) => h && d.refetch());
  return (
    <div className="takeover">
      <p className="detail-note detail-note-tight">
        notice: tickr has proposed moving this coin&apos;s fee wallet from{" "}
        <a className="num" href={explorerAddress(launch.creatorFeeRecipient)} target="_blank" rel="noreferrer">
          {shortAddr(launch.creatorFeeRecipient)}
        </a>{" "}
        to{" "}
        <a className="num" href={explorerAddress(takeover.newRecipient)} target="_blank" rel="noreferrer">
          {shortAddr(takeover.newRecipient)}
        </a>
        . {open ? `anyone can execute it until ${when(takeover.expiresAt)}.` : `anyone can execute it from ${when(takeover.effectiveAt)} until ${when(takeover.expiresAt)}.`} this path exists for lost keys and stolen
        wallets. the coin, its pool and its supply do not change, and fees already credited stay where they are. a move by the creator does not cancel it.
      </p>
      {open && (
        <button className="btn btn-xs" disabled={tx.busy || !user} onClick={execute}>
          execute
        </button>
      )}
      <TxStatus {...tx} />
    </div>
  );
}

/**
 * The creator's one control over a live coin: where its fees go from the next collection on. Immediate, final,
 * and it moves nothing already credited, so the row asks for a claim first and for a second look at the address.
 */
export function MoveFees({ d }: { d: TokenData }) {
  const { launch, user, escrow, nativePair } = d;
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [sure, setSure] = useState(false);
  if (!launch || !user || !sameAddr(user, launch.creatorFeeRecipient)) return null;

  const valid = isAddress(to);
  const target = valid ? getAddress(to) : undefined;
  const same = !!target && sameAddr(target, launch.creatorFeeRecipient);
  const unclaimed = ((nativePair ? escrow.native : escrow.quoteToken) ?? 0n) > 0n || (escrow.coin ?? 0n) > 0n;
  const close = () => {
    setOpen(false);
    setTo("");
    setSure(false);
  };
  const move = () => {
    if (!target || same) return;
    tx.run([{ label: "move the fees", request: (w) => w({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "transferCreatorFeeRecipient", args: [launch.token, target] }) }]).then((h) => {
      if (h) {
        close();
        d.refetch();
      }
    });
  };

  return (
    <div className="move-fees">
      {!open ? (
        <p className="detail-note detail-note-tight">
          this coin&apos;s fees go to your wallet.{" "}
          <button type="button" className="link-btn" onClick={() => setOpen(true)}>
            move them to another wallet
          </button>
        </p>
      ) : (
        <div className="move-fees-form">
          <label className="move-fees-label" htmlFor="move-fees-to">
            move this coin&apos;s fees to
          </label>
          <input
            id="move-fees-to"
            className="num"
            value={to}
            onChange={(e) => {
              setTo(e.target.value.trim());
              setSure(false);
            }}
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
          />
          {to && !valid && <p className="move-fees-warn">that is not an address.</p>}
          {same && <p className="move-fees-warn">that is the wallet the fees already go to.</p>}
          {target && !same && (
            <>
              <p className="detail-note detail-note-tight">
                from the next collection on, this coin&apos;s fees go to <span className="num">{target}</span>. you cannot undo this: only that wallet can move them again, or tickr through its public three day proposal.
                {unclaimed ? " you still have fees to claim. claim them first: they do not move." : " fees already credited do not move."} club rewards not yet claimed go to whoever holds the fee wallet when they are claimed.
              </p>
              <label className="move-fees-check">
                <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> i checked the address
              </label>
            </>
          )}
          <div className="move-fees-actions">
            <button className="btn btn-xs btn-primary" disabled={tx.busy || !target || same || !sure} onClick={move}>
              move
            </button>
            <button className="btn btn-xs" disabled={tx.busy} onClick={close}>
              cancel
            </button>
          </div>
        </div>
      )}
      <TxStatus {...tx} />
    </div>
  );
}
