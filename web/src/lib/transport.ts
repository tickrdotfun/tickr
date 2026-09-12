import { custom, http, type Transport } from "viem";
import { robinhoodChain } from "./chain";

/**
 * How the browser reaches the chain. Two nodes, chosen per call:
 *
 * - The site's own `/api/rpc` for everything small and frequent. It holds a fast node's key server-side, answers
 *   bursts, and is what makes a page paint quickly.
 * - The chain's public node, directly from the visitor's browser, for log queries. A paid plan caps their block
 *   range, and sending every visitor's scans through the site would put them all behind one address and its rate
 *   limit; from the visitor's own connection each has its own.
 *
 * A build that names a node (a devnet, a rehearsal, a script) uses that one for everything.
 */
const PUBLIC_NODE = "https://rpc.mainnet.chain.robinhood.com";
const SITE = "/api/rpc";
const WIDE = new Set(["eth_getLogs"]);

export function siteTransport(): Transport {
  const named = process.env.NEXT_PUBLIC_RPC_URL;
  const onServer = typeof window === "undefined";
  // on the server there is no site origin to post to, and a named node is used as given
  if (onServer || (named && named !== SITE)) return http(named && named !== SITE ? named : PUBLIC_NODE, { batch: true });
  const viaSite = http(SITE, { batch: true });
  const direct = http(PUBLIC_NODE, { batch: true });
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const req = { method, params } as Parameters<ReturnType<typeof viaSite>["request"]>[0];
      if (!WIDE.has(method)) return viaSite({ chain: robinhoodChain, retryCount: 1 }).request(req);
      // a log query goes to the public node first, from the visitor's own connection. That node answers some
      // browsers and refuses others (CORS), and rate-limits everyone under load: when it fails, the same query goes
      // through the site, which tries the public node from its side and then its own node. A scan that fails
      // twice is a scan that fails; it must never be the reason a launch is missing from the list
      try {
        return await direct({ chain: robinhoodChain, retryCount: 0 }).request(req);
      } catch {
        return viaSite({ chain: robinhoodChain, retryCount: 1 }).request(req);
      }
    },
  });
}
