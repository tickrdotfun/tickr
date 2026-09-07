import type { Client } from "viem";

/**
 * Reads logs over a range the public RPC may refuse whole: one read first, then a refused range is split in two
 * and each half tried again, a few levels deep. A range still refused at the bottom leaves a hole, reported as
 * `partial` rather than shown as nothing. Block numbers are not a measure of size on this chain, so the split
 * follows the RPC's answer and never a fixed span.
 */
export async function adaptiveLogs<T>(
  read: (from: bigint, to: bigint) => Promise<T[]>,
  from: bigint,
  to: bigint,
  maxDepth = 6,
): Promise<{ logs: T[]; partial: boolean }> {
  let partial = false;
  const go = async (a: bigint, b: bigint, depth: number): Promise<T[]> => {
    try {
      return await read(a, b);
    } catch {
      if (depth >= maxDepth || a >= b) {
        partial = true;
        return [];
      }
      const mid = a + (b - a) / 2n;
      const [x, y] = await Promise.all([go(a, mid, depth + 1), go(mid + 1n, b, depth + 1)]);
      return [...x, ...y];
    }
  };
  const logs = from > to ? [] : await go(from, to, 0);
  return { logs, partial };
}

export type PublicClient = Client;
