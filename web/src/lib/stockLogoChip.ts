/**
 * The vendored issuer marks under `public/logos/stock` come two ways: most are dark or coloured glyphs (which read
 * on a light chip), and these are light glyphs on a transparent ground, which would disappear on one. Measured from
 * the files themselves: transparent ground plus mean glyph luminance above 190.
 */
export const DARK_CHIP_TICKERS: ReadonlySet<string> = new Set([
  "AMZN", "ANET", "APP", "AVAV", "AXON", "BA", "BB", "CEG", "CLSK", "ELF", "FLNC", "HIMS", "IBM", "IREN", "JBL", "JOBY", "KSS", "LMT", "MRVL", "ON", "PR", "QQQ", "RBLX", "RGTI", "RUN", "SLS", "SMCI", "SMH", "UNH", "ZM",
]);
