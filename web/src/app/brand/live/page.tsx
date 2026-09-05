import { TickrMark, SwatchBar } from "@/components/Mark";
import { inkNudge } from "@/lib/optical";

/**
 * The launch film: 1080x1080, for capture, no chrome, one pass.
 *
 * Three beats and no more, because a launch video has one job and the URL is it:
 *
 *   1  your coin, and the things it can be priced against arriving one per eighth note
 *   2  a rip through the tickers that resolves on the word ANYTHING, which is the pitch
 *   3  the standard outro, with the address where the tagline usually sits
 *
 * It runs on paper, not on the brand ground: the first two acts are dark ink on off-white, and the frame
 * inverts to brand green on the landing hit. The flip is the moment, and it also means the outro still
 * arrives on the green it is specified to arrive on.
 *
 * Everything sits on a 150bpm grid and the page publishes its own drum chart, so the score plays the cuts
 * rather than being fitted to them afterwards.
 */

const PAPER = "#F4F7F4";
const INK = "#0B1710";

const C = {
  yellow: "var(--tickr-sw-yellow)",
  blue: "var(--tickr-sw-blue)",
  orange: "var(--tickr-sw-orange)",
  pink: "var(--tickr-sw-pink)",
  red: "var(--tickr-sw-red)",
  green: "var(--tickr-sw-green)",
  ink: INK,
};

/** On paper the reel cannot use yellow or white; these all hold against off-white. */
const RIP_INK = [INK, "var(--tickr-sw-blue)", "var(--tickr-sw-red)", "var(--tickr-sw-green)", "var(--tickr-sw-orange)"];

/** label, colour, filled, tilt, x%, y%, size, keeps its own case */
const CHIPS: [string, string, boolean, number, number, number, number, boolean][] = [
  ["TENDIES", C.yellow, true, -6, 22, 19, 60, false],
  ["GOONER", C.pink, true, 5, 75, 23, 58, false],
  ["ETH", C.blue, true, -4, 12, 55, 54, true],
  ["COPIUM", C.orange, true, 4, 72, 61, 56, false],
  ["USDG", C.green, false, -5, 25, 81, 48, true],
  ["RIZZ", C.red, true, 6, 77, 83, 54, false],
  ["TOILET", C.blue, false, -3, 47, 8, 50, false],
  ["BALLS", C.ink, false, 4, 51, 92, 46, false],
];

/** The rip's own list. Fresh words, so the film is not the site's reel with a new soundtrack. */
const RIP_WORDS = [
  "TENDIES", "GOONER", "COPIUM", "RIZZ", "BALLS", "TOILET", "HOPIUM", "SHRIMP",
  "YEET", "LARP", "REKT", "COPE", "DEGEN", "SIGMA", "BOOMER", "WAGMI",
  "GLIZZY", "CHUD", "SLOP", "MOGGED", "AURA", "CRASHOUT", "NPC", "GOATED",
];

// ---- the grid: 150bpm
const EIGHTH = 0.2;
const BEAT = EIGHTH * 2;
const BAR = BEAT * 4;

const T0 = 0.2;
const PLATE_AT = T0; // "your coin" lands first
const CHIP_AT = CHIPS.map((_, i) => +(T0 + EIGHTH * (i + 1)).toFixed(4));
const ACT1_END = +(T0 + EIGHTH * (CHIPS.length + 1)).toFixed(4);

const RIP_LEN = BAR;
const RIP_END = +(ACT1_END + RIP_LEN).toFixed(4);
const HOLD = BEAT * 2; // room for ANYTHING to run the palette
const CLEAR = BEAT;
const LOCKUP_AT = +(RIP_END + HOLD + CLEAR).toFixed(4);
const TOTAL = +(LOCKUP_AT + 4.4).toFixed(4);

// ---- the reel resolves on the pitch itself, not on another punchline
const LAND_ON = "ANYTHING";
const REEL = [...RIP_WORDS, LAND_ON];
const RIP_N = RIP_WORDS.length;

