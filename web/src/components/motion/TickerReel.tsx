/**
 * The hero's ticker window.
 *
 * It tears through a run of example tickers, lands on one, holds it for a beat, then tears off again.
 * The blur is a real directional one: an SVG gaussian with a vertical-only deviation, so the words smear
 * along the direction of travel instead of turning to mush. It rides on a duplicate layer that is
 * cross-faded against the sharp one, because a filter primitive cannot be animated from CSS.
 *
 * Every word lands. The strip is the list repeated, and a landing falls every RUN words: RUN and the list
 * length are coprime, so the landing walks the list by a stride of RUN and takes one full lap before it
 * repeats. Consecutive landings are six apart in the list, which is why they read as unrelated.
 *
 * All of it is generated keyframes: no state, no effect, no hydration. The reel is running in the first
 * painted frame.
 *
 * The words are examples. Never a real stock ticker.
 */

export const REEL_TICKERS = [
  "PIZZA",
  "INU",
  "JEET",
  "COPE",
  "AI",
  "FART",
  "BANANA",
  "NVDA",
  "CARROT",
  "PENNY",
  "DUMBASS",
  "BAG",
  "STONK",
  "COIN",
  "ZERO",
  "PUMP",
  "NGMI",
  "PTSD",
  "FUD",
  "JPEG",
  "BONER",
  "ANUS",
  "GANGBANG",
  "CREAMPIE",
  "BAGUETTE",
];

const N = REEL_TICKERS.length;

/**
 * Words torn through between two landings. It has to be coprime with the list length, or the landing walks a
 * cycle shorter than the list and only some words ever come to rest: six and thirty-four share a factor of two,
 * which would have landed half of them. Picked here rather than typed, so editing the word list cannot silently
 * break it. Preference order is the sizes that feel right; the first one coprime with N wins.
 */
const RUN = [6, 5, 7, 4, 8].find((r) => {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  return gcd(r, N) === 1;
}) as number;
const WHIP = 0.34; // seconds of tearing, for a full run
const HOLD = 0.86; // seconds the landed word is held still

/** One landing per word. The strip is that many runs long, which is a whole number of list copies. */
const STOPS = Array.from({ length: N }, (_, k) => (k + 1) * RUN);
const TOTAL = STOPS[STOPS.length - 1];
const COPIES = TOTAL / N;

/** Start time of each run, and the whole cycle's length. */
const STARTS: number[] = [];
let clock = 0;
for (let s = 0; s < STOPS.length; s++) {
  STARTS.push(clock);
  clock += WHIP * ((STOPS[s] - (s === 0 ? 0 : STOPS[s - 1])) / RUN) + HOLD;
}
const DURATION = clock;

/**
 * The mark's swatches, by position on the strip, selected with nth-child instead of an inline style.
 *
 * Seven slots for six colours, and the length matters: a landing falls every RUN words, so a palette whose
 * length shares a factor with RUN puts every landing on the same slot. Six colours against runs of six made
 * every landed ticker blue. Seven is coprime with every RUN above, so the landing walks the whole palette.
 * The wrap copy's colour is pinned separately, in `reel-seam`, rather than left to arithmetic. No white: the
 * headline is white, and a white landing read as part of the sentence rather than as the ticker.
 */
const PALETTE = [
  "var(--tickr-sw-blue-type)",
  "var(--tickr-sw-yellow)",
  "var(--tickr-sw-pink)",
  "var(--tickr-sw-red)",
  "var(--tickr-sw-orange)",
  "var(--tickr-signal)",
  "var(--tickr-sw-pink)",
];

/**
 * Advance width of each word, in em, measured in the browser against the rendered face: Instrument Sans
 * 700 at the headline's -0.035em letter-spacing, lowercased. The window is sized to the landed word from
 * this table, so the headline recentres on every landing and the sentence keeps one plain word space
 * instead of a hole. Re-measure these if the headline's face, weight or tracking changes.
 */
const WIDTH: Record<string, number> = {
  PIZZA: 2.2863,
  INU: 1.3781,
  JEET: 1.6922,
  COPE: 2.2352,
  AI: 0.7503,
  FART: 1.6091,
  BANANA: 3.3412,
  USELESS: 3.32,
  CARROT: 2.7112,
  PENNY: 2.7972,
  DUMBASS: 4.1431,
  BAG: 1.7081,
  STONK: 2.522,
  COIN: 1.9102,
  ZERO: 1.9302,
  PUMP: 2.6772,
  NGMI: 2.3192,
  PONZI: 2.4461,
  PTSD: 2.0391,
  FUD: 1.4941,
  JPEG: 1.9771,
  THICKASS: 3.6961,
  CASHCAT: 3.4961,
  NFT: 1.2972,
  GPT: 1.558,
  BONER: 2.6582,
  ANUS: 2.1411,
  HAIKU: 2.4132,
  MOON: 2.6373,
  THREESOME: 4.9272,
  GANGBANG: 4.606,
  CREAMPIE: 4.2221,
  BAGUETTE: 4.101,
};
/** Slack for the text stroke either side plus the trailing letter-space the measurement omits. */
const WIDTH_SLACK = 0.09;
const widthOf = (i: number) => (WIDTH[REEL_TICKERS[i % N]] + WIDTH_SLACK).toFixed(4);

