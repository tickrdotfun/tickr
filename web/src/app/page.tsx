import Link from "next/link";
import { HowItWorks } from "@/components/HowItWorks";
import { LaunchList } from "@/components/LaunchList";
import { StatsRow } from "@/components/StatsRow";
import { RainbowRule, SectionHead } from "@/components/RainbowRule";
import { TickerReel } from "@/components/motion/TickerReel";

export default function Home() {
  return (
    <div className="home">
      <section className="hero">
        <div className="hero-main">
          <div className="cascade-1">
            <RainbowRule play />
            <p className="hero-tagline mt-4">
              <span className="font-bold">pair anything</span> on <span className="cap">Robinhood Chain</span>.
            </p>
          </div>

          <h1 className="hero-title cascade-1">
            launch a coin{" "}
            {/* the ticker never leaves the words it belongs to, however the line wraps */}
            <span className="hero-anchor">
              anchored to <TickerReel />
            </span>
          </h1>

          <div className="cascade-3 hero-actions flex flex-wrap items-center justify-center gap-3">
            <Link href="/create" className="btn btn-gradient hero-cta no-underline hover:no-underline">
              launch
            </Link>
          </div>
        </div>
      </section>

      <HowItWorks />
      <StatsRow />

      <section id="launches" className="cascade-data scroll-mt-24 mt-24">
        <SectionHead title="live launches" />
        <div className="mt-8">
          <LaunchList />
        </div>
      </section>
    </div>
  );
}
