"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { useReadContract } from "wagmi";
import type { Address } from "viem";
import { FactoryAbi } from "@/lib/abis";
import { ADDRESSES, isZero, sameAddr } from "@/lib/addresses";
import { fmtAmount, shortAddr } from "@/lib/format";
import { useActivation, type ActivationTarget } from "@/hooks/useActivation";
import { useLaunches } from "@/hooks/useLaunches";
import { useTokenData } from "@/hooks/useTokenData";
import { Confetti } from "../motion/Confetti";
import { Notice, Spinner } from "../ui";
import { TxStatus } from "../TxStatus";
import { ACTIVATION_USD } from "@/lib/activation";
import { DEMO } from "@/lib/demoTransport";

/**
 * The last step of a launch: the two buys that chart sites and trackers need before they price a coin. The name
 * first, into the wallet, through the name's own pool; then the coin. Both about twenty dollars, both paid in ETH,
 * both sent from this card one after the other. Until they land the coin is not shown as done.
 */
export function ActivateCard({ token, launchBlock, onDone, title }: { token: Address; launchBlock?: bigint; onDone?: () => void; title?: string }) {
  const d = useTokenData(token);
  const launches = useLaunches();
  const own = useReadContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "poolKeyOf", args: [token], query: { enabled: !!d.launch, staleTime: Infinity } });
  const found = launches.data?.find((l) => sameAddr(l.token, token));
  const target = useMemo((): ActivationTarget | undefined => {
    if (!d.launch || !own.data || !d.pool.poolId) return undefined;
    return {
      token,
      pairToken: d.launch.pairToken,
      poolId: d.pool.poolId,
      own: { currency0: own.data.currency0, currency1: own.data.currency1, fee: Number(own.data.fee), tickSpacing: Number(own.data.tickSpacing), hooks: own.data.hooks },
      launchBlock: launchBlock ?? found?.blockNumber,
      isTicker: d.isTicker,
    };
  }, [d.launch, d.isTicker, d.pool.poolId, own.data, token, launchBlock, found?.blockNumber]);
  const a = useActivation(target);
  const qs = d.quote?.symbol ?? "the name";
  const ts = d.meta.symbol ?? "the coin";

  useEffect(() => {
    if (a.state === "done" && onDone) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.state]);

  const eth = fmtAmount(a.wei, 18, { sig: 3 });
  const usd = a.ethUsd ? `about $${ACTIVATION_USD}` : "a small amount";
  const steps = (a.needsTicker ? 2 : 1) + (a.needsTicker && !a.needsCoin ? 0 : 0);
  const label =
    a.state === "signing-ticker"
      ? `Buying ${qs}: confirm in your wallet`
      : a.state === "confirming-ticker"
        ? `Buying ${qs}: waiting for the block`
        : a.state === "signing-coin"
          ? `Buying ${ts}: confirm in your wallet`
          : a.state === "confirming-coin"
            ? `Buying ${ts}: waiting for the block`
            : a.state === "recovering"
              ? "Checking a transaction sent before this page reloaded"
              : a.state === "loading"
                ? "Reading the chain"
                : undefined;

  return (
    <div className="activate" data-state={a.state}>
      <Confetti fire={a.celebrate} />
      <div className="label">{title ?? "activate"}</div>
      {a.state === "done" ? (
        <div className="mt-3">
          <div className="text-[20px] font-semibold">{ts} is activated</div>
          <p className="text-muted text-[14px] mt-2">
            The two buys landed. Chart sites and trackers can price {ts} now; it may take them a few minutes to show it.
          </p>
          <div className="flex flex-wrap gap-4 mt-4 text-[14px]">
            {a.hashes.ticker && <span className="num text-muted">name buy {shortAddr(a.hashes.ticker)}</span>}
            {a.hashes.coin && <span className="num text-muted">coin buy {shortAddr(a.hashes.coin)}</span>}
          </div>
          <div className="mt-5">
            <Link href={`/t/${token}`} className="btn btn-primary no-underline">
              Open {ts}
            </Link>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <div className="text-[20px] font-semibold">{ts} is live, not activated yet</div>
          <p className="text-muted text-[14px] mt-2">
            Chart sites and trackers only price a coin from buys that land after its launch, and price an invented name from a buy that lands in a wallet
            through the name&apos;s own pool. {a.needsTicker ? `So two small buys, one after the other: ${qs} into your wallet, then ${ts}.` : `So one small buy of ${ts}.`}{" "}
            {usd} each, paid in ETH. The coin trades on tickr either way.
          </p>
          <ul className="activate-steps mt-4">
            {d.isTicker && (
              <li data-done={!a.needsTicker}>
                <span className="num">1</span> buy {qs} through its pool, into your wallet {!a.needsTicker && <em>done</em>}
              </li>
            )}
            <li data-done={!a.needsCoin && !a.needsTicker}>
              <span className="num">{d.isTicker ? 2 : 1}</span> buy {ts} {!a.needsCoin && <em>done</em>}
            </li>
          </ul>
          <div className="flex flex-wrap items-center gap-4 mt-5">
            <button
              className="btn btn-gradient"
              disabled={a.busy || a.state === "loading" || !d.user || !a.routeReady || DEMO || isZero(ADDRESSES.zapRouter)}
              onClick={() => void a.activate()}
            >
              {a.busy ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner /> {label}
                </span>
              ) : a.state === "error" ? (
                "Try again"
              ) : (
                `Activate (${eth} ETH${steps === 2 ? " twice" : ""})`
              )}
            </button>
            {!d.user && <span className="text-muted text-[14px]">Connect a wallet to activate.</span>}
            {a.state === "loading" && label && <span className="text-muted text-[14px]">{label}</span>}
          </div>
          {a.error && (
            <div className="mt-4">
              <Notice kind="danger">{a.error}</Notice>
            </div>
          )}
          {a.state === "error" && (
            <button type="button" className="btn mt-3" onClick={a.retry}>
              Dismiss
            </button>
          )}
          <div className="mt-4">
            <TxStatus status={a.busy ? "confirming" : "idle"} hash={undefined} error={undefined} step={label} />
          </div>
        </div>
      )}
    </div>
  );
}

