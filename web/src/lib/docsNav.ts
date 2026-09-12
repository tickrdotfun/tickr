/** Navigation for the docs, shared by the server loader and the client sidebar. Keep it free of node imports. */
export type DocEntry = { slug: string; file: string; title: string; blurb: string };
/**
 * `num` and `swatch` are the group's place in the specification and its marker colour. The docs really are
 * an ordered spec, so the index is numbered: the number is information, not decoration.
 */
export type DocGroup = { label: string; num: number; swatch: string; items: DocEntry[] };

export const DOC_GROUPS: DocGroup[] = [
  {
    label: "protocol",
    num: 1,
    swatch: "var(--tickr-sw-yellow)",
    items: [
      { slug: "first-principles", file: "01-first-principles.md", title: "overview", blurb: "no custody, atomic flows, everything readable on chain, immutable per version." },
      { slug: "lifecycle", file: "02-lifecycle.md", title: "what a launch does", blurb: "create, trade, collect. one transaction opens the coin and its locked pool." },
      { slug: "curve-math", file: "03-curve-math.md", title: "price and market cap", blurb: "the locked position as a constant product curve, opening market caps, fees in the math." },
      { slug: "fees", file: "06-fees.md", title: "fees", blurb: "launch fee, the pool fee, creator tax, the 60/10/30 split, collecting, burning, claims." },
      { slug: "liquidity-lock", file: "14-liquidity-lock.md", title: "liquidity lock", blurb: "what the locker holds, what it can do, what it cannot, and how to check it yourself." },
      { slug: "official-coin", file: "13-official-coin.md", title: "the official coins", blurb: "TICKR, priced in FUN, and HOLY, priced in COW: the first launch of each version, on the same rules as every launch." },
      { slug: "risks", file: "09-risks.md", title: "risks", blurb: "what can go wrong, the exact list of owner powers, unaudited status." },
      { slug: "spec", file: "SPEC.md", title: "full specification", blurb: "the build spec, in the order the protocol is best understood." },
    ],
  },
  {
    label: "quote assets",
    num: 2,
    swatch: "var(--tickr-sw-blue-type)",
    items: [
      { slug: "custom-pairs", file: "04-custom-pairs.md", title: "ETH, USDG and Stock Tokens", blurb: "mode 1. the three official quote assets, per-asset economics and the expectedEconomics pin." },
      { slug: "anchors", file: "05-anchors.md", title: "invented tickers", blurb: "a quote asset a creator names, worth one USDG each. inventing one, launching under one, why nobody owns it, the dollar pool and the club that shares its fees." },
      { slug: "coin-quotes", file: "10-coin-quotes.md", title: "tickr coins", blurb: "mode 3. price a launch in a coin this factory already launched, and the guardrails on it." },
      { slug: "market-quotes", file: "19-market-quotes.md", title: "any token with a market", blurb: "mode 5. price a launch in any token on the chain with a deep enough Uniswap v3 pool against WETH or USDG." },
      { slug: "reference-alignment", file: "20-reference-alignment.md", title: "reference versus production", blurb: "what the managed ticker system keeps from the reference that traded, what differs and why, and how each difference is tested." },
      { slug: "stock-quotes", file: "11-stock-quotes.md", title: "Stock Token quotes", blurb: "mode 4. the opening market cap is sized from the asset's live Chainlink feed." },
      { slug: "zap", file: "12-zap.md", title: "buying with ETH", blurb: "any coin, one transaction, paid in ETH, whatever it is quoted in." },
    ],
  },
  {
    label: "integration",
    num: 3,
    swatch: "var(--tickr-sw-orange)",
    items: [
      { slug: "addresses", file: "07-addresses.md", title: "addresses", blurb: "chain facts, canonical Uniswap addresses, the contract table." },
      { slug: "launching-from-code", file: "15-launching-from-code.md", title: "launching from code", blurb: "the pinned preview, every quote asset, knowing the address first, metadata." },
      { slug: "trading-from-code", file: "16-trading-from-code.md", title: "trading from code", blurb: "one pool, routing from ETH, collecting fees and claiming." },
      { slug: "reading-state", file: "17-reading-state.md", title: "reading state", blurb: "the launch record, pool key and price via extsload, fees owed, ticker views, the site's endpoints." },
      { slug: "events-and-errors", file: "18-events-and-errors.md", title: "events and errors", blurb: "the full event list, every named error and what to do about it." },
    ],
  },
];

export const ALL_DOCS: DocEntry[] = DOC_GROUPS.flatMap((g) => g.items);


/** `1.4` for the fourth page of group one. Used by the index and by each page's own header. */
export function docNumber(slug: string): string {
  for (const g of DOC_GROUPS) {
    const i = g.items.findIndex((d) => d.slug === slug);
    if (i >= 0) return `${g.num}.${i + 1}`;
  }
  return "0";
}
