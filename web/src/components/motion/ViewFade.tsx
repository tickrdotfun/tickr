"use client";

import { usePathname } from "next/navigation";

/** Views cross-fade rather than cut. Opacity only, so navigating never shifts layout. */
export function ViewFade({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="view-fade">
      {children}
    </div>
  );
}
