import { REEL_TICKERS } from "@/components/motion/TickerReel";
import { TickrMark, SwatchBar } from "@/components/Mark";

/**
 * The launch cut: 1080x1080, for capture, no chrome, one pass.
 *
 * Built as a shot list rather than as one long device, because the teaser is already one long device and a
 * second video with the same shape reads as the same video. Act one is twelve hard cuts that never repeat a
 * treatment: full bleed colour, inverted grounds, swatch slams, cropped type, a grid, a chromatic stutter.
 * Act two is the interface moving, not the interface sitting still: a horizontal tape, bars filling, rows
 * scrolling. Act three is the vertical rip, which is the one thing worth keeping from the teaser. Act four
 * is the standard outro.
 *
 * Everything below is generated from SHOTS, so the timing, the cue sheet the score reads, and the CSS can
 * never disagree with each other.
 *
 * All of its CSS is emitted here rather than in globals: this page is a camera subject, not part of the site.
 */

const C = {
  white: "var(--tickr-white)",
  blue: "var(--tickr-sw-blue-type)",
  yellow: "var(--tickr-sw-yellow)",
  pink: "var(--tickr-sw-pink)",
  red: "var(--tickr-sw-red)",
  orange: "var(--tickr-sw-orange)",
  signal: "var(--tickr-signal)",
} as const;
type Col = keyof typeof C;

type Shot =
  | { k: "flash"; c: Col; d: number; s: "hit" }
  | { k: "slam"; d: number; s: "hit" }
  | { k: "word"; w: string; c: Col; d: number; s: "flick" }
  | { k: "invert"; w: string; c: Col; d: number; s: "hit" }
  | { k: "bleed"; w: string; c: Col; d: number; s: "flick" }
  | { k: "stack"; w: string; d: number; s: "flick" }
  | { k: "grid"; d: number; s: "tap" }
  | { k: "tape"; d: number; s: "tap" }
  | { k: "bars"; d: number; s: "tap" }
  | { k: "rows"; d: number; s: "tap" }
  | { k: "anchor"; d: number; s: "tap" }
  | { k: "chips"; d: number; s: "tap" }
  | { k: "field"; d: number; s: "tap" }
  | { k: "locked"; d: number; s: "tap" };

/**
 * The music comes first now and the picture is cut to it. 150bpm, and one simple pattern the whole way:
 *
 *   BOOM tick CLAP tick BOOM tick CLAP tick     (straight eighths, low on the beat, mid on the backbeat)
 *
 * Act one cuts on every eighth, so every hit of the pattern is a new frame. Act two cuts on the quarters,
 * landing on the BOOMs and CLAPs while the ticks keep time between. After two bars the whole thing goes
 * double time: same pattern, half the note length, the remaining glimpses cutting twice as fast with it.
 * The rip carries the double-time bar on, and its back half doubles once more into a straight fill that
 * the landing cuts off. Speed only ever doubles; the pattern never changes. Nothing is off the grid.
 */
const EIGHTH = 0.2;
const BEAT = EIGHTH * 2;
const BAR = BEAT * 4;
const SHOTS: Shot[] = [
  // bar one: eight cuts, one per eighth
  { k: "flash", c: "orange", d: EIGHTH, s: "hit" },
  { k: "word", w: "BANANA", c: "white", d: EIGHTH, s: "flick" },
  { k: "invert", w: "STONK", c: "blue", d: EIGHTH, s: "hit" },
  { k: "word", w: "FART", c: "yellow", d: EIGHTH, s: "flick" },
  { k: "slam", d: EIGHTH, s: "hit" },
  { k: "bleed", w: "CASHCAT", c: "pink", d: EIGHTH, s: "flick" },
  { k: "stack", w: "NGMI", d: EIGHTH, s: "flick" },
  { k: "bleed", w: "BAGUETTE", c: "white", d: EIGHTH, s: "flick" },

  // bar two: four glimpses on the quarters
  { k: "tape", d: BEAT, s: "tap" },
  { k: "grid", d: BEAT, s: "tap" },
  { k: "bars", d: BEAT, s: "tap" },
  { k: "rows", d: BEAT, s: "tap" },
  // double time: the same four-to-the-bar feel at twice the speed
  { k: "anchor", d: BEAT / 2, s: "tap" },
  { k: "chips", d: BEAT / 2, s: "tap" },
  { k: "field", d: BEAT / 2, s: "tap" },
  { k: "locked", d: BEAT / 2, s: "tap" },
];
const ACT1 = 8;
const T0 = 0.2;
const STARTS: number[] = [];
let clock = T0;
for (const s of SHOTS) {
  STARTS.push(clock);
  clock += s.d;
}
const SHOTS_END = clock;

