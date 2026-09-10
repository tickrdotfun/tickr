/** JSON with bigints: every bigint travels as a tagged string and comes back as a bigint. */
const TAG = "__bigint";
export const serialize = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { [TAG]: x.toString() } : x));
export const deserialize = <T = unknown,>(s: string): T =>
  JSON.parse(s, (_k, x) => (x && typeof x === "object" && typeof (x as Record<string, unknown>)[TAG] === "string" ? BigInt((x as Record<string, string>)[TAG]) : x)) as T;
