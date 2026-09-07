"use client";

import { useEffect, useRef } from "react";

/**
 * One burst, once, when something landed. Canvas, a couple of hundred pieces in the site's own hues, gone in
 * about two and a half seconds. Nothing under a reduced-motion setting.
 */
export function Confetti({ fire }: { fire: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const done = useRef(false);
  useEffect(() => {
    if (!fire || done.current) return;
    const canvas = ref.current;
    if (!canvas) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    done.current = true;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = (canvas.width = Math.floor(window.innerWidth * dpr));
    const H = (canvas.height = Math.floor(window.innerHeight * dpr));
    const hues = ["#ffd23f", "#ff7a00", "#ff3d8a", "#3d9bff", "#00e08a", "#ffffff"];
    type P = { x: number; y: number; vx: number; vy: number; r: number; a: number; va: number; c: string; w: number; h: number };
    const parts: P[] = [];
    const origins = [
      [W * 0.5, H * 0.35],
      [W * 0.2, H * 0.45],
      [W * 0.8, H * 0.45],
    ];
    for (const [ox, oy] of origins) {
      for (let i = 0; i < 90; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = (4 + Math.random() * 11) * dpr;
        parts.push({
          x: ox,
          y: oy,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp - 6 * dpr,
          r: Math.random() * Math.PI,
          a: 1,
          va: (Math.random() - 0.5) * 0.3,
          c: hues[Math.floor(Math.random() * hues.length)],
          w: (4 + Math.random() * 6) * dpr,
          h: (2 + Math.random() * 4) * dpr,
        });
      }
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = (now - start) / 1000;
      ctx.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.vy += 0.25 * dpr;
        p.vx *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.va;
        p.a = Math.max(0, 1 - Math.max(0, t - 1.4) / 1.1);
        ctx.save();
        ctx.globalAlpha = p.a;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (t < 2.6) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fire]);
  if (!fire) return null;
  return <canvas ref={ref} aria-hidden className="confetti" />;
}