// ---- act three: the rip, ending on the one word it comes to rest on
const LAND_ON = "ANUS";
const PASS = REEL_TICKERS.filter((w) => w !== LAND_ON);
const REEL = [...PASS, LAND_ON];
const RIP_N = PASS.length;
/** Where the tempo doubles: two full bars in, right as the interface glimpses halve their length. */
const X2_AT = 0.2 + BAR * 2;
/** One bar of rip: half of it still the double-time pattern, half the fill that doubles it once more. */
const RIP_LEN = BAR;
const RIP_END = SHOTS_END + RIP_LEN;
const HOLD = 0.4;
const CLEAR = 0.4;
const LOCKUP_AT = RIP_END + HOLD + CLEAR;
const TOTAL = LOCKUP_AT + 3.2;

const at = (t: number) => `${((t / TOTAL) * 100).toFixed(4)}%`;

const EASE = [0, 0.7, 0.26, 1] as const;
const bz = (a: number, b: number, s: number) => {
  const u = 1 - s;
  return 3 * u * u * s * a + 3 * u * s * s * b + s * s * s;
};
const solve = (a: number, b: number, y: number) => {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (bz(a, b, m) < y) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
};
const ease = (x: number) => bz(EASE[1], EASE[3], solve(EASE[0], EASE[2], x));
const easeInv = (y: number) => bz(EASE[0], EASE[2], solve(EASE[1], EASE[3], y));

/** Every cue in the cut. The score is written against this, never against retyped numbers. */
const CUES = {
  total: TOTAL,
  shots: SHOTS.map((s, i) => ({ t: +STARTS[i].toFixed(4), s: s.s })),
  ripStart: SHOTS_END,
  ripEnd: RIP_END,
  ticks: Array.from({ length: RIP_N }, (_, k) => +(SHOTS_END + RIP_LEN * easeInv((k + 1) / RIP_N)).toFixed(4)),
  eighth: EIGHTH,
  x2At: +X2_AT.toFixed(4),
  fillStart: +(SHOTS_END + BAR / 2).toFixed(4),
  act1: ACT1,
  ripOut: RIP_END + HOLD,
  lockupAt: LOCKUP_AT,
  // the tittle's 380ms ease-out-back reaches the resting point before it ends; the touch is that crossing
  bell: +(LOCKUP_AT + 1.0 + 0.38 * bz(0.34, 0.64, solve(1.56, 1, 1))).toFixed(4),
};

