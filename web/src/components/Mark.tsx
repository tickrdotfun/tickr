/**
 * The tickr mark (branding2/BRANDING.md §2): lowercase `tıckr` in Source Serif 4 600 with
 * a dotless ı (U+0131), a hand-set bounce, a swatch per letter, and a detached signal-green dot.
 * Scale by `size` (font-size) only; every other value is a ratio in globals.css.
 * Below 24px use <TickrIcon /> (the t + dot lockup). The bounce is logo-only.
 */
export function TickrMark({
  size = 60,
  blink = false,
  buildIn = false,
  drift = false,
  onLight = false,
  className = "",
}: {
  size?: number;
  blink?: boolean;
  buildIn?: boolean;
  /** Keep the letters drifting up and down for as long as the mark is on screen. Header only. */
  drift?: boolean;
  onLight?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`tickr-mark ${onLight ? "on-light" : ""} ${buildIn ? "build-in" : ""} ${drift ? "drift" : ""} ${className}`}
      style={{ fontSize: size }}
      role="img"
      aria-label="tickr"
    >
      <span className="l t" aria-hidden="true">t</span>
      <span className="l i" aria-hidden="true">ı</span>
      <span className="l c" aria-hidden="true">c</span>
      <span className="l k" aria-hidden="true">k</span>
      <span className="l r" aria-hidden="true">r</span>
      <i className={`tittle ${blink ? "tittle-blink" : ""}`} aria-hidden="true" />
    </span>
  );
}

export function TickrIcon({ size = 34, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`tickr-icon ${className}`} style={{ fontSize: size }} role="img" aria-label="tickr">
      t<i className="tittle" aria-hidden="true" />
    </span>
  );
}

/** The six-swatch bar, fixed order: green, red, orange, yellow, pink, blue. Use sparingly. */
export function SwatchBar({ className = "" }: { className?: string }) {
  return (
    <span className={`swatch-bar ${className}`} aria-hidden="true">
      <i /><i /><i /><i /><i /><i />
    </span>
  );
}
