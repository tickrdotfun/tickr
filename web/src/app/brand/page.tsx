import { SplitFlapBoard } from "@/components/art/SplitFlapBoard";
import { SocialCard } from "@/components/art/SocialCard";
import { TickerObject } from "@/components/art/TickerObject";
import { EmptyArt, ErrorArt } from "@/components/art/States";
import { TickerCycleProvider } from "@/components/motion/TickerCycle";

/**
 * One hue per state, from `branding3/ILLUSTRATION.md` §6. Colour is a label here, not decoration: a live pool
 * rides the card edge, quote kind sits in the right pill, and red means only "this failed".
 */
const STATE_HUES = {
  live: "#3DDC84",
  "creator-issued": "#F4B8C6",
  "stock-token": "#F0862A",
  eth: "#5B78F0",
  usdg: "#F4F7F4",
  failed: "#E23B2E",
} as const;

export const metadata = { title: "illustration system · tickr" };

const OBJECT_SAMPLES = ["BANANA", "PIZZA", "COPE", "KETCHUP", "MOON", "JEET", "INU", "RELISH"];

export default function BrandPage() {
  return (
    <div>
      <h1 className="section-h">illustration system</h1>
      <p className="text-muted mt-3 max-w-[60ch]">
        flat vector, thick outlines, mundane objects that make letters physical. the written rules live in{" "}
        <span className="num">branding3/ILLUSTRATION.md</span>. this page is the art itself, so a change to the
        system shows up here first.
      </p>

      <h2 className="section-title mt-12 mb-4">colour carries state</h2>
      <div className="brand-swatches">
        {Object.entries(STATE_HUES).map(([name, hex]) => (
          <div key={name} className="brand-swatch">
            <span className="brand-chip" style={{ background: hex }} />
            <span className="brand-swatch-k">{name.replace(/-/g, " ")}</span>
            <span className="brand-swatch-v num">{hex}</span>
          </div>
        ))}
      </div>

      <h2 className="section-title mt-12 mb-4">split-flap, for marketing art</h2>
      <div className="brand-hero">
        <TickerCycleProvider words={["PIZZA", "BANANA", "COPE", "JEET"]}>
          <SplitFlapBoard />
        </TickerCycleProvider>
      </div>

      <h2 className="section-title mt-12 mb-4">launch art: one block, coloured from the ticker</h2>
      <div className="brand-objects">
        {OBJECT_SAMPLES.map((t) => (
          <figure key={t}>
            <TickerObject ticker={t} className="brand-object" />
            <figcaption className="num">{t}</figcaption>
          </figure>
        ))}
      </div>

      <h2 className="section-title mt-12 mb-4">empty and error</h2>
      <div className="brand-objects">
        <figure>
          <EmptyArt className="brand-object" />
          <figcaption>empty</figcaption>
        </figure>
        <figure>
          <ErrorArt className="brand-object" />
          <figcaption>error</figcaption>
        </figure>
      </div>

      <h2 className="section-title mt-12 mb-4">social template</h2>
      <div className="social-scale">
        <SocialCard eyebrow="new" headline="pair anything on Robinhood Chain." ticker="BANANA" />
      </div>
      <div className="social-scale mt-6">
        <SocialCard eyebrow="shipped" headline="buy any coin with eth, in one transaction." ticker="PIZZA" />
      </div>
    </div>
  );
}