function sheet(): string {
  // the blur crossfade rides the rip's own derivative, so the smear thins as it slows and is gone on landing
  const STEPS = 24;
  const vs: number[] = [];
  let peak = 0;
  for (let i = 0; i <= STEPS; i++) {
    const x = i / STEPS, h = 0.5 / STEPS;
    const a = Math.max(0, x - h), b = Math.min(1, x + h);
    const v = (ease(b) - ease(a)) / (b - a);
    vs.push(v);
    if (v > peak) peak = v;
  }
  const sharp: string[] = [];
  const ghost: string[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const v = Math.pow(vs[i] / peak, 0.55);
    const t = at(SHOTS_END + (i / STEPS) * RIP_LEN);
    ghost.push(`${t}{opacity:${v.toFixed(3)}}`);
    sharp.push(`${t}{opacity:${(1 - 0.82 * v).toFixed(3)}}`);
  }

  const cuts = SHOTS.map(
    (s, i) =>
      `@keyframes k${i}{0%{opacity:0}${at(STARTS[i])}{opacity:1}${at(STARTS[i] + s.d)}{opacity:0}100%{opacity:0}}` +
      `.s${i}{animation:k${i} ${TOTAL}s steps(1,end) 1 both}` +
      // each shot's own motion runs for exactly its own length
      `.s${i} .mv{animation-duration:${s.d}s}`,
  );

  return [
    `.lx{position:relative;width:1080px;height:1080px;overflow:hidden;background:var(--bg)}`,
    `.sh{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;opacity:0;overflow:hidden}`,
    // shared entrances, picked per shot; all run for the shot's own duration
    `@keyframes in-punch{from{transform:scale(1.14)}to{transform:scale(1)}}`,
    `@keyframes in-rise{from{transform:translateY(16px)}to{transform:none}}`,
    `@keyframes in-slidex{from{transform:translateX(-140px)}to{transform:translateX(140px)}}`,
    `@keyframes in-wipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}`,
    `.mv{animation-timing-function:cubic-bezier(.16,.84,.3,1);animation-fill-mode:both}`,
    `.punch{animation-name:in-punch}.rise{animation-name:in-rise}.wipe{animation-name:in-wipe}`,
    `.slidex{animation-name:in-slidex;animation-timing-function:linear}`,

    `.big{font-size:136px;font-weight:700;letter-spacing:-0.04em;-webkit-text-stroke:0.028em currentColor;paint-order:stroke fill}`,
    // cropped by the frame on purpose: the type is bigger than the square
    `.bleed{font-size:250px;font-weight:700;letter-spacing:-0.05em;white-space:nowrap}`,
    `.inv{position:absolute;inset:0;display:grid;place-items:center}`,
    `.inv .big{color:#0b1710}`,
    `.slam{position:absolute;inset:0;display:flex}`,
    `.slam>i{flex:1;display:block}`,
    // a chromatic stutter: the same word three times, offset, so it reads as a hit rather than a word
    `.stack{position:relative}`,
    `.stack>span{position:absolute;inset:0;display:grid;place-items:center;mix-blend-mode:screen}`,
    `.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:34px 44px;width:820px;text-align:center;font-size:62px;font-weight:700;letter-spacing:-0.03em}`,
    `.tape{display:flex;gap:64px;font-size:104px;font-weight:700;letter-spacing:-0.035em;white-space:nowrap;filter:url(#lx-h)}`,
    `.frag{width:700px}`,
    // named kick, not k: the tickr mark's letters carry single-letter classes (.t .i .c .k .r), and a
    // bare .k rule restyled the k of the logo itself
    `.kick{font-size:19px;letter-spacing:0.05em;text-transform:uppercase;color:var(--dim);margin-bottom:16px}`,
    `.h1{font-size:64px;font-weight:700;letter-spacing:-0.03em;line-height:1.05}`,
    `.sub{margin-top:14px;font-size:22px;color:var(--muted)}`,
    `.bars{width:700px}`,
    `@keyframes fill1{from{width:6%}to{width:82%}}`,
    `.f1{animation:fill1 var(--d) cubic-bezier(.2,.7,.2,1) both}`,
    `.rows{width:760px;height:520px;overflow:hidden;mask-image:linear-gradient(to bottom,transparent,#000 18%,#000 82%,transparent);-webkit-mask-image:linear-gradient(to bottom,transparent,#000 18%,#000 82%,transparent)}`,
    `@keyframes rowscroll{from{transform:translateY(0)}to{transform:translateY(-620px)}}`,
    `.rowscroll{animation:rowscroll var(--d) linear both;filter:url(#lx-motion)}`,
    `.row{display:flex;align-items:center;gap:22px;padding:22px 0;border-top:1px solid var(--border)}`,
    `.logo{width:66px;height:66px;border-radius:16px;background:#0d1a12;border:1px solid var(--border);display:grid;place-items:center;font-size:22px;font-weight:700;color:var(--muted)}`,
    `.name{font-size:38px;font-weight:700;letter-spacing:-0.02em}`,
    `.chips{display:flex;gap:14px;flex-wrap:wrap;justify-content:center}`,
    `.chip{padding:10px 20px;border:1px solid var(--border);border-radius:999px;font-size:22px;color:var(--muted)}`,
    `.chip.on{border-color:color-mix(in srgb,var(--tickr-signal) 45%,transparent);color:var(--tickr-signal)}`,
    `.fieldrow{display:flex;align-items:baseline;justify-content:space-between;width:100%;border-bottom:1px solid var(--border);padding-bottom:16px}`,

    // act three
    `.rip{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}`,
    `.slot{--tl:1.35em;position:relative;width:100%;height:1.1em;font-size:118px;font-weight:700;letter-spacing:-0.035em;-webkit-text-stroke:0.028em currentColor;paint-order:stroke fill;mask-image:linear-gradient(to bottom,transparent 0,#000 8%,#000 92%,transparent 100%);-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 8%,#000 92%,transparent 100%)}`,
    `.rs,.rg{position:absolute;inset:0}`,
    `.rg{filter:url(#lx-motion)}`,
    `.strip{position:absolute;top:calc((1.1em - var(--tl))/2);left:0;right:0}`,
    // display:block is load bearing: these are spans, and inline boxes ignore height, so the strip
    // collapses onto one line and translates off screen instead of stacking
    `.w{display:block;height:var(--tl);line-height:var(--tl);text-align:center;white-space:nowrap}`,
    Object.values(C).map((c, k) => `.w:nth-child(7n+${k + 1}){color:${c}}`).join(""),

    // act four
    `.lock{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}`,
    `.tag{margin-top:38px;font-size:30px;color:var(--muted);font-weight:500}`,
    `.sw{width:260px!important;height:7px;margin-top:44px}`,

    cuts.join(""),
    `@keyframes move{0%{transform:translate3d(0,0,0)}${at(SHOTS_END)}{transform:translate3d(0,0,0);animation-timing-function:cubic-bezier(${EASE.join(",")})}${at(RIP_END)}{transform:translate3d(0,calc(var(--tl) * -${RIP_N}),0)}100%{transform:translate3d(0,calc(var(--tl) * -${RIP_N}),0)}}`,
    `@keyframes rsharp{0%{opacity:.18}${sharp.join("")}100%{opacity:1}}`,
    `@keyframes rghost{0%{opacity:1}${ghost.join("")}100%{opacity:0}}`,
    `@keyframes ripin{0%{opacity:0}${at(SHOTS_END)}{opacity:1}${at(RIP_END + HOLD)}{opacity:0}100%{opacity:0}}`,
    `@keyframes lockin{0%{opacity:0}${at(LOCKUP_AT)}{opacity:1}100%{opacity:1}}`,
    `.strip{animation:move ${TOTAL}s linear 1 both}`,
    `.rs{animation:rsharp ${TOTAL}s linear 1 both}`,
    `.rg{animation:rghost ${TOTAL}s linear 1 both}`,
    `.rip{animation:ripin ${TOTAL}s steps(1,end) 1 both}`,
    `.lock{animation:lockin ${TOTAL}s steps(1,end) 1 both}`,
    ...["t", "i", "c", "k", "r"].map((l, k) => `.lock .tickr-mark.build-in .${l}{animation-delay:${(LOCKUP_AT + k * 0.15).toFixed(3)}s}`),
    `.lock .tickr-mark.build-in .tittle{animation-delay:${(LOCKUP_AT + 1.0).toFixed(3)}s}`,
  ].join("");
}

