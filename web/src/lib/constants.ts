export const DISCLOSURE =
  "Not issued by Robinhood Assets. Not a Stock Token. No mint/redeem against listed shares. An invented ticker is a one-for-one wrapper of USDG: it is worth exactly what it wraps.";

/** The line. Written in full per the naming rules: the network is always "Robinhood Chain", never "Robinhood". */
export const TAGLINE = "pair anything on Robinhood Chain.";

export const ATTRIBUTION =
  "Independent, immutable contracts. Not affiliated with Robinhood.";

export const POLL_MS = 5_000;
export const DEFAULT_SLIPPAGE_BPS = 100; // 1%
export const DEFAULT_QUOTE_SUPPLY = 10n ** 24n; // 1,000,000 QUOTE (18 decimals)

/** What an invented ticker is made of: dollars, one for one. Nothing is minted for free and nobody is handed any. */
export const TICKER_ALLOCATION = [{ label: "backed one-for-one by USDG, mint and redeem any time", bps: 10_000 }] as const;

/** Official accounts. Referenced everywhere rather than retyped, so a handle can only be wrong in one place. */
export const SOCIALS = {
  x: { label: "X", handle: "@tickrdotfun_rh", href: "https://x.com/tickrdotfun_rh" },
} as const;
