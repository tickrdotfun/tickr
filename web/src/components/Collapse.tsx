"use client";

import { useState } from "react";

/** Optional detail, folded away by default so the common path stays short. */
export function Collapse({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="collapse-toggle" aria-expanded={open}>
        <span>{label}</span>
        <span className="collapse-chevron" aria-hidden="true">
          {open ? "close" : "open"}
        </span>
      </button>
      {open && <div className="view-fade mt-4">{children}</div>}
    </div>
  );
}
