import { REEL_TICKERS } from "@/components/motion/TickerReel";
import { TickrMark } from "@/components/Mark";
import { SwatchBar } from "@/components/Mark";

/**
 * A square teaser, for capture rather than for browsing: 1080x1080, no chrome, one pass.
 *
 * It runs the whole ticker list past at speed under a directional blur, then cuts to the mark building in,
 * with the tittle dropping onto the i last. Nothing loops: the capture script drives `currentTime`, so the
 * timeline below is the storyboard and every frame is deterministic.
 */

const WORDS = REEL_TICKERS;
const N = WORDS.length;
const PER = 0.135; // seconds a word holds in the reel
const REEL_END = N * PER; // the whole list, once
const WORD_HOLD = 0.45; // the landed ticker is held, so it registers
const CLEAR = 0.4; // then the frame is empty ground: the mark arrives on its own, never over a ticker
const REEL_OUT = REEL_END + WORD_HOLD;
const LOCKUP_AT = REEL_OUT + CLEAR;
const TOTAL = LOCKUP_AT + 3.1;

const PALETTE = [
  "var(--tickr-sw-blue-type)",
  "var(--tickr-sw-yellow)",
  "var(--tickr-sw-pink)",
  "var(--tickr-sw-red)",
  "var(--tickr-sw-orange)",
  "var(--tickr-signal)",
];

const at = (t: number) => `${((t / TOTAL) * 100).toFixed(4)}%`;

/** The reel's own easing: leaves at speed, decelerates a long way into the last word. */
const EASE = [0, 0.72, 0.24, 1] as const;

const bez = (a: number, b: number, s: number) => {
  const u = 1 - s;
  return 3 * u * u * s * a + 3 * u * s * s * b + s * s * s;
};
/** progress at time fraction x */
function ease(x: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (bez(EASE[0], EASE[2], m) < x) lo = m;
    else hi = m;
  }
  return bez(EASE[1], EASE[3], (lo + hi) / 2);
}
/** the time fraction at which progress reaches y: the inverse, for scheduling a tick per word */
function easeInv(y: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (bez(EASE[1], EASE[3], m) < y) lo = m;
    else hi = m;
  }
  return bez(EASE[0], EASE[2], (lo + hi) / 2);
}

/** Wall-clock time each word boundary crosses the window. The reel's rhythm, and the sound's. */
const TICKS = Array.from({ length: N }, (_, k) => REEL_END * easeInv((k + 1) / N));

/**
 * When the tittle first touches the i. Its drop is a 380ms ease-out-back, so it arrives at the resting
 * point before the animation ends and then settles back onto it; the touch is the first crossing.
 */
const DROP_AT = LOCKUP_AT + 1.0;
const BELL = (() => {
  const [x1, y1, x2, y2] = [0.34, 1.56, 0.64, 1];
  for (let i = 1; i <= 400; i++) {
    const s = i / 400;
    if (bez(y1, y2, s) >= 1) return DROP_AT + 0.38 * bez(x1, x2, s);
  }
  return DROP_AT + 0.38;
})();

