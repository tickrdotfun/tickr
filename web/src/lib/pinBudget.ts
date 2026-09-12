/**
 * The decision on a paid upload, taken from the shared budget in the tokens Worker.
 *
 * Pinning costs money, and the only bound on the total is the Worker's shared counters. So when they cannot be
 * asked, or answer something that is not an answer, the upload is refused, never counted locally and let through:
 * a per-instance counter has no global total, and many instances or many addresses would add up past any budget.
 * A refusal costs a creator nothing, because the create page then stores the image with the coin instead.
 *
 * The one exception is a development server with no Worker configured at all, which counts on its own so uploads
 * can be tried locally. A deployment never takes that path: it is decided at the route by NODE_ENV.
 */
export type BudgetAnswer = { allowed: boolean; by?: string };
export type BudgetDecision = { over: boolean; by: string; unavailable?: true };

export function decideBudget(answer: unknown, local: { allowed: boolean; over: () => boolean }): BudgetDecision {
  if (answer === undefined) {
    if (local.allowed) return { over: local.over(), by: "local" };
    return { over: true, by: "unavailable", unavailable: true };
  }
  if (!answer || typeof answer !== "object" || typeof (answer as BudgetAnswer).allowed !== "boolean") return { over: true, by: "malformed", unavailable: true };
  const b = answer as BudgetAnswer;
  return { over: b.allowed !== true, by: typeof b.by === "string" ? b.by : "shared" };
}

/** How long the Worker gets to answer before the question counts as unanswered. */
export const BUDGET_TIMEOUT_MS = 3_000;

/** One request to the Worker: its JSON, or `undefined` when it is not configured, fails, is slow, or is not ok. */
export async function askWorker<T>(base: string | undefined, key: string | undefined, path: string, body?: unknown, fetchImpl: typeof fetch = fetch, timeoutMs = BUDGET_TIMEOUT_MS): Promise<T | undefined> {
  if (!base || !key) return undefined;
  try {
    const r = await fetchImpl(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-budget-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return undefined;
    return (await r.json()) as T;
  } catch {
    return undefined;
  }
}
