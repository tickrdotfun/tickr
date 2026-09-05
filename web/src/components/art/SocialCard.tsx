import { TickerObject } from "./TickerObject";

/**
 * One template for every post: eyebrow pill, then a large plain white headline on the left, illustration on the
 * right. Rendered at 1200x630 and scaled down for preview, so a screenshot of `.social-card` is the asset.
 */
export function SocialCard({
  eyebrow,
  headline,
  ticker = "BANANA",
}: {
  eyebrow: string;
  headline: string;
  ticker?: string;
}) {
  return (
    <div className="social-card">
      <div className="social-left">
        <span className="social-eyebrow">{eyebrow}</span>
        <h2 className="social-headline">{headline}</h2>
      </div>
      <div className="social-right">
        <TickerObject ticker={ticker} className="social-art" />
      </div>
    </div>
  );
}
