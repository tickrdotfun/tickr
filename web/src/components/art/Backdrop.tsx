"use client";

import { useEffect, useRef } from "react";

/** A deterministic star field: same sky on every render, no layout thrash from randomness. */
function stars(count: number, seed: number, box: [number, number, number, number]) {
  const [x, y, w, h] = box;
  let s = seed;
  const next = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  return Array.from({ length: count }, (_, i) => ({
    cx: Math.round(x + next() * w),
    cy: Math.round(y + next() * h),
    r: 0.7 + next() * 1.5,
    twinkle: i % 3 === 0,
    delay: Math.round(next() * 60) / 10,
  }));
}

/** Constellations, drawn as a path through named points so the lines and the stars cannot drift apart. */
const CONSTELLATIONS: { points: [number, number][]; lines: number[][] }[] = [
  {
    // upper left, a long-handled dipper
    points: [
      [96, 138],
      [162, 118],
      [232, 140],
      [286, 190],
      [252, 250],
      [176, 254],
      [128, 206],
    ],
    lines: [[0, 1, 2, 3, 4, 5, 6, 0]],
  },
  {
    // right of centre, a slim triangle with a tail
    points: [
      [1052, 336],
      [1136, 300],
      [1112, 392],
      [1218, 428],
    ],
    lines: [[0, 1, 2, 0], [2, 3]],
  },
  {
    // lower centre, a wide sweep
    points: [
      [556, 742],
      [636, 786],
      [724, 760],
      [800, 812],
      [880, 780],
    ],
    lines: [[0, 1, 2, 3, 4]],
  },
  {
    // lower right, the original chart
    points: [
      [1116, 640],
      [1184, 680],
      [1262, 654],
      [1328, 708],
      [1206, 752],
      [1300, 768],
    ],
    lines: [[0, 1, 2, 3], [1, 4, 5]],
  },
];

/**
 * The sky behind the site. Three depth layers drift with the pointer at different rates, bodies revolve on
 * their orbits, stars breathe, and a comet crosses now and then. Hairlines only, in the module border green,
 * at an opacity you notice only once you look for it.
 *
 * The pointer is written straight to CSS custom properties on the element, once per animation frame, so
 * moving the mouse never re-renders React. Everything holds still under `prefers-reduced-motion`.
 */
