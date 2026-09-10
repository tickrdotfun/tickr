import { DRAW_HUES, FONT, GROUND, HUES, INK, PAPER, STROKE, hashOf, pick, shade } from "./system";

/**
 * The picture a launch gets when its creator uploaded none: a letterpress sort with the ticker on its face,
 * coloured from the ticker so the same ticker always looks the same. One block, two flat colours, never rainbow.
 */
type Art = { hue: string; ribbon: string; letters: string };

export function artFor(ticker: string): Art {
  const t = (ticker || "?").toUpperCase();
  const h = hashOf(t);
  const hue = pick(DRAW_HUES, h >>> 3);
  const ribbon = pick(
    DRAW_HUES.filter((c) => c !== hue),
    h >>> 11,
  );
  return { hue, ribbon, letters: t.slice(0, 4) };
}

export function TickerObject({ ticker, className = "" }: { ticker: string; className?: string }) {
  const { hue, ribbon, letters } = artFor(ticker);
  return (
    <svg viewBox="0 0 240 240" className={className} role="img" aria-label={`${letters} artwork`} preserveAspectRatio="xMidYMid slice">
      <rect width="240" height="240" fill={GROUND} />
      {/* the ribbon bleeds off both edges, so it reads as one band the full width of the card */}
      <path d="M-24 206 L264 146 L264 88 L-24 148 Z" fill={ribbon} opacity="0.9" />
      <g stroke={INK} strokeWidth={STROKE} strokeLinejoin="round" strokeLinecap="round">
        <TypeBlock hue={hue} letters={letters} />
      </g>
    </svg>
  );
}

type Parts = { hue: string; letters: string };

/** A letterpress sort: cube, letter raised on the top face. */
function TypeBlock({ hue, letters }: Parts) {
  const left = shade(hue, 0.85);
  const right = shade(hue, 0.7);
  return (
    <g>
      <path d="M120 52 L188 92 L120 132 L52 92 Z" fill={PAPER} />
      <path d="M52 92 L120 132 L120 196 L52 156 Z" fill={left} />
      <path d="M188 92 L120 132 L120 196 L188 156 Z" fill={right} />
      <text
        x="0"
        y="0"
        fill={INK}
        stroke="none"
        fontFamily={FONT}
        fontWeight="700"
        fontSize="30"
        letterSpacing="-0.02em"
        textAnchor="middle"
        dominantBaseline="central"
        transform="matrix(0.866,0.5,-0.866,0.5,120,92)"
      >
        {letters.slice(0, 2)}
      </text>
    </g>
  );
}





export { HUES };
