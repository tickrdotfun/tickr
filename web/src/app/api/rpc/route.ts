/**
 * The chain, read through the site. The browser posts JSON-RPC here and this forwards it to the endpoint in
 * `RPC_ENDPOINT`, a secret, so the key never reaches a page. Reads only: anything that could sign, spend or
 * change node state is refused, and a write always goes through the visitor's own wallet, never through here.
 *
 * Log queries are the exception. A paid plan caps their block range, so those go to the chain's own public node,
 * which serves wide ranges and is only rate-limited per address; every other read goes to the fast endpoint.
 */
export const dynamic = "force-dynamic";

const PUBLIC_NODE = "https://rpc.mainnet.chain.robinhood.com";
const READS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_getBalance", "eth_getCode", "eth_getStorageAt",
  "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByNumber",
  "eth_getBlockByHash", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
  "eth_getLogs", "eth_createAccessList", "net_version", "web3_clientVersion",
]);
/** wide ranges are the public node's job; the paid plan caps them */
const WIDE = new Set(["eth_getLogs"]);

type Call = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };

export async function POST(req: Request) {
  const upstream = process.env.RPC_ENDPOINT;
  let body: Call | Call[];
  try {
    body = (await req.json()) as Call | Call[];
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > 50) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "too many calls in one request" } }, { status: 400 });
  const refused = calls.find((c) => !c.method || !READS.has(c.method));
  if (refused) {
    return Response.json({ jsonrpc: "2.0", id: refused.id ?? null, error: { code: -32601, message: `${refused.method ?? "that method"} is not available here; this endpoint reads the chain` } }, { status: 400 });
  }
  // a batch that mixes wide and narrow reads goes to the node that can serve all of it
  const wide = calls.some((c) => WIDE.has(c.method as string));
  const target = wide || !upstream ? PUBLIC_NODE : upstream;
  try {
    const r = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    const text = await r.text();
    return new Response(text, { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ jsonrpc: "2.0", id: calls[0]?.id ?? null, error: { code: -32000, message: e instanceof Error ? e.message.slice(0, 160) : "the chain could not be reached" } }, { status: 502 });
  }
}
