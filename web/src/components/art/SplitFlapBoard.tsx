"use client";

import { useTickerCycle } from "../motion/TickerCycle";
import { FONT, HUES, INK, PAPER, RADIUS, STROKE } from "./system";

/** The cells are the one multicolour element in this drawing, per the guide. */
const CELL_HUES = [HUES.yellow, HUES.blue, HUES.pink, HUES.green, HUES.orange, HUES.red] as const;
const CELLS = 6;
const CELL_W = 84;
const CELL_H = 104;
const GAP = 10;
const STAGGER_MS = 70;

/**
 * A departure board spelling the ticker the headline is typing. The letter is split across the two halves of
 * each cell; on a new word the top half falls and returns, in sequence across the board.
 *
 * No state and no effect: each flap is keyed by the word it belongs to, so a new word remounts it and its CSS
 * animation runs again from the start.
 */
export function SplitFlapBoard({ fallback = "TICKR" }: { fallback?: string }) {
  const cycle = useTickerCycle();
  const word = (cycle?.word ?? fallback).toUpperCase().slice(0, CELLS);
  const turn = cycle?.index ?? 0;
  const letters = word.padEnd(CELLS, " ").split("").slice(0, CELLS);
  const boardW = CELLS * CELL_W + (CELLS - 1) * GAP;
  const x0 = (640 - boardW) / 2;
  const y0 = 150;
  const mid = y0 + CELL_H / 2;

  return (
    <svg viewBox="0 0 640 400" className="flap-board" role="img" aria-label={`split-flap board spelling ${word.trim()}`}>
      <defs>
        {letters.map((_, i) => {
          const x = x0 + i * (CELL_W + GAP);
          return (
            <g key={`clip-${i}`}>
              <clipPath id={`flap-top-${i}`}>
                <rect x={x} y={y0} width={CELL_W} height={CELL_H / 2} />
              </clipPath>
              <clipPath id={`flap-bot-${i}`}>
                <rect x={x} y={mid} width={CELL_W} height={CELL_H / 2} />
              </clipPath>
            </g>
          );
        })}
      </defs>

      {/* ribbons: flat, unoutlined, one behind the board and one in front of its legs */}
      <path d="M-30 118 L300 38 L342 106 L12 186 Z" fill={HUES.blue} opacity="0.85" />
      <path d="M330 300 L700 214 L700 268 L344 356 Z" fill={HUES.green} opacity="0.9" />

      <g stroke={INK} strokeWidth={STROKE} strokeLinejoin="round" strokeLinecap="round">
        <rect x={x0 - 20} y={y0 - 24} width={boardW + 40} height={CELL_H + 48} rx={10} fill="#0F2C1D" />
        {letters.map((ch, i) => {
          const x = x0 + i * (CELL_W + GAP);
          const cx = x + CELL_W / 2;
          const hue = CELL_HUES[i % CELL_HUES.length];
          const glyph = ch.trim();
          return (
            <g key={i}>
              {/* lower half: white card, lower half of the letter */}
              <rect x={x} y={y0} width={CELL_W} height={CELL_H} rx={RADIUS} fill={PAPER} />
              <g clipPath={`url(#flap-bot-${i})`}>
                <text
                  x={cx}
                  y={mid}
                  fill={INK}
                  stroke="none"
                  fontFamily={FONT}
                  fontWeight="700"
                  fontSize="54"
                  letterSpacing="-0.02em"
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {glyph}
                </text>
              </g>
              {/* upper half: the flap that falls, carrying the top of the letter */}
              <g
                key={`leaf-${turn}-${i}`}
                className="flap-leaf"
                style={{ transformOrigin: `${cx}px ${mid}px`, animationDelay: `${i * STAGGER_MS}ms` }}
              >
                <rect x={x} y={y0} width={CELL_W} height={CELL_H / 2} fill={hue} stroke="none" />
                <g clipPath={`url(#flap-top-${i})`}>
                  <text
                    x={cx}
                    y={mid}
                    fill={INK}
                    stroke="none"
                    fontFamily={FONT}
                    fontWeight="700"
                    fontSize="54"
                    letterSpacing="-0.02em"
                    textAnchor="middle"
                    dominantBaseline="central"
                  >
                    {glyph}
                  </text>
                </g>
              </g>
              <rect x={x} y={y0} width={CELL_W} height={CELL_H} rx={RADIUS} fill="none" />
              <path d={`M${x} ${mid} L${x + CELL_W} ${mid}`} strokeWidth={STROKE / 2} />
            </g>
          );
        })}
        <path d={`M${x0 + 40} ${y0 + CELL_H + 24} L${x0 + 22} 342`} />
        <path d={`M${x0 + boardW - 40} ${y0 + CELL_H + 24} L${x0 + boardW - 22} 342`} />
      </g>
    </svg>
  );
}
