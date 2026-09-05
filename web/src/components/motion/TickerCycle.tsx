"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useReducedMotion } from "./reducedMotion";

type Cycle = { word: string; shown: string; index: number };

const Ctx = createContext<Cycle | null>(null);

/** Read the running example ticker, when a provider is above. Returns null outside one. */
export function useTickerCycle(): Cycle | null {
  return useContext(Ctx);
}

/**
 * One cycle of example tickers, shared. The headline types it and the split-flap board spells it, so the two
 * are the same word rather than two things that happen to look similar.
 */
export function TickerCycleProvider({ words, children }: { words: string[]; children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const [state, setState] = useState({ word: 0, chars: 0, deleting: false });

  useEffect(() => {
    if (reduced) return;
    const current = words[state.word % words.length];
    const atEnd = !state.deleting && state.chars === current.length;
    const atStart = state.deleting && state.chars === 0;
    const delay = atEnd ? 1700 : atStart ? 140 : state.deleting ? 34 : 68;
    const timer = setTimeout(() => {
      setState((s) => {
        const w = words[s.word % words.length];
        if (!s.deleting && s.chars === w.length) return { ...s, deleting: true };
        if (s.deleting && s.chars === 0) return { word: s.word + 1, chars: 0, deleting: false };
        return { ...s, chars: s.chars + (s.deleting ? -1 : 1) };
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [state, words, reduced]);

  const word = reduced ? words[0] : words[state.word % words.length];
  const value: Cycle = { word, shown: reduced ? words[0] : word.slice(0, state.chars), index: state.word };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