const GRID = ["PIZZA", "JEET", "COPE", "PUMP", "FUD", "ZERO", "NFT", "GPT", "BAG"];
const TAPE = ["USELESS", "CARROT", "PENNY", "COIN", "PTSD", "HAIKU", "DUMBASS"];
const ROWS: [string, string, Col][] = [
  ["ba", "banana", "yellow"],
  ["st", "stonk", "blue"],
  ["ca", "cashcat", "pink"],
  ["mo", "moon", "orange"],
  ["fu", "fud", "red"],
  ["gp", "gpt", "signal"],
];

const Strip = () => (
  <span className="strip">
    {REEL.map((w, i) => (
      <span className="w" key={i} style={i === RIP_N ? { color: C.orange } : undefined}>
        {w}
      </span>
    ))}
  </span>
);

function Shot({ s }: { s: Shot }) {
  switch (s.k) {
    case "flash":
      return <div className="inv mv punch" style={{ background: C[s.c] }} />;
    case "slam":
      return (
        <div className="slam mv wipe">
          {(Object.keys(C) as Col[]).map((c) => (
            <i key={c} style={{ background: C[c] }} />
          ))}
        </div>
      );
    case "word":
      return (
        <span className="big mv punch" style={{ color: C[s.c] }}>
          {s.w}
        </span>
      );
    case "invert":
      return (
        <div className="inv mv wipe" style={{ background: C[s.c] }}>
          <span className="big">{s.w}</span>
        </div>
      );
    case "bleed":
      return (
        <span className="bleed mv punch" style={{ color: C[s.c] }}>
          {s.w}
        </span>
      );
    case "stack":
      return (
        <div className="stack mv punch" style={{ width: 900, height: 200 }}>
          <span className="big" style={{ color: C.red, transform: "translate(-9px,-4px)" }}>{s.w}</span>
          <span className="big" style={{ color: C.signal, transform: "translate(9px,4px)" }}>{s.w}</span>
          <span className="big" style={{ color: C.white }}>{s.w}</span>
        </div>
      );
    case "grid":
      return (
        <div className="grid mv rise">
          {GRID.map((w, i) => (
            <span key={w} style={{ color: i === 4 ? C.signal : "color-mix(in srgb, var(--tickr-white) 42%, transparent)" }}>
              {w}
            </span>
          ))}
        </div>
      );
    case "tape":
      return (
        <div className="tape mv slidex">
          {TAPE.map((w, i) => (
            <span key={w} style={{ color: Object.values(C)[i % 7] }}>
              {w}
            </span>
          ))}
        </div>
      );
    case "bars":
      return (
        <div className="bars mv rise" style={{ ["--d" as string]: `${s.d}s` }}>
          <div className="kick">graduation progress</div>
          <div className="progress-track"><div className="progress-fill f1" /></div>
          <div className="sub num">3.4 / 4.2 ETH</div>
        </div>
      );
    case "rows":
      return (
        <div className="rows" style={{ ["--d" as string]: `${s.d}s` }}>
          <div className="rowscroll">
            {[...ROWS, ...ROWS].map(([ab, name, c], i) => (
              <div className="row" key={i}>
                <span className="logo">{ab}</span>
                <span className="name">{name}</span>
                <span className="chip" style={{ marginLeft: "auto", color: C[c], borderColor: `color-mix(in srgb, ${C[c]} 45%, transparent)` }}>
                  paired
                </span>
              </div>
            ))}
          </div>
        </div>
      );
    case "anchor":
      return (
        <div className="frag mv punch" style={{ textAlign: "center" }}>
          <div className="h1">
            anchored to <span style={{ color: C.orange }}>uranus</span>
          </div>
        </div>
      );
    case "chips":
      return (
        <div className="frag chips mv rise">
          <span className="chip on">graduated · v4 pool</span>
          <span className="chip">locked forever</span>
          <span className="chip">fee 1.00%</span>
        </div>
      );
    case "field":
      return (
        <div className="frag mv rise">
          <div className="kick">ticker</div>
          <div className="fieldrow">
            <span className="h1">baguette</span>
            <span className="sub" style={{ color: C.signal }}>available</span>
          </div>
        </div>
      );
    case "locked":
      return (
        <div className="frag mv punch" style={{ textAlign: "center" }}>
          <div className="kick">liquidity</div>
          <div className="h1">locked forever</div>
          <div className="sub">nobody can withdraw it, including us</div>
        </div>
      );
  }
}

export default function LaunchCut() {
  return (
    <div className="lx">
      <style dangerouslySetInnerHTML={{ __html: sheet() }} />
      <script type="application/json" id="lx-timeline" dangerouslySetInnerHTML={{ __html: JSON.stringify(CUES) }} />
      <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute" }}>
        <filter id="lx-motion" x="-20%" y="-70%" width="140%" height="240%">
          <feGaussianBlur stdDeviation="0 13" edgeMode="none" />
        </filter>
        {/* the tape travels sideways, so its smear has to as well */}
        <filter id="lx-h" x="-70%" y="-20%" width="240%" height="140%">
          <feGaussianBlur stdDeviation="14 0" edgeMode="none" />
        </filter>
      </svg>

      {SHOTS.map((s, i) => (
        <div className={`sh s${i}`} key={i}>
          <Shot s={s} />
        </div>
      ))}

      <div className="rip">
        <div className="slot">
          <div className="rs"><Strip /></div>
          <div className="rg"><Strip /></div>
        </div>
      </div>

      <div className="lock">
        <TickrMark size={168} buildIn />
        <div className="tag">
          pair anything on <span className="cap">Robinhood Chain</span>.
        </div>
        <SwatchBar className="sw" />
      </div>
    </div>
  );
}