function sheet(): string {
  /* Rip, then stop.
     The blur is not a switch, it is the reel's own speed: the crossfade between the sharp layer and the
     blurred one is sampled straight off the derivative of the easing above. So the smear thins out as the
     reel decelerates and has fully lifted by the last word, instead of holding full strength and cutting
     off at the end. The reel still opens blurred, because the window is shorter than the word pitch: at
     any speed below a rip you are between two words, and a half word reads as a bug. */
  const STEPS = 26;
  const sharp: string[] = [];
  const ghost: string[] = [];
  let peak = 0;
  const vs: number[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const x = i / STEPS;
    const h = 0.5 / STEPS;
    const v = (ease(Math.min(1, x + h)) - ease(Math.max(0, x - h))) / (Math.min(1, x + h) - Math.max(0, x - h));
    vs.push(v);
    if (v > peak) peak = v;
  }
  for (let i = 0; i <= STEPS; i++) {
    // ^0.55 because the smear reads perceptually, not linearly, in speed
    const v = Math.pow(vs[i] / peak, 0.55);
    const t = at((i / STEPS) * REEL_END);
    ghost.push(`${t}{opacity:${v.toFixed(3)}}`);
    sharp.push(`${t}{opacity:${(1 - 0.82 * v).toFixed(3)}}`);
  }

  return [
    `@keyframes tz-move{` +
      `0%{transform:translate3d(0,0,0);animation-timing-function:cubic-bezier(0,.72,.24,1)}` +
      `${at(REEL_END)}{transform:translate3d(0,calc(var(--tl) * -${N}),0)}` +
      `100%{transform:translate3d(0,calc(var(--tl) * -${N}),0)}}`,
    `@keyframes tz-sharp{${sharp.join("")}100%{opacity:1}}`,
    `@keyframes tz-ghost{${ghost.join("")}100%{opacity:0}}`,
    // the reel is cut before the mark is cut in, with the clear beat between them
    `@keyframes tz-reel{0%{opacity:1}${at(REEL_OUT)}{opacity:0}100%{opacity:0}}`,
    `@keyframes tz-lock{0%{opacity:0}${at(LOCKUP_AT)}{opacity:1}100%{opacity:1}}`,
    PALETTE.map((c, k) => `.tz-word:nth-child(${PALETTE.length}n+${k + 1}){color:${c}}`).join(""),
    `.tz-strip{animation:tz-move ${TOTAL}s linear 1 both}`,
    `.tz-sharp{animation:tz-sharp ${TOTAL}s linear 1 both}`,
    `.tz-ghost{animation:tz-ghost ${TOTAL}s linear 1 both}`,
    `.tz-reel{animation:tz-reel ${TOTAL}s steps(1,end) 1 both}`,
    `.tz-lock{animation:tz-lock ${TOTAL}s steps(1,end) 1 both}`,
    // The mark's build-in is pushed out to the cut, keeping the shipped 150ms letter stagger and the
    // tittle landing last. Each letter is named because the shipped rule sets its delay individually.
    ...["t", "i", "c", "k", "r"].map((l, k) => `.tz-lock .tickr-mark.build-in .${l}{animation-delay:${(LOCKUP_AT + k * 0.15).toFixed(3)}s}`),
    `.tz-lock .tickr-mark.build-in .tittle{animation-delay:${(LOCKUP_AT + 1.0).toFixed(3)}s}`,
  ].join("");
}

export default function Teaser() {
  return (
    <div className="tz">
      <style dangerouslySetInnerHTML={{ __html: sheet() }} />
      {/* The capture script reads its cue sheet from here rather than from numbers typed twice, so the
          audio cannot drift from the animation it is scored to. */}
      <script
        type="application/json"
        id="tz-timeline"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({ total: TOTAL, reelEnd: REEL_END, reelOut: REEL_OUT, lockupAt: LOCKUP_AT, bell: BELL, ticks: TICKS.map((t) => +t.toFixed(4)) }),
        }}
      />
      <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute" }}>
        <filter id="tz-motion" x="-20%" y="-70%" width="140%" height="240%">
          <feGaussianBlur stdDeviation="0 13" edgeMode="none" />
        </filter>
      </svg>

      <div className="tz-reel">
        <div className="tz-kicker">pair anything on <span className="cap">Robinhood Chain</span>.</div>
        <div className="tz-slot">
          <div className="tz-sharp">
            <div className="tz-strip">
              {[...WORDS, WORDS[0]].map((w, i) => (
                <div className="tz-word" key={i}>
                  {w}
                </div>
              ))}
            </div>
          </div>
          <div className="tz-ghost">
            <div className="tz-strip">
              {[...WORDS, WORDS[0]].map((w, i) => (
                <div className="tz-word" key={i}>
                  {w}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="tz-lock">
        <TickrMark size={168} buildIn />
        <div className="tz-tag">pair anything on <span className="cap">Robinhood Chain</span>.</div>
        <SwatchBar className="tz-swatch" />
      </div>
    </div>
  );
}
