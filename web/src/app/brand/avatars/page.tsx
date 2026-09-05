/**
 * Ten avatar directions, for capture at 512 and export down.
 *
 * All of them keep the constraints the venues impose: the artwork is a circle because wallets crop to one,
 * transparency is only outside it, and the `t` and tittle carry the identity because the wordmark does not
 * survive a 16px row. What varies is where the colour goes.
 */

const SW = {
  yellow: "var(--tickr-sw-yellow)",
  blue: "var(--tickr-sw-blue)",
  blueType: "var(--tickr-sw-blue-type)",
  green: "var(--tickr-sw-green)",
  orange: "var(--tickr-sw-orange)",
  pink: "var(--tickr-sw-pink)",
  red: "var(--tickr-sw-red)",
  signal: "var(--tickr-signal)",
  ink: "#0B1710",
  paper: "#F4F7F4",
  ground: "var(--bg)",
};

const CONIC =
  `conic-gradient(from -90deg,${SW.yellow} 0deg 60deg,${SW.blue} 60deg 120deg,${SW.green} 120deg 180deg,` +
  `${SW.orange} 180deg 240deg,${SW.pink} 240deg 300deg,${SW.red} 300deg 360deg)`;
const STRIPES = `linear-gradient(90deg,${SW.yellow} 0 16.66%,${SW.blue} 16.66% 33.33%,${SW.green} 33.33% 50%,${SW.orange} 50% 66.66%,${SW.pink} 66.66% 83.33%,${SW.red} 83.33% 100%)`;
const SMOOTH = `conic-gradient(from -90deg,${SW.yellow},${SW.blue},${SW.green},${SW.orange},${SW.pink},${SW.red},${SW.yellow})`;

type V = {
  id: string;
  note: string;
  outer: string; // the rim layer
  face?: string; // the disc inside it; omit for a full-bleed face
  inset?: number;
  letter: string;
  dot: string;
  /** paint the letter with a gradient rather than a flat colour */
  letterFill?: string;
};

const VARIANTS: V[] = [
  { id: "01-swatch-rim", note: "swatch rim, dark face", outer: CONIC, face: SW.ground, inset: 42, letter: SW.paper, dot: SW.signal },
  { id: "02-signal-face", note: "signal face, ink letter", outer: SW.signal, letter: SW.ink, dot: SW.ink },
  { id: "03-conic-face", note: "full swatch face, ink letter", outer: CONIC, letter: SW.ink, dot: SW.ink },
  { id: "04-stripes", note: "swatch stripes, ink letter", outer: STRIPES, letter: SW.ink, dot: SW.ink },
  { id: "05-gradient-letter", note: "dark face, swept letter", outer: SW.ground, letter: "transparent", dot: SW.signal, letterFill: `linear-gradient(150deg,${SW.yellow} 0%,${SW.orange} 34%,${SW.pink} 64%,${SW.blueType} 100%)` },
  { id: "06-paper", note: "paper face, ink letter, swatch rim", outer: CONIC, face: SW.paper, inset: 42, letter: SW.ink, dot: SW.green },
  { id: "07-smooth-rim", note: "smooth swatch rim, dark face", outer: SMOOTH, face: SW.ground, inset: 40, letter: SW.paper, dot: SW.signal },
  { id: "08-two-tone", note: "two-tone face", outer: `linear-gradient(128deg,${SW.blueType} 0 50%,${SW.pink} 50% 100%)`, letter: SW.ink, dot: SW.ink },
  { id: "09-yellow", note: "yellow face, ink letter", outer: SW.yellow, letter: SW.ink, dot: SW.red },
  { id: "10-signal-letter", note: "dark face, signal letter, swatch rim", outer: CONIC, face: SW.ground, inset: 42, letter: SW.signal, dot: SW.paper },
];

export default function Avatars() {
  return (
    <div className="av-wrap">
      <style
        dangerouslySetInnerHTML={{
          __html: [
            `.av-wrap{background:transparent;display:flex;flex-wrap:wrap;gap:40px;padding:40px}`,
            `.av{position:relative;width:512px;height:512px;border-radius:50%;display:grid;place-items:center}`,
            `.av-face{position:absolute;border-radius:50%}`,
            // the lockup is nudged onto its own ink, measured once and reused for every variant
            `.av-lock{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) translate(-41px,17px)}`,
            `.av-t{display:block;font-family:var(--font-serif);font-weight:600;font-size:390px;line-height:1;transform:rotate(-2.5deg)}`,
            `.av-t.grad{background-clip:text;-webkit-background-clip:text;-webkit-text-fill-color:transparent}`,
            `.av-dot{position:absolute;left:74%;top:6%;width:112px;height:112px;border-radius:50%}`,
          ].join(""),
        }}
      />
      {VARIANTS.map((v) => (
        <div key={v.id} className={`av av-${v.id}`} style={{ background: v.outer }}>
          {v.face && <span className="av-face" style={{ inset: v.inset, background: v.face }} />}
          <span className="av-lock">
            <span
              className={`av-t ${v.letterFill ? "grad" : ""}`}
              style={v.letterFill ? { backgroundImage: v.letterFill } : { color: v.letter }}
            >
              t
            </span>
            <span className="av-dot" style={{ background: v.dot }} />
          </span>
        </div>
      ))}
    </div>
  );
}
