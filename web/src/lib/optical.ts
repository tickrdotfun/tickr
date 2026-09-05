/**
 * Optical centring for pill-shaped labels.
 *
 * A pill padded equally centres the em box, not the ink, and the ink sits somewhere different depending on
 * which letters a word has: all-caps has no descender and rides high, an x-height-only word rides low.
 * These constants are measured rather than guessed, from Instrument Sans 700 through canvas TextMetrics,
 * with line-height 1 putting the baseline 0.86em below the top of the line box.
 */
const BASELINE = 0.86;
const ASC_CAPS = 0.72; // cap height
const ASC_TALL = 0.74; // ascenders, and the dots on i and j
const ASC_X = 0.52; // x-height only
const DESC = 0.215;
const DESC_NONE = 0.01;

/**
 * How far to move a label so its ink, not its em box, sits in the middle of its pill. In em.
 *
 * `keepsCase` matters because the interface lowercases everything by default: a label written NGMI in the
 * source renders as `ngmi` and grows a descender, so the rendered form is what has to be measured.
 */
export function inkNudge(label: string, keepsCase = false): number {
  const shown = keepsCase ? label : label.toLowerCase();
  const allCaps = /[A-Z]/.test(shown) && !/[a-z]/.test(shown);
  const asc = allCaps ? ASC_CAPS : /[bdfhkltij]/.test(shown) ? ASC_TALL : ASC_X;
  const desc = /[gjpqy]/.test(shown) ? DESC : DESC_NONE;
  return 0.5 - BASELINE + (asc - desc) / 2;
}
