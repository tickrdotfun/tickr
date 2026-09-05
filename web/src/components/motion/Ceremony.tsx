"use client";

import { useCallback, useRef, useState } from "react";
import { CEREMONY, sleep } from "@/lib/motion";

export type CeremonyPhase = "idle" | "ask" | "acting" | "done" | "fading";

/**
 * A phase machine for irreversible actions. They never resolve in one frame:
 * ask → acting (>= 950ms) → done (held 2000ms) → fading (550ms) → dismissed.
 * The caller's work runs inside `acting`; if it throws, the ceremony returns to idle.
 */
export function useCeremony() {
  const [phase, setPhase] = useState<CeremonyPhase>("idle");
  const running = useRef(false);

  const ask = useCallback(() => setPhase("ask"), []);
  const cancel = useCallback(() => setPhase("idle"), []);

  const run = useCallback(async (work: () => Promise<boolean>, onDismiss?: () => void) => {
    if (running.current) return;
    running.current = true;
    setPhase("acting");
    const startedAt = Date.now();
    let ok = false;
    try {
      ok = await work();
    } catch {
      ok = false;
    }
    if (!ok) {
      running.current = false;
      setPhase("idle");
      return;
    }
    // Let the weight of the thing land even if the chain was fast.
    const elapsed = Date.now() - startedAt;
    if (elapsed < CEREMONY.acting) await sleep(CEREMONY.acting - elapsed);
    setPhase("done");
    await sleep(CEREMONY.done);
    setPhase("fading");
    await sleep(CEREMONY.fading);
    setPhase("idle");
    running.current = false;
    onDismiss?.();
  }, []);

  return { phase, ask, cancel, run };
}

export function Ceremony({
  phase,
  subject,
  question,
  detail,
  confirmLabel,
  actingLabel,
  doneLabel,
  onConfirm,
  onCancel,
}: {
  phase: CeremonyPhase;
  subject: React.ReactNode;
  question: string;
  detail?: React.ReactNode;
  confirmLabel: string;
  actingLabel: string;
  doneLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (phase === "idle") return null;
  const asking = phase === "ask";
  return (
    <div
      className="ceremony"
      data-phase={phase}
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (asking && e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="ceremony-card">
        <div className="label mb-6">{asking ? question : phase === "done" ? doneLabel : actingLabel}</div>
        <div className="text-[26px] font-semibold leading-tight">{subject}</div>
        {detail && <div className="text-muted text-[14px] mt-5">{detail}</div>}
        {asking ? (
          <div className="flex flex-col gap-3 mt-10">
            <button className="btn btn-primary w-full" onClick={onConfirm}>
              {confirmLabel}
            </button>
            <button className="btn w-full" onClick={onCancel}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="mt-10 flex justify-center">
            <span className="swatch-bar" style={{ maxWidth: 180 }}>
              <i /><i /><i /><i /><i /><i />
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