/** ANYTHING runs the whole palette on sixteenths, one swap per tick, while the frame holds. */
const CYCLE = ["var(--tickr-signal)", "var(--tickr-sw-yellow)", "var(--tickr-sw-pink)", "var(--tickr-sw-orange)", "var(--tickr-sw-red)", "var(--tickr-sw-blue-type)", "var(--tickr-white)", "var(--tickr-signal)"];
const SIXTEENTH = EIGHTH / 2;
const CYCLE_AT = CYCLE.map((_, i) => +(RIP_END + i * SIXTEENTH).toFixed(4));

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

/** The tittle's 380ms ease-out-back reaches the resting point before it ends; the touch is that crossing. */
const BELL = +(LOCKUP_AT + 1.0 + 0.38 * bz(0.34, 0.64, solve(1.56, 1, 1))).toFixed(4);

/**
 * The drum chart, published for the score to play.
 *
 * Bar one is the pattern under the chips, one hit per arrival. The rip keeps the pattern for two beats and
 * then doubles into a fill. The landing takes a single heavy hit and everything stops: the mark builds in
 * silence so the bell has the room to land.
 */
const BEATS = (() => {
  const out: { t: number; w: string }[] = [];
  let i = 0;
  for (let t = T0; t < ACT1_END - 1e-9; t += EIGHTH, i++) {
    out.push({ t: +t.toFixed(4), w: i % 4 === 0 ? "boom" : i % 4 === 2 ? "clap" : "tick" });
  }
  // the rip: two beats of the same pattern, then sixteenths into the landing
  let t = ACT1_END;
  for (; t < ACT1_END + BEAT * 2 - 1e-9; t += EIGHTH, i++) {
    out.push({ t: +t.toFixed(4), w: i % 4 === 0 ? "boom" : i % 4 === 2 ? "clap" : "tick" });
  }
  for (; t < RIP_END - 1e-9; t += EIGHTH / 2) out.push({ t: +t.toFixed(4), w: "fill" });
  out.push({ t: RIP_END, w: "land" });
  for (const t of CYCLE_AT.slice(1)) out.push({ t, w: "cycle" });
  return out;
})();

const CUES = { total: TOTAL, beats: BEATS, ripEnd: RIP_END, lockupAt: LOCKUP_AT, bell: BELL };

