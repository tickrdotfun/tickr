import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // the Coinbase wallet connector imports optional payment modules that are not installed; a webpack build must
  // treat them as absent rather than fail (Turbopack and the Cloudflare adapter already do)
  // Turbopack builds (Vercel, the Cloudflare adapter, `next dev`) resolve those modules as absent on their own
  turbopack: {},
  webpack(config, { webpack }) {
    config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }));
    return config;
  },
  async rewrites() {
    return [
      // `/docs/lifecycle.md` reads the page's source, which is the shape an agent guesses first.
      { source: "/docs/:slug([^/]+).md", destination: "/docs/:slug/raw" },
    ];
  },
};

export default nextConfig;
