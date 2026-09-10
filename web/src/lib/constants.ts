// Both kinds of invented name are covered, because since the market release they are not worth the same thing.
// A redeemable name holds the dollar it is worth. A fixed-inventory name holds nothing and is worth its market.
export const DISCLOSURE =
  "Not issued by Robinhood Assets. Not a Stock Token. No mint/redeem against listed shares. A name invented on tickr is not the asset it is named after: a redeemable name is worth exactly the USDG it wraps, a fixed-inventory name has no backing and is worth only what its own market says.";

/** The line. Written in full per the naming rules: the network is always "Robinhood Chain", never "Robinhood". */
export const TAGLINE = "pair anything on Robinhood Chain.";

export const ATTRIBUTION =
  "Independent, immutable contracts. Not affiliated with Robinhood.";

export const POLL_MS = 5_000;
export const DEFAULT_SLIPPAGE_BPS = 300; // 3%: a quote on a small coin moves before it lands; 1% failed real buys on launch night
export const DEFAULT_QUOTE_SUPPLY = 10n ** 24n; // 1,000,000 QUOTE (18 decimals)

/** What an invented ticker is made of: dollars, one for one. Nothing is minted for free and nobody is handed any. */
export const TICKER_ALLOCATION = [{ label: "backed one-for-one by USDG, mint and redeem any time", bps: 10_000 }] as const;

/** Official accounts. Referenced everywhere rather than retyped, so a handle can only be wrong in one place. */
export const SOCIALS = {
  x: { label: "X", handle: "@tickrdotfun_rh", href: "https://x.com/tickrdotfun_rh" },
} as const;
