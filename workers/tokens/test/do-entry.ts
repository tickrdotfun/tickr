/**
 * A worker whose only job is to put the keeper's Durable Object behind HTTP so it can be exercised for real.
 *
 * Not part of the deployed worker: production reaches the object through a stub, and adding a route to it there
 * would be new public surface for the sake of a test. This entry is referenced only by the test config.
 */
export { PinCounter } from "../src/index";

type Env = { PIN_COUNTER: DurableObjectNamespace };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // the instance name is a parameter so a test can simulate a fresh object, or come back to the same one
    const name = url.searchParams.get("instance") ?? "keeper-lease";
    const stub = env.PIN_COUNTER.get(env.PIN_COUNTER.idFromName(name));
    return stub.fetch(new Request(`https://keeper/keeper${url.search}`, req.method === "POST" ? { method: "POST", body: await req.text() } : undefined));
  },
};
