"use client";

import { useEffect, useRef, useState } from "react";
import { SwatchBar } from "./Mark";

/** The mark's order, which the static rule also uses. */
const HUES = [
  "var(--tickr-sw-yellow)",
  "var(--tickr-sw-blue)",
  "var(--tickr-sw-green)",
  "var(--tickr-sw-orange)",
  "var(--tickr-sw-pink)",
  "var(--tickr-sw-red)",
];

const SHIFT_MS = 420;
const HOLD_MS = 1500;

/**
 * The six swatches as a rule, used the same way every time: it opens a section, always in the mark's order,
 * always the same weight. `short` marks a heading, `full` spans the column as a divider between sections.
 */
export function RainbowRule({
  width = "short",
  play = false,
  className = "",
}: {
  width?: "short" | "full";
  /** The hero's rule plays: the block on the right drops away and the row steps along to fill the gap. */
  play?: boolean;
  className?: string;
}) {
  if (play) return <PlayingRule className={className} />;
  return <SwatchBar className={`rainbow-rule ${width === "full" ? "is-full" : "is-short"} ${className}`} />;
}

/**
 * A row of blocks that steps: the rightmost falls away, everything slides one place along, and a new block
 * arrives at the left. Seven slots are rendered so the arriving block has somewhere to come from; the row sits
 * one slot to the left at rest and animates back to zero, which moves every block exactly one place.
 */
function PlayingRule({ className = "" }: { className?: string }) {
  const [order, setOrder] = useState(HUES);
  const [shifting, setShifting] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const id = setInterval(() => {
      setShifting(true);
      timers.current.push(
        setTimeout(() => {
          // the block that fell off the right comes back on the left
          setOrder((o) => [o[o.length - 1], ...o.slice(0, -1)]);
          setShifting(false);
        }, SHIFT_MS),
      );
    }, HOLD_MS + SHIFT_MS);
    return () => {
      clearInterval(id);
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, []);

  // the arriving block is the one about to fall, so the palette keeps its order as the row cycles
  const slots = [order[order.length - 1], ...order];

  return (
    <div className={`swatch-play ${className}`} aria-hidden="true">
      <div className={`swatch-row ${shifting ? "is-shifting" : ""}`}>
        {slots.map((hue, i) => (
          <i
            key={`${i}-${hue}`}
            style={{ background: hue }}
            className={i === 0 ? "swatch-in" : i === slots.length - 1 && shifting ? "swatch-fall" : ""}
          />
        ))}
      </div>
    </div>
  );
}

/** A heading with its rule above it, so every section on the page opens identically. */
export function SectionHead({ title, children, id }: { title: string; children?: React.ReactNode; id?: string }) {
  return (
    <div className="section-head" id={id}>
      <RainbowRule />
      <div className="flex items-baseline gap-3 flex-wrap mt-4">
        <h2 className="section-h">{title}</h2>
        {children}
      </div>
    </div>
  );
}