function sheet(): string {
  // the blur crossfade rides the rip's own derivative, so the smear thins as it slows and is gone on landing
  const STEPS = 24;
  const vs: number[] = [];
  let peak = 0;
  for (let k = 0; k <= STEPS; k++) {
    const x = k / STEPS, h = 0.5 / STEPS;
    const a = Math.max(0, x - h), b = Math.min(1, x + h);
    const v = (ease(b) - ease(a)) / (b - a);
    vs.push(v);
    if (v > peak) peak = v;
  }
  const sharp: string[] = [];
  const ghost: string[] = [];
  for (let k = 0; k <= STEPS; k++) {
    const v = Math.pow(vs[k] / peak, 0.55);
    const t = at(ACT1_END + (k / STEPS) * RIP_LEN);
    ghost.push(`${t}{opacity:${v.toFixed(3)}}`);
    sharp.push(`${t}{opacity:${(1 - 0.82 * v).toFixed(3)}}`);
  }

  const pops = [
    `@keyframes pop{0%{opacity:0;transform:scale(.55)}70%{opacity:1;transform:scale(1.06)}100%{opacity:1;transform:scale(1)}}`,
    `@keyframes lv-plate{0%{opacity:0}${at(PLATE_AT)}{opacity:1}${at(ACT1_END)}{opacity:0}100%{opacity:0}}`,
    `.plate{animation:lv-plate ${TOTAL}s steps(1,end) 1 both}`,
    ...CHIPS.map(
      (_, i) =>
        `@keyframes lv-c${i}{0%{opacity:0}${at(CHIP_AT[i])}{opacity:1}${at(ACT1_END)}{opacity:0}100%{opacity:0}}` +
        `.c${i}{animation:lv-c${i} ${TOTAL}s steps(1,end) 1 both}` +
        `.c${i} i{animation:pop 260ms cubic-bezier(.2,1.5,.4,1) ${CHIP_AT[i]}s both}`,
    ),
  ];

  return [
    `.lv{position:relative;width:1080px;height:1080px;overflow:hidden;animation:ground ${TOTAL}s steps(1,end) 1 both}`,
    `@keyframes ground{0%{background:${PAPER}}${at(RIP_END)}{background:var(--bg)}100%{background:var(--bg)}}`,

    // act one
    `.stage{position:absolute;inset:0}`,
    `.plate{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:26px 44px;border:3px solid ${INK};border-radius:20px;font-size:52px;font-weight:700;white-space:nowrap;color:${INK}}`,
    `.chip{position:absolute;transform:translate(-50%,-50%)}`,
    `.chip i{display:block;font-style:normal;border-radius:999px;font-weight:700;white-space:nowrap;line-height:1}`,
    `.chip i.fill{color:${PAPER}}`,
    `.chip i.out{border:2px solid}`,
    `.chip b{display:block;font-weight:700}`,

    // act two
    `.rip{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}`,
    `.slot{--tl:1.35em;position:relative;width:100%;height:1.1em;font-size:112px;font-weight:700;letter-spacing:-0.035em;-webkit-text-stroke:0.028em currentColor;paint-order:stroke fill;mask-image:linear-gradient(to bottom,transparent 0,#000 8%,#000 92%,transparent 100%);-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 8%,#000 92%,transparent 100%)}`,
    `.rs,.rg{position:absolute;inset:0}`,
    `.rg{filter:url(#lv-blur)}`,
    `.strip{position:absolute;top:calc((1.1em - var(--tl))/2);left:0;right:0}`,
    // display:block is load bearing: spans are inline, and inline boxes ignore height
    `.w{display:block;height:var(--tl);line-height:var(--tl);text-align:center;white-space:nowrap}`,
    RIP_INK.map((c, k) => `.w:nth-child(${RIP_INK.length}n+${k + 1}){color:${c}}`).join(""),

    // act three: the standard outro, with the address where the tagline normally sits
    `.lock{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}`,
    `.url{margin-top:44px;font-size:62px;font-weight:700;letter-spacing:-0.03em}`,
    `.live{position:absolute;left:0;right:0;bottom:62px;display:flex;align-items:center;justify-content:center;gap:13px;font-size:23px;color:var(--muted)}`,
    `.live i{display:block;width:11px;height:11px;border-radius:50%;background:var(--tickr-signal)}`,
    `.sw{width:250px!important;height:7px;margin-top:46px}`,

    /* The ending. A slow push in on the whole lockup, a bloom behind the mark on the bell, the address
       rising rather than cutting, the swatch opening from its centre, and one specular pass over the lot.
       The bell itself is untouched: it is a fixed brand sound and this only adds around it. */
    `@keyframes push{from{transform:scale(1)}to{transform:scale(1.035)}}`,
    `.lock-in{animation:push ${(TOTAL - LOCKUP_AT).toFixed(3)}s cubic-bezier(.22,.61,.25,1) ${LOCKUP_AT}s both;display:flex;flex-direction:column;align-items:center}`,
    `@keyframes bloom{0%{opacity:0;transform:scale(.75)}45%{opacity:.5}100%{opacity:.26;transform:scale(1)}}`,
    `.bloom{position:absolute;width:760px;height:760px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--tickr-signal) 42%,transparent) 0%,transparent 62%);animation:bloom 1400ms cubic-bezier(.2,.7,.2,1) ${BELL}s both;pointer-events:none}`,
    `@keyframes rise{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}`,
    `.url{animation:rise 520ms cubic-bezier(.16,.84,.3,1) ${BELL}s both}`,
    `.live{animation:rise 520ms cubic-bezier(.16,.84,.3,1) ${(BELL + 0.16).toFixed(3)}s both}`,
    `@keyframes openwide{from{clip-path:inset(0 50% 0 50%)}to{clip-path:inset(0 0 0 0)}}`,
    `.sw{animation:openwide 620ms cubic-bezier(.2,.8,.25,1) ${(BELL + 0.3).toFixed(3)}s both}`,
    `@keyframes sheen{from{transform:translateX(-160%) rotate(14deg)}to{transform:translateX(160%) rotate(14deg)}}`,
    `.sheen{position:absolute;inset:-30% -60%;background:linear-gradient(90deg,transparent 38%,rgb(255 255 255 / .5) 50%,transparent 62%);mix-blend-mode:overlay;animation:sheen 1100ms cubic-bezier(.4,0,.3,1) ${(BELL + 0.34).toFixed(3)}s both;pointer-events:none}`,

    ...pops,
    `@keyframes move{0%{transform:translate3d(0,0,0)}${at(ACT1_END)}{transform:translate3d(0,0,0);animation-timing-function:cubic-bezier(${EASE.join(",")})}${at(RIP_END)}{transform:translate3d(0,calc(var(--tl) * -${RIP_N}),0)}100%{transform:translate3d(0,calc(var(--tl) * -${RIP_N}),0)}}`,
    `@keyframes rsharp{0%{opacity:.18}${sharp.join("")}100%{opacity:1}}`,
    `@keyframes rghost{0%{opacity:1}${ghost.join("")}100%{opacity:0}}`,
    `@keyframes ripin{0%{opacity:0}${at(ACT1_END)}{opacity:1}${at(RIP_END + HOLD)}{opacity:0}100%{opacity:0}}`,
    `@keyframes lockin{0%{opacity:0}${at(LOCKUP_AT)}{opacity:1}100%{opacity:1}}`,
    `@keyframes landcolour{0%{color:${INK}}${CYCLE.map((c, i) => `${at(CYCLE_AT[i])}{color:${c}}`).join("")}100%{color:${CYCLE[CYCLE.length - 1]}}}`,
    `.w.land{animation:landcolour ${TOTAL}s steps(1,end) 1 both}`,
    `.strip{animation:move ${TOTAL}s linear 1 both}`,
    `.rs{animation:rsharp ${TOTAL}s linear 1 both}`,
    `.rg{animation:rghost ${TOTAL}s linear 1 both}`,
    `.rip{animation:ripin ${TOTAL}s steps(1,end) 1 both}`,
    `.lock{animation:lockin ${TOTAL}s steps(1,end) 1 both}`,
    ...["t", "i", "c", "k", "r"].map((l, k) => `.lock .tickr-mark.build-in .${l}{animation-delay:${(LOCKUP_AT + k * 0.15).toFixed(3)}s}`),
    `.lock .tickr-mark.build-in .tittle{animation-delay:${(LOCKUP_AT + 1.0).toFixed(3)}s}`,
  ].join("");
}

