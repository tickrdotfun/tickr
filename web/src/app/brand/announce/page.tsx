import { TickrMark, SwatchBar } from "@/components/Mark";


/**
 * The launch announcement card: 1600x900, for capture, no chrome.
 *
 * It loops seamlessly rather than building in, because a card in a feed is looked at twice and a build that
 * restarts every few seconds reads as a stutter. The only motion is the orbit: the ring turns exactly once
 * per loop, so the last frame is the first frame. Each ticker counter-rotates inside it so the words stay
 * upright the whole way round, which is the difference between an orbit and a spinning wheel.
 *
 * The tickers orbit the mark because that is the product: everything pairs to tickr.
 */

const LOOP = 6; // seconds; one full turn
const R = 214; // orbit radius
const RING = ["PIZZA", "NGMI", "MOON", "FUD", "ANUS", "BAG", "PUMP", "GPT", "ZERO", "NFT"];
const SW = [
  "var(--tickr-sw-yellow)",
  "var(--tickr-sw-blue-type)",
  "var(--tickr-sw-orange)",
  "var(--tickr-sw-pink)",
  "var(--tickr-sw-red)",
  "var(--tickr-signal)",
];

function sheet(): string {
  return [
    `.an{position:relative;width:1600px;height:900px;overflow:hidden;background:var(--bg);display:flex;flex-direction:column;align-items:center}`,
    `.an-top{margin-top:52px;display:flex;flex-direction:column;align-items:center;gap:14px}`,
    `.an-kick{font-size:15px;letter-spacing:0.22em;text-transform:uppercase;color:var(--muted)}`,
    `.an-swatch{width:150px!important;height:5px}`,
    `.an-head{margin-top:30px;font-size:46px;font-weight:700;letter-spacing:-0.03em;text-align:center}`,
    `.an-head .go{color:var(--tickr-signal)}`,

    `.an-stage{position:relative;width:${R * 2 + 120}px;height:${R * 2 + 120}px;margin-top:2px;display:grid;place-items:center}`,
    `.an-ring{position:absolute;inset:0;animation:an-spin ${LOOP}s linear infinite}`,
    `@keyframes an-spin{to{transform:rotate(360deg)}}`,
    `@keyframes an-unspin{to{transform:rotate(-360deg)}}`,
    `.an-slot{position:absolute;left:50%;top:50%;width:0;height:0}`,
    // the pill counter-turns at the same rate, so the word never goes upside down
    `.an-spin-back{animation:an-unspin ${LOOP}s linear infinite}`,
    `.an-pill{display:grid;place-items:center;width:98px;height:98px;margin:-49px;border-radius:999px;border:1px solid var(--border);background:#0c1811;font-size:17px;font-weight:700;letter-spacing:-0.01em}`,
    `.an-core{position:relative;z-index:2;display:grid;place-items:center}`,
    // a ground disc under the mark so an orbiting pill never crosses it
    `.an-core::before{content:"";position:absolute;width:300px;height:300px;border-radius:50%;background:var(--bg)}`,
    `.an-core>*{position:relative;transform:translateY(22px)}`,

    `.an-foot{position:absolute;left:0;right:0;bottom:56px;display:flex;flex-direction:column;align-items:center;gap:16px}`,
    `.an-live{font-size:26px;color:var(--muted);display:flex;align-items:center;gap:12px}`,
    `.an-dot{width:9px;height:9px;border-radius:50%;background:var(--tickr-signal)}`,
    `.an-live b{color:var(--tickr-signal);font-weight:600}`,
    `.an-handle{font-size:15px;letter-spacing:0.14em;text-transform:uppercase;color:var(--dim)}`,
  ].join("");
}

export default function Announce() {
  return (
    <div className="an">
      <style dangerouslySetInnerHTML={{ __html: sheet() }} />

      <div className="an-top">
        <SwatchBar className="an-swatch" />
        <div className="an-kick">
          <span className="cap">Robinhood Chain</span> · 4663
        </div>
      </div>

      <h1 className="an-head">
        tickr is now <span className="go">live</span> on <span className="cap">Robinhood Chain</span>
      </h1>

      <div className="an-stage">
        <div className="an-ring">
          {RING.map((w, i) => {
            const a = (360 / RING.length) * i;
            return (
              <div key={w} className="an-slot" style={{ transform: `rotate(${a}deg) translateY(-${R}px)` }}>
                <div style={{ transform: `rotate(${-a}deg)` }}>
                  <div className="an-spin-back">
                    <div className="an-pill" style={{ color: SW[i % SW.length], borderColor: `color-mix(in srgb, ${SW[i % SW.length]} 42%, transparent)` }}>
                      {w}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="an-core">
          <TickrMark size={132} />
        </div>
      </div>

      <div className="an-foot">
        <div className="an-live">
          <span className="an-dot" />
          {/* one flex item, not four: a bare text node between elements becomes its own item and picks up
              the row gap, which was opening a space before the capitalised name and before the full stop */}
          <span>
            <b>live now:</b> pair anything on <span className="cap">Robinhood Chain</span>.
          </span>
        </div>
        <div className="an-handle">tickrfun.gg</div>
      </div>
    </div>
  );
}
