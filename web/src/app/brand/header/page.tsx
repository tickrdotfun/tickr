import { TickrMark } from "@/components/Mark";

export const metadata = { title: "x header · tickr" };

/**
 * The X header, authored at its real size (1500x500) so a screenshot of `.x-header` is the asset.
 *
 * Two things constrain the composition. The avatar sits over the lower left, and on narrow screens X crops the
 * sides hard, so the lockup sits centred and clear of both. The art is the same hairline sky as the site.
 */
export default function XHeaderPage() {
  return (
    <div>
      <h1 className="section-h">x header</h1>
      <p className="text-muted mt-3 max-w-[60ch]">
        1500 by 500, authored at size. the shaded corner is where the avatar sits, and the dashed inset is what
        survives cropping on a phone. screenshot the frame below.
      </p>

      <div className="x-header-scale mt-8">
        <div className="x-header">
          <svg className="x-header-art" viewBox="0 0 1500 500" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke">
              {/* a ringed planet, right */}
              <g transform="translate(1268 232)">
                <circle r="96" />
                <circle r="52" opacity="0.5" />
                <ellipse rx="168" ry="40" transform="rotate(-18)" />
                <ellipse rx="196" ry="47" transform="rotate(-18)" opacity="0.45" />
              </g>
              {/* orbits, left, behind the avatar corner */}
              <g transform="translate(120 430)">
                <circle r="70" opacity="0.5" />
                <circle r="136" opacity="0.32" />
                <circle r="206" opacity="0.2" />
                <circle r="5" cx="136" cy="-8" fill="currentColor" stroke="none" />
              </g>
              {/* a constellation between them */}
              <path d="M470 104 L556 140 L636 108 L706 158" opacity="0.4" />
              <path d="M556 140 L588 208" opacity="0.28" />
              {[
                [470, 104],
                [556, 140],
                [636, 108],
                [706, 158],
                [588, 208],
              ].map(([cx, cy]) => (
                <circle key={`${cx}`} cx={cx} cy={cy} r="2.8" fill="currentColor" stroke="none" />
              ))}
              {/* the horizon */}
              <path d="M-40 372 C 380 300, 900 300, 1560 392" opacity="0.2" />
              <path d="M-40 60 C 300 -10, 700 -10, 1040 66" opacity="0.14" />
            </g>
          </svg>

          <div className="x-header-lockup">
            <TickrMark size={104} />
            <p className="x-header-tag">
              pair anything on <span className="cap">Robinhood Chain</span>.
            </p>
          </div>

          <span className="swatch-bar x-header-swatch" aria-hidden="true">
            <i /><i /><i /><i /><i /><i />
          </span>
        </div>
      </div>
    </div>
  );
}
