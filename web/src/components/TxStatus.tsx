"use client";

import { explorerTx } from "@/lib/chain";
import type { TxStatus as S } from "@/hooks/useTx";
import { Notice, Spinner } from "./ui";

export function TxStatus({ status, hash, error, step }: { status: S; hash?: string; error?: string; step?: string }) {
  if (status === "idle") return null;
  if (status === "error")
    return (
      <Notice kind="danger">
        <span className="break-words">{error ?? "Transaction failed"}</span>
      </Notice>
    );
  const link = hash ? (
    <a className="ml-1" href={explorerTx(hash)} target="_blank" rel="noreferrer">
      view tx
    </a>
  ) : null;
  if (status === "success")
    return (
      <Notice kind="ok">
        Confirmed.{link}
      </Notice>
    );
  return (
    <Notice>
      <span className="inline-flex items-center gap-2">
        <Spinner />
        {status === "signing" ? `Confirm in wallet${step ? `. ${step}` : ""}` : `Waiting for confirmation${step ? `. ${step}` : ""}`}
        {link}
      </span>
    </Notice>
  );
}
