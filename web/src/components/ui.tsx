import type { ReactNode } from "react";

/** A section separated by whitespace, not a box (BRANDING.md §5). The title is an eyebrow label. */
export function Panel({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      {(title || right) && (
        <div className="flex items-end gap-3 mb-4">
          {title && <h3 className="label">{title}</h3>}
          {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
        </div>
      )}
      <div>{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <div className="label label-muted mb-1.5">{label}</div>
      {children}
      {hint && <div className="text-[13px] text-dim mt-1.5">{hint}</div>}
    </label>
  );
}

export function Stat({ label, value, sub, mono = true }: { label: ReactNode; value: ReactNode; sub?: ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="label label-muted">{label}</div>
      <div className={`text-[20px] mt-1 leading-tight ${mono ? "num" : ""}`}>{value}</div>
      {sub && <div className="text-[13px] text-dim mt-0.5">{sub}</div>}
    </div>
  );
}

export function Row({ k, v, className = "" }: { k: ReactNode; v: ReactNode; className?: string }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-1 text-[14px] ${className}`}>
      <span className="text-muted">{k}</span>
      <span className="num text-right">{v}</span>
    </div>
  );
}

/** Inline notice: an eyebrow word and plain type. No filled boxes, no accent strips. */
export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "danger" | "ok"; children: ReactNode }) {
  const word = kind === "warn" ? "Note" : kind === "danger" ? "Error" : kind === "ok" ? "Done" : null;
  return (
    <div className="text-[14px] leading-snug" role={kind === "danger" ? "alert" : undefined}>
      {word && <span className="label mr-2">{word}</span>}
      <span className={kind === "info" ? "text-muted" : "text-white"}>{children}</span>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner-step inline-block w-3 h-3 border border-muted border-t-signal rounded-full" />;
}
