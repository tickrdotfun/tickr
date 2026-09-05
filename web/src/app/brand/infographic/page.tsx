import { TickrMark, SwatchBar } from "@/components/Mark";
import { SOCIALS } from "@/lib/constants";
import { inkNudge } from "@/lib/optical";

/**
 * The explainer card: 1600x900, for capture, no chrome.
 *
 * The mark leads and the pairs are stickers, not a table. Everything is hand-set the way the logo is: each
 * chip carries its own tilt and its own drop, so the group looks thrown rather than laid out. Half of them
 * are filled so the card has real colour in it at thumbnail size instead of outlines that grey out.
 *
 * One claim: your coin can be priced in anything.
 */

const C = {
  yellow: "var(--tickr-sw-yellow)",
  blue: "var(--tickr-sw-blue-type)",
  orange: "var(--tickr-sw-orange)",
  pink: "var(--tickr-sw-pink)",
  red: "var(--tickr-sw-red)",
  signal: "var(--tickr-signal)",
  white: "var(--tickr-white)",
};

/** label, colour, filled, tilt in degrees, drop in px, size in px. `cap` keeps a symbol's own case. */
const CHIPS: [string, string, boolean, number, number, number, boolean][] = [
  ["ETH", C.blue, true, -6, 0, 40, true],
  ["BANANA", C.pink, true, 4, -16, 44, false],
  ["creampie", C.yellow, true, -3, 10, 40, false],
  ["USDG", C.signal, false, 5, -6, 38, true],
  ["coke", C.orange, true, -7, 14, 40, false],
  ["another coin", C.orange, false, 3, -10, 30, false],
  ["ANUS", C.red, true, 6, 8, 42, false],
  ["NGMI", C.blue, false, -4, -14, 32, false],
  ["a ticker nobody has minted yet", C.white, false, 2, 12, 30, false],
];

function sheet(): string {
  return [
    `.ig{position:relative;width:1600px;height:900px;overflow:hidden;background:var(--bg);padding:46px 68px 110px;display:grid;grid-template-columns:620px minmax(0,1fr);gap:48px;align-items:center}`,

    `.ig-left{display:flex;flex-direction:column;transform:translateY(38px)}`,
    `.ig-swatch{width:168px!important;height:6px;margin-top:44px}`,
    `.ig-mark{margin-bottom:44px}`,
    `.ig-head{font-size:60px;font-weight:700;letter-spacing:-0.04em;line-height:1.02}`,
    `.ig-head em{font-style:normal;color:var(--tickr-signal)}`,

    `.ig-foot{position:absolute;left:68px;right:68px;bottom:44px;display:flex;justify-content:flex-end}`,
    `.ig-handle{font-size:17px;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);white-space:nowrap}`,

    // the scatter: thrown, not laid out
    `.ig-scatter{display:flex;flex-wrap:wrap;align-items:center;align-content:center;justify-content:center;gap:30px 24px}`,
    `.ig-chip{border-radius:999px;font-weight:700;white-space:nowrap;line-height:1}`,
    `.ig-chip span{display:block}`,
    `.ig-chip.fill{color:#0b1710;border:0}`,
    `.ig-chip.out{background:transparent;border:2px solid}`,
  ].join("");
}

export default function Infographic() {
  return (
    <div className="ig">
      <style dangerouslySetInnerHTML={{ __html: sheet() }} />

      <div className="ig-left">
        <div className="ig-mark">
          <TickrMark size={186} />
        </div>
        <h1 className="ig-head">
          price your coin
          <br />
          in <em>anything</em>.
        </h1>
        {/* the swatch sits under the copy, not above the mark: the mark's tittle floats free and any rule
            directly over it reads as something the ball is hanging from */}
        <SwatchBar className="ig-swatch" />
      </div>

      <div className="ig-scatter">
        {CHIPS.map(([label, col, fill, tilt, drop, size, cap]) => (
          <span
            key={label}
            className={`ig-chip ${fill ? "fill" : "out"} ${cap ? "cap" : ""}`}
            style={{
              fontSize: size,
              padding: `${Math.round(size * 0.5)}px ${Math.round(size * 0.85)}px`,
              transform: `rotate(${tilt}deg) translateY(${drop}px)`,
              ...(fill ? { background: col } : { color: col, borderColor: `color-mix(in srgb, ${col} 62%, transparent)` }),
            }}
          >
            <span style={{ transform: `translateY(${inkNudge(label, cap).toFixed(3)}em)` }}>{label}</span>
          </span>
        ))}
      </div>

      <div className="ig-foot">
        <span className="ig-handle">{SOCIALS.x.handle}</span>
      </div>
    </div>
  );
}