const Strip = () => (
  <span className="strip">
    {REEL.map((w, i) => (
      <span className={`w${i === RIP_N ? " land" : ""}`} key={i}>
        {w}
      </span>
    ))}
  </span>
);

export default function LaunchFilm() {
  return (
    <div className="lv">
      <style dangerouslySetInnerHTML={{ __html: sheet() }} />
      <script type="application/json" id="lv-timeline" dangerouslySetInnerHTML={{ __html: JSON.stringify(CUES) }} />
      <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute" }}>
        <filter id="lv-blur" x="-20%" y="-70%" width="140%" height="240%">
          <feGaussianBlur stdDeviation="0 13" edgeMode="none" />
        </filter>
      </svg>

      <div className="stage">
        <div className="plate">your coin</div>
        {CHIPS.map(([label, col, fill, tilt, x, y, size, cap], i) => (
          <span key={label} className={`chip c${i}`} style={{ left: `${x}%`, top: `${y}%` }}>
            <i
              className={`${fill ? "fill" : "out"} ${cap ? "cap" : ""}`}
              style={{
                fontSize: size,
                padding: `${Math.round(size * 0.5)}px ${Math.round(size * 0.85)}px`,
                rotate: `${tilt}deg`,
                ...(fill ? { background: col } : { color: col, borderColor: `color-mix(in srgb, ${col} 62%, transparent)` }),
              }}
            >
              <b style={{ transform: `translateY(${inkNudge(label, cap).toFixed(3)}em)` }}>{label}</b>
            </i>
          </span>
        ))}
      </div>

      <div className="rip">
        <div className="slot">
          <div className="rs">
            <Strip />
          </div>
          <div className="rg">
            <Strip />
          </div>
        </div>
      </div>

      <div className="lock">
        <div className="bloom" />
        <div className="lock-in">
          <TickrMark size={166} buildIn />
          <div className="url">tickrfun.gg</div>
          <SwatchBar className="sw" />
        </div>
        <div className="live">
          <i />
          {/* one flex item, not two: a bare text node beside an element picks up the row gap */}
          <span>
            live now on <span className="cap">Robinhood Chain</span>
          </span>
        </div>
        <div className="sheen" />
      </div>
    </div>
  );
}
