/**
 * Shared values for the illustration system. The rules these come from are written down in
 * `branding3/ILLUSTRATION.md`; change that file before changing these.
 */

/** The six hues. Red is reserved for rescued launches and error art, so it is not in the drawing pool. */
export const HUES = {
  yellow: "#F5C63C",
  orange: "#F0862A",
  pink: "#F4B8C6",
  blue: "#5B78F0",
  green: "#3DDC84",
  red: "#E23B2E",
} as const;

export const INK = "#070807";
export const GROUND = "#0B1F14";
export const PAPER = "#F4F7F4";

/** Colours an object may be drawn in. Red is deliberately absent. */
export const DRAW_HUES = [HUES.yellow, HUES.orange, HUES.pink, HUES.blue, HUES.green] as const;

/** Face shading, flat: top full, left 85%, right 70%. */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * amount);
  const g = Math.round(((n >> 8) & 255) * amount);
  const b = Math.round((n & 255) * amount);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

export const STROKE = 6;
export const RADIUS = 4;
export const FONT = "var(--font-ui), ui-sans-serif, system-ui, sans-serif";

/** Stable across reloads and machines, so one ticker always draws the same thing. */
export function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pick<T>(list: readonly T[], seed: number): T {
  return list[seed % list.length];
}
