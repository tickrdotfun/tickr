"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { GLIDE_MS } from "@/lib/motion";

/**
 * A single indicator that travels between siblings instead of many items toggling a background.
 * Measure the active item with offsetLeft/offsetWidth, drive the indicator with transform + width.
 * It glides only when moving between items, never on first paint, and never when appearing from nothing.
 */
export function useGlider(activeKey: string | number | null | undefined) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const indRef = useRef<HTMLSpanElement | null>(null);
  const placed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const measure = useCallback((animate: boolean) => {
    const track = trackRef.current;
    const ind = indRef.current;
    if (!track || !ind) return;
    const target = track.querySelector<HTMLElement>('[data-glide-active="true"]');
    if (!target) {
      ind.style.opacity = "0";
      placed.current = false;
      return;
    }
    const left = target.offsetLeft;
    const width = target.offsetWidth;
    const y = target.offsetTop + target.offsetHeight - 1;
    if (!placed.current || !animate) {
      // First placement (or a resize): appear where it belongs, with no travel and no smear.
      ind.classList.remove("is-animated", "is-gliding");
      ind.style.transform = `translate3d(${left}px, ${y}px, 0)`;
      ind.style.width = `${width}px`;
      ind.style.opacity = "1";
      void ind.offsetWidth; // commit before re-enabling transitions
      ind.classList.add("is-animated");
      placed.current = true;
      return;
    }
    ind.classList.add("is-animated", "is-gliding");
    ind.style.transform = `translate3d(${left}px, ${y}px, 0)`;
    ind.style.width = `${width}px`;
    ind.style.opacity = "1";
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => ind.classList.remove("is-gliding"), GLIDE_MS);
  }, []);

  useLayoutEffect(() => {
    measure(true);
  }, [activeKey, measure]);

  useEffect(() => {
    const onResize = () => measure(false);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [measure]);

  return { trackRef, indRef };
}

/** The travelling indicator itself. Render it as the first child of the track. */
export function GlideIndicator({ indRef }: { indRef: React.RefObject<HTMLSpanElement | null> }) {
  return <span ref={indRef} className="glide-ind" aria-hidden="true" />;
}

/**
 * Pointer-following indicator for large targets. Slower, and permanently smeared: the blur is the
 * state and never resolves. Spread the returned handlers on the track.
 */
export function useSmear() {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const indRef = useRef<HTMLSpanElement | null>(null);

  const moveTo = useCallback((el: HTMLElement | null) => {
    const ind = indRef.current;
    const track = trackRef.current;
    if (!ind || !track) return;
    if (!el) {
      ind.classList.remove("is-on");
      return;
    }
    ind.style.transform = `translate3d(${el.offsetLeft}px, ${el.offsetTop}px, 0)`;
    ind.style.width = `${el.offsetWidth}px`;
    ind.style.height = `${el.offsetHeight}px`;
    ind.classList.add("is-on");
  }, []);

  const handlers = {
    onPointerOver: (e: React.PointerEvent<HTMLDivElement>) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>("[data-smear-item]");
      if (item) moveTo(item);
    },
    onPointerLeave: () => moveTo(null),
  };

  return { trackRef, indRef, handlers };
}

export function SmearIndicator({ indRef }: { indRef: React.RefObject<HTMLSpanElement | null> }) {
  return <span ref={indRef} className="smear-ind" aria-hidden="true" />;
}