const at = (t: number) => `${((t / DURATION) * 100).toFixed(4)}%`;
const y = (i: number) => `translate3d(0, calc(var(--reel-line) * -${i}), 0)`;

function buildKeyframes(): string {
  const move: string[] = [];
  const width: string[] = [];
  const sharp: string[] = [];
  const ghost: string[] = [];

  for (let s = 0; s < STOPS.length; s++) {
    const t0 = STARTS[s];
    const from = s === 0 ? 0 : STOPS[s - 1];
    const whip = WHIP * ((STOPS[s] - from) / RUN);

    // No keyframe between a landing and the next run: both hold because the value does not change.
    move.push(`${at(t0)}{transform:${y(from)};animation-timing-function:cubic-bezier(.55,0,.14,1)}`);
    move.push(`${at(t0 + whip)}{transform:${y(STOPS[s])}}`);

    // The window breathes between the two landings' widths, under the blur, so the headline is already
    // recentred by the time the word is legible again.
    width.push(`${at(t0)}{width:${widthOf(from)}em;animation-timing-function:cubic-bezier(.4,0,.2,1)}`);
    width.push(`${at(t0 + whip)}{width:${widthOf(STOPS[s])}em}`);

    for (const [f, a, b] of [
      [0, 1, 0],
      [0.12, 0, 1],
      [0.8, 0, 1],
      [1, 1, 0],
    ] as const) {
      sharp.push(`${at(t0 + whip * f)}{opacity:${a}}`);
      ghost.push(`${at(t0 + whip * f)}{opacity:${b}}`);
    }
  }
  move.push(`100%{transform:${y(TOTAL)}}`);
  width.push(`100%{width:${widthOf(TOTAL)}em}`);
  sharp.push(`100%{opacity:1}`);
  ghost.push(`100%{opacity:0}`);

  const colours = REEL_TICKERS.map((_, k) => `.reel-word:nth-child(${N}n+${k + 1}){color:${PALETTE[k % PALETTE.length]}}`);

  return [
    `@keyframes reel-move{${move.join("")}}`,
    `@keyframes reel-width{${width.join("")}}`,
    `@keyframes reel-sharp{${sharp.join("")}}`,
    `@keyframes reel-ghost{${ghost.join("")}}`,
    colours.join(""),
    // The strip closes on a copy of the first word. It has to be the first word's colour too, or the loop
    // flashes a recoloured duplicate at the seam. Pinned, so it holds for any list length.
    `.reel-word:last-child{color:${PALETTE[0]}}`,
    `.reel{width:${widthOf(0)}em}`,
    `.reel,.reel-strip,.reel-sharp,.reel-ghost{animation-duration:${DURATION.toFixed(3)}s}`,
    // Reduced motion parks the reel on the first landing, sharp.
    `@media (prefers-reduced-motion: reduce){.reel{animation:none;width:${widthOf(RUN)}em}` +
      `.reel-strip{animation:none;transform:${y(RUN)}}` +
      `.reel-sharp{animation:none;opacity:1}.reel-ghost{animation:none;opacity:0}}`,
  ].join("");
}

const SHEET = buildKeyframes();
/** The strip closes on a copy of the first word so the loop lands on the frame it opened with. */
const STRIP = [...Array.from({ length: COPIES }, () => REEL_TICKERS).flat(), REEL_TICKERS[0]];

function Strip() {
  return (
    <span className="reel-strip">
      {STRIP.map((word, i) => (
        <span className="reel-word" key={i}>
          {word}
        </span>
      ))}
    </span>
  );
}

export function TickerReel() {
  return (
    <span className="reel">
      <style dangerouslySetInnerHTML={{ __html: SHEET }} />
      {/* The filter sits on the window, not on the strip: the region is a small box around the window, so
          the browser rasterises a couple of hundred pixels rather than the strip's full height. It reaches
          well past the window on purpose, which is what lets ink from the next word bridge the space. */}
      <svg className="reel-defs" aria-hidden="true" focusable="false">
        <filter id="reel-motion" x="-15%" y="-70%" width="130%" height="240%">
          <feGaussianBlur stdDeviation="0 12" edgeMode="none" />
        </filter>
      </svg>
      <span className="reel-sharp" aria-hidden="true">
        <Strip />
      </span>
      <span className="reel-ghost" aria-hidden="true">
        <Strip />
      </span>
      {/* the reel is decoration; a screen reader gets the sentence, not thirty-five words */}
      <span className="sr-only">any ticker</span>
    </span>
  );
}
