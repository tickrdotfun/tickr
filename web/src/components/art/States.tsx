import { FONT, GROUND, HUES, INK, PAPER, RADIUS, STROKE, shade } from "./system";

/** Nothing here yet: an empty tile rack, one colour plus the ground. */
export function EmptyArt({ className = "" }: { className?: string }) {
  const hue = HUES.yellow;
  return (
    <svg viewBox="0 0 240 240" className={className} role="img" aria-label="an empty tile rack">
      <rect width="240" height="240" fill={GROUND} />
      <path d="M-24 206 L264 146 L264 88 L-24 148 Z" fill={hue} />
      <g stroke={INK} strokeWidth={STROKE} strokeLinejoin="round" strokeLinecap="round">
        {/* empty slots: the rack is there, the tiles are not */}
        <rect x="44" y="86" width="46" height="52" rx={RADIUS} fill={GROUND} />
        <rect x="98" y="86" width="46" height="52" rx={RADIUS} fill={GROUND} />
        <rect x="152" y="86" width="46" height="52" rx={RADIUS} fill={GROUND} />
        <path d="M28 138 L212 138 L212 166 L28 166 Z" fill={hue} />
        <path d="M28 166 L212 166 L200 186 L40 186 Z" fill={shade(hue, 0.7)} />
      </g>
    </svg>
  );
}

/** Something broke: a jammed split-flap cell. Red, which is reserved for exactly this. */
export function ErrorArt({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 240" className={className} role="img" aria-label="a jammed split-flap cell">
      <rect width="240" height="240" fill={GROUND} />
      <path d="M-24 210 L264 150 L264 92 L-24 152 Z" fill={HUES.red} opacity="0.55" />
      <g stroke={INK} strokeWidth={STROKE} strokeLinejoin="round" strokeLinecap="round">
        <rect x="62" y="66" width="116" height="120" rx={RADIUS} fill={PAPER} />
        <path d="M62 126 L178 126" strokeWidth={STROKE / 2} />
        <g transform="rotate(-13 120 126)">
          <rect x="62" y="66" width="116" height="60" rx={RADIUS} fill={HUES.red} />
        </g>
        <text
          x="120"
          y="158"
          fill={INK}
          stroke="none"
          fontFamily={FONT}
          fontWeight="700"
          fontSize="40"
          textAnchor="middle"
          dominantBaseline="central"
        >
          ?
        </text>
      </g>
    </svg>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="state-block">
      <EmptyArt className="state-art" />
      <div>
        <h3 className="state-title">{title}</h3>
        <p className="state-body">{body}</p>
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}

export function ErrorState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="state-block">
      <ErrorArt className="state-art" />
      <div>
        <h3 className="state-title">{title}</h3>
        <p className="state-body">{body}</p>
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}