export function Backdrop() {
  const ref = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    let tx = 0;
    let ty = 0;
    let cx = 0;
    let cy = 0;

    const onMove = (e: PointerEvent) => {
      // -1 .. 1 from the centre of the viewport
      tx = (e.clientX / window.innerWidth) * 2 - 1;
      ty = (e.clientY / window.innerHeight) * 2 - 1;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const tick = () => {
      // ease toward the pointer so the sky glides rather than snapping
      cx += (tx - cx) * 0.06;
      cy += (ty - cy) * 0.06;
      el.style.setProperty("--px", cx.toFixed(4));
      el.style.setProperty("--py", cy.toFixed(4));
      raf = Math.abs(tx - cx) > 0.001 || Math.abs(ty - cy) > 0.001 ? requestAnimationFrame(tick) : 0;
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const far = stars(26, 7, [40, 60, 1360, 800]);
  const near = stars(14, 91, [80, 100, 1280, 720]);

  return (
    <svg
      ref={ref}
      className="backdrop-art"
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="bd-fade" cx="50%" cy="42%" r="64%">
          <stop offset="0%" stopColor="#fff" stopOpacity="1" />
          <stop offset="68%" stopColor="#fff" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id="bd-mask">
          <rect width="1440" height="900" fill="url(#bd-fade)" />
        </mask>
        <linearGradient id="bd-comet" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.9" />
        </linearGradient>
      </defs>

      <g
        mask="url(#bd-mask)"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
        shapeRendering="geometricPrecision"
      >
        {/* ---------------- far: the deep field, barely moves ---------------- */}
        <g className="bd-far">
          {far.map((s, i) => (
            <circle
              key={`f${i}`}
              cx={s.cx}
              cy={s.cy}
              r={s.r}
              fill="currentColor"
              stroke="none"
              opacity="0.5"
              className={s.twinkle ? "bd-twinkle" : undefined}
              style={s.twinkle ? { animationDelay: `${s.delay}s` } : undefined}
            />
          ))}
          <path d="M-40 214 C 320 120, 720 120, 1080 214" opacity="0.18" />
          <path d="M360 880 C 720 806, 1120 806, 1480 880" opacity="0.14" />
        </g>

        {/* ---------------- mid: constellations, orbits, the trace ---------------- */}
        <g className="bd-mid">
          {CONSTELLATIONS.map((c, ci) => (
            <g key={`c${ci}`}>
              {c.lines.map((line, li) => (
                <path
                  key={`l${li}`}
                  d={line.map((p, i) => `${i ? "L" : "M"}${c.points[p][0]} ${c.points[p][1]}`).join(" ")}
                  opacity="0.36"
                />
              ))}
              {c.points.map(([px, py], pi) => (
                <circle
                  key={`p${pi}`}
                  cx={px}
                  cy={py}
                  r={pi % 3 === 0 ? 2.8 : 2}
                  fill="currentColor"
                  stroke="none"
                  className="bd-twinkle"
                  style={{ animationDelay: `${(ci * 1.7 + pi * 0.6).toFixed(1)}s` }}
                />
              ))}
            </g>
          ))}

          {/* concentric orbits with bodies that revolve at their own rates */}
          <g transform="translate(150 742)">
            <circle r="58" opacity="0.6" />
            <circle r="112" opacity="0.42" />
            <circle r="176" opacity="0.26" />
            <circle r="238" opacity="0.16" />
            <g className="bd-orbit bd-orbit-a">
              <circle r="5" cx="112" fill="currentColor" stroke="none" />
            </g>
            <g className="bd-orbit bd-orbit-b">
              <circle r="3.2" cx="176" fill="currentColor" stroke="none" />
            </g>
            <g className="bd-orbit bd-orbit-c">
              <circle r="2.6" cx="238" fill="currentColor" stroke="none" opacity="0.8" />
            </g>
          </g>

          {/* an oscilloscope trace: the one thing in the sky that is not round */}
          <path
            d="M-20 452 L180 452 L214 452 L232 396 L250 508 L268 452 L470 452 L494 452 L512 424 L530 480 L548 452 L760 452"
            opacity="0.34"
          />

          {/* chart ticks */}
          <g opacity="0.32">
            <path d="M660 96 L660 132 M642 114 L678 114" />
            <path d="M368 618 L368 646 M354 632 L382 632" />
            <path d="M1330 470 L1330 498 M1316 484 L1344 484" />
          </g>

          {/* a comet, crossing every so often */}
          <g className="bd-comet">
            <path d="M-70 0 L0 0" stroke="url(#bd-comet)" strokeWidth="1.5" />
            <circle r="2.4" fill="currentColor" stroke="none" />
          </g>
        </g>

        {/* ---------------- near: the bodies with weight ---------------- */}
        <g className="bd-near">
          {near.map((s, i) => (
            <circle
              key={`n${i}`}
              cx={s.cx}
              cy={s.cy}
              r={s.r}
              fill="currentColor"
              stroke="none"
              opacity="0.65"
              className={s.twinkle ? "bd-twinkle" : undefined}
              style={s.twinkle ? { animationDelay: `${s.delay}s` } : undefined}
            />
          ))}

          {/* the ringed planet, with a moon of its own */}
          <g transform="translate(1188 168)">
            <circle r="74" />
            <circle r="40" opacity="0.5" />
            <ellipse rx="128" ry="30" transform="rotate(-18)" />
            <ellipse rx="150" ry="36" transform="rotate(-18)" opacity="0.45" />
            <g className="bd-orbit bd-orbit-moon">
              <circle r="3.4" cx="150" fill="currentColor" stroke="none" />
            </g>
          </g>

          {/* a cratered moon, mid left */}
          <g transform="translate(96 300)">
            <circle r="26" opacity="0.7" />
            <circle r="7" cx="-8" cy="-6" opacity="0.55" />
            <circle r="3.5" cx="9" cy="8" opacity="0.55" />
          </g>
        </g>
      </g>
    </svg>
  );
}
