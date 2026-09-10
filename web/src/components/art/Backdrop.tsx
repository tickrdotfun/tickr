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

/**
 * A five pointed star, the shape of the glow-in-the-dark ones that get stuck on a bedroom ceiling. Built from
 * the two radii so a single number sizes it, and returned as a closed path so it can take a glow filter.
 */
function starPath(cx: number, cy: number, r: number, rot = -90) {
  const inner = r * 0.382; // the ratio that makes a five pointed star read as one rather than as a blob
  return (
    Array.from({ length: 10 }, (_, i) => {
      const rad = ((rot + i * 36) * Math.PI) / 180;
      const rr = i % 2 ? inner : r;
      return `${i ? "L" : "M"}${(cx + Math.cos(rad) * rr).toFixed(1)} ${(cy + Math.sin(rad) * rr).toFixed(1)}`;
    }).join(" ") + " Z"
  );
}

/** The stuck-on stars. Placed by hand, off the grid, the way a child would have reached. */
const CEILING_STARS: { x: number; y: number; r: number; rot: number; delay: number }[] = [
  { x: 300, y: 96, r: 15, rot: -84, delay: 0 },
  { x: 522, y: 208, r: 10, rot: -102, delay: 2.4 },
  { x: 838, y: 128, r: 13, rot: -78, delay: 1.1 },
  { x: 1004, y: 512, r: 11, rot: -95, delay: 3.6 },
  { x: 214, y: 540, r: 9, rot: -70, delay: 4.8 },
  { x: 700, y: 622, r: 14, rot: -88, delay: 1.9 },
  { x: 1352, y: 236, r: 10, rot: -110, delay: 3.1 },
  { x: 452, y: 812, r: 12, rot: -80, delay: 5.4 },
  { x: 1268, y: 856, r: 9, rot: -92, delay: 2.8 },
];

/** Dust that drifts, the motes you only see when a lamp catches them. */
const MOTES = [
  { x: 240, y: 400, r: 1.6, dur: 34, delay: 0 },
  { x: 640, y: 300, r: 1.2, dur: 41, delay: 6 },
  { x: 980, y: 660, r: 1.8, dur: 29, delay: 3 },
  { x: 1300, y: 420, r: 1.3, dur: 46, delay: 11 },
  { x: 420, y: 690, r: 1.5, dur: 37, delay: 8 },
  { x: 1120, y: 240, r: 1.1, dur: 52, delay: 15 },
];

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

  // a fuller sky than before: the deep field roughly doubles, the near layer grows by half
  const far = stars(58, 7, [40, 60, 1360, 800]);
  const near = stars(22, 91, [80, 100, 1280, 720]);

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

        {/* The two clouds. The only colour in the sky that is not the accent, and it is the ground's own
            violet, so the backdrop reads as the page deepening rather than as a second palette arriving. */}
        <radialGradient id="bd-neb-violet" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#8B5CF6" stopOpacity="0.5" />
          <stop offset="55%" stopColor="#6D4AD8" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#3B2A6B" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="bd-neb-cyan" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#3DC2DC" stopOpacity="0.4" />
          <stop offset="60%" stopColor="#2A8FB0" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#123A4A" stopOpacity="0" />
        </radialGradient>

        {/* The bloom on the stuck-on stars: the halo the glow-in-the-dark ones have in a dark room. */}
        <filter id="bd-glow" x="-120%" y="-120%" width="340%" height="340%">
          <feGaussianBlur stdDeviation="6" result="soft" />
          <feMerge>
            <feMergeNode in="soft" />
            <feMergeNode in="soft" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="bd-glow-sm" x="-120%" y="-120%" width="340%" height="340%">
          <feGaussianBlur stdDeviation="2.5" result="soft" />
          <feMerge>
            <feMergeNode in="soft" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* ---------------- the clouds, behind everything, drifting on their own clock ---------------- */}
      <g mask="url(#bd-mask)" className="bd-clouds">
        <ellipse className="bd-cloud bd-cloud-a" cx="330" cy="270" rx="440" ry="300" fill="url(#bd-neb-violet)" />
        <ellipse className="bd-cloud bd-cloud-b" cx="1120" cy="640" rx="500" ry="330" fill="url(#bd-neb-cyan)" />
        <ellipse className="bd-cloud bd-cloud-c" cx="820" cy="180" rx="360" ry="220" fill="url(#bd-neb-violet)" />
      </g>

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

          {/* dust, drifting up and sideways the way it does in a shaft of light */}
          {MOTES.map((m, i) => (
            <circle
              key={`m${i}`}
              className="bd-mote"
              cx={m.x}
              cy={m.y}
              r={m.r}
              fill="currentColor"
              stroke="none"
              style={{ animationDuration: `${m.dur}s`, animationDelay: `${m.delay}s` }}
            />
          ))}
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

          {/* a second one, slower, the other way, on its own long wait so the two rarely coincide */}
          <g className="bd-comet bd-comet-2">
            <path d="M-96 0 L0 0" stroke="url(#bd-comet)" strokeWidth="2" />
            <circle r="3" fill="currentColor" stroke="none" filter="url(#bd-glow-sm)" />
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

          {/* a crescent, cut by overlaying the ground on a disc rather than drawn as an arc */}
          <g className="bd-crescent" transform="translate(392 700)">
            <path
              d="M0 -44 A 44 44 0 1 0 0 44 A 34 34 0 1 1 0 -44 Z"
              fill="currentColor"
              stroke="none"
              opacity="0.72"
              filter="url(#bd-glow-sm)"
            />
          </g>
        </g>

        {/* ---------------- the stuck-on stars: the nearest thing, and the only thing that glows ---------------- */}
        <g className="bd-ceiling">
          {CEILING_STARS.map((s, i) => (
            <path
              key={`cs${i}`}
              className="bd-star"
              d={starPath(s.x, s.y, s.r, s.rot)}
              fill="currentColor"
              stroke="none"
              filter="url(#bd-glow)"
              style={{ animationDelay: `${s.delay}s` }}
            />
          ))}
        </g>
      </g>
    </svg>
  );
}