/** On a coin's page: a line while the coin is not activated, and the card itself for the wallet that launched it. */
export function ActivationNotice({ token, deployer }: { token: Address; deployer?: Address }) {
  const d = useTokenData(token);
  const launches = useLaunches();
  const own = useReadContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "poolKeyOf", args: [token], query: { enabled: !!d.launch, staleTime: Infinity } });
  const found = launches.data?.find((l) => sameAddr(l.token, token));
  const target = useMemo((): ActivationTarget | undefined => {
    if (!d.launch || !own.data || !d.pool.poolId) return undefined;
    return {
      token,
      pairToken: d.launch.pairToken,
      poolId: d.pool.poolId,
      own: { currency0: own.data.currency0, currency1: own.data.currency1, fee: Number(own.data.fee), tickSpacing: Number(own.data.tickSpacing), hooks: own.data.hooks },
      launchBlock: found?.blockNumber,
      isTicker: d.isTicker,
    };
  }, [d.launch, d.isTicker, d.pool.poolId, own.data, token, found?.blockNumber]);
  const a = useActivation(target);
  if (!target || a.state === "loading" || a.activated) return null;
  const mine = !!d.user && (sameAddr(d.user, deployer ?? d.launch?.deployer ?? found?.deployer) || sameAddr(d.user, d.launch?.creatorFeeRecipient));
  if (mine) return <ActivateCard token={token} launchBlock={found?.blockNumber} title="not activated yet" />;
  return (
    <Notice kind="warn">
      not activated yet: chart sites and trackers do not price this coin until its creator makes the two small buys that follow a launch. it trades here as usual.
    </Notice>
  );
}
