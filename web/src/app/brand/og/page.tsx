import { TickrMark } from "@/components/Mark";

export const metadata = { title: "share card · tickr" };

/**
 * The link preview, authored at its real size (1200x630) so a screenshot of `.og-card` is the asset that ships
 * as /opengraph-image.png. Same sky and lockup as the X header, recomposed for 1.91:1: the mark larger, the
 * planet pulled in, and the constellation over the mark's shoulder where a preview crop keeps it.
 */
export default function OgPage() {
  return (
    <div>
      <h1 className="section-h">share card</h1>
      <p className="text-muted mt-3 max-w-[60ch]">
        1200 by 630, authored at size. this is what a link to the site shows on x, chat previews, imessage
        and slack. screenshot the frame below at 2x.
      </p>

      <div className="og-scale mt-8">
        <div className="og-card">
          <svg className="og-art" viewBox="0 0 1200 630" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke">
              {/* a ringed planet, right */}
              <g transform="translate(1010 250)">
                <circle r="104" />
                <circle r="56" opacity="0.5" />
                <ellipse rx="182" ry="44" transform="rotate(-18)" />
                <ellipse rx="212" ry="52" transform="rotate(-18)" opacity="0.45" />
              </g>
              {/* orbits, lower left */}
              <g transform="translate(120 560)">
                <circle r="76" opacity="0.5" />
                <circle r="148" opacity="0.32" />
                <circle r="224" opacity="0.2" />
                <circle r="5" cx="148" cy="-8" fill="currentColor" stroke="none" />
              </g>
              {/* a constellation over the mark's shoulder */}
              <path d="M330 120 L416 156 L496 124 L566 174" opacity="0.4" />
              <path d="M416 156 L448 224" opacity="0.28" />
              {[
                [330, 120],
                [416, 156],
                [496, 124],
                [566, 174],
                [448, 224],
              ].map(([cx, cy]) => (
                <circle key={`${cx}`} cx={cx} cy={cy} r="2.8" fill="currentColor" stroke="none" />
              ))}
              {/* the horizon */}
              <path d="M-40 480 C 300 400, 800 400, 1240 500" opacity="0.2" />
              <path d="M-40 70 C 260 0, 620 0, 900 76" opacity="0.14" />
            </g>
          </svg>

          <div className="og-lockup">
            <TickrMark size={148} />
            <p className="og-tag">
              pair anything on <span className="cap">Robinhood Chain</span>.
            </p>
          </div>

          <span className="swatch-bar og-swatch" aria-hidden="true">
            <i /><i /><i /><i /><i /><i />
          </span>
        </div>
      </div>
    </div>
  );
}
