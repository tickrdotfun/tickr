/** Shared motion constants and the hand-driven scroll. Timings live here, not scattered in components. */
export const GLIDE_MS = 220;
export const SMEAR_MS = 620;
export const VIEW_FADE_MS = 120;
export const PRESS_MS = 80;

/** Ceremony phase durations (ms). Consequential actions never resolve in one frame. */
export const CEREMONY = { acting: 950, done: 2000, fading: 550 } as const;

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Hand-driven anchor scroll. Native smooth scrolling locks its destination on the first frame, so
 * anything that settles late (images, on-chain reads) lands you in the wrong place. This re-reads the
 * target's live position every frame and offsets by the measured sticky-header height, so the glide
 * ends exactly on target.
 */
export function smoothScrollToElement(el: HTMLElement, duration = 620): void {
  if (typeof window === "undefined") return;
  if (prefersReducedMotion()) {
    el.scrollIntoView();
    return;
  }
  const start = window.scrollY;
  const t0 = performance.now();
  const stickyOffset = () => {
    const header = document.querySelector("header");
    if (!header) return 0;
    return header.getBoundingClientRect().height;
  };
  const frame = (now: number) => {
    const t = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out-cubic
    // Re-measured every frame, so late-settling content cannot strand the glide.
    const target = el.getBoundingClientRect().top + window.scrollY - stickyOffset() - 12;
    window.scrollTo(0, start + (target - start) * eased);
    if (t < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
