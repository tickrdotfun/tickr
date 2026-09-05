import { RainbowRule } from "./RainbowRule";
import { XIcon } from "./XIcon";
import { SOCIALS } from "@/lib/constants";
import { TickerReel } from "./motion/TickerReel";

/** The hero, alone: no header, no footer, and one link, the X account. The reel still runs, because the reel is the pitch. */
export function ComingSoon() {
  return (
    <div className="home soon">
      <section className="hero">
        <div className="hero-main">
          <div className="cascade-1">
            <RainbowRule play />
            <p className="hero-tagline mt-4">
              <span className="text-white font-bold">pair anything</span> on <span className="cap">Robinhood Chain</span>.
            </p>
          </div>

          <h1 className="hero-title cascade-1">
            launch a coin{" "}
            <span className="hero-anchor">
              anchored to <TickerReel />
            </span>
          </h1>

          <div className="cascade-2 hero-sub">
            <p>name a pair. launch into a pool that is locked forever. trade from the first block.</p>
          </div>

          <div className="cascade-3 hero-actions flex flex-wrap items-center justify-center gap-3">
            <span className="btn btn-gradient hero-cta soon-cta" aria-disabled="true">
              coming soon
            </span>
          </div>
          <a className="soon-x cascade-3" href={SOCIALS.x.href} target="_blank" rel="noreferrer" aria-label={`tickr on X, ${SOCIALS.x.handle}`}>
            <XIcon size={18} />
          </a>
        </div>
      </section>
    </div>
  );
}
