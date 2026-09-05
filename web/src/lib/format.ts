import { formatUnits, parseUnits } from "viem";

export function shortAddr(a?: string, n = 4): string {
  if (!a) return "";
  return `${a.slice(0, 2 + n)}…${a.slice(-n)}`;
}

/** Format a base-unit amount with its decimals, trimmed to a sensible number of significant digits. */
export function fmtAmount(value: bigint | undefined, decimals: number, opts?: { sig?: number; max?: number }): string {
  if (value === undefined) return "-";
  const s = formatUnits(value, decimals);
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return fmtNumber(n, opts);
}

export function fmtNumber(n: number, opts?: { sig?: number; max?: number }): string {
  const sig = opts?.sig ?? 5;
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 }) + "B";
  if (abs >= 1e6) return (n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 }) + "M";
  if (abs >= 1e3) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: opts?.max ?? 4 });
  // small numbers: keep `sig` significant digits, no exponent
  const digits = Math.min(20, Math.ceil(-Math.log10(abs)) + sig - 1);
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

/** Price display: leading zeros compressed as 0.0₅123 for very small values. */
export function fmtPrice(n: number | undefined, maxSig = 5): string {
  if (n === undefined || !Number.isFinite(n)) return "-";
  if (n === 0) return "0";
  if (n >= 0.001) return fmtNumber(n, { sig: maxSig, max: 6 });
  const s = n.toExponential(maxSig - 1); // d.ddddde-N
  const [mant, expStr] = s.split("e");
  const exp = -Number(expStr);
  const digits = mant.replace(".", "").replace(/0+$/, "");
  const zeros = exp - 1;
  const sub = String(zeros).replace(/\d/g, (c) => "₀₁₂₃₄₅₆₇₈₉"[Number(c)]);
  return `0.0${sub}${digits}`;
}

export function pct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(digits)}%`;
}

export function bpsToPct(bps: bigint | number, digits = 2): string {
  return `${(Number(bps) / 100).toFixed(digits)}%`;
}

export function safeParseUnits(v: string, decimals: number): bigint | undefined {
  const t = v.trim();
  if (!t || !/^\d*\.?\d*$/.test(t) || t === ".") return undefined;
  try {
    return parseUnits(t, decimals);
  } catch {
    return undefined;
  }
}

export function timeAgo(tsSeconds: number | bigint): string {
  const t = Number(tsSeconds);
  if (!t) return "never";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - t);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function errorMessage(e: unknown): string {
  if (!e) return "";
  const err = e as { shortMessage?: string; message?: string; cause?: { shortMessage?: string; message?: string } };
  return err.shortMessage ?? err.cause?.shortMessage ?? err.message ?? String(e);
}

/** Compact dollars: $1.2k, $3.4m. Small amounts keep cents so a quiet market does not read as zero. */
export function fmtUsd(n?: number): string {
  if (n === undefined || !isFinite(n)) return "-";
  if (n === 0) return "$0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}b`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}m`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

export type FeeSplit = { creatorShareBps: number; clubShareBps: number; protocolShareBps: number };

/** "1.00% · 60% creator / 10% ticker club / 30% protocol", from the launch's own policy rather than a hardcoded string. */
export function feeSplitLabel(feeBps?: bigint | number, split?: FeeSplit): string {
  if (feeBps === undefined) return "-";
  const fee = bpsToPct(feeBps);
  if (!split) return fee;
  return `${fee} · ${splitLabel(split)}`;
}

/** "60% creator / 10% ticker club / 30% protocol"; the club line disappears where the pair has no club. */
export function splitLabel(split: FeeSplit): string {
  const pctOf = (bps: number) => `${Math.round(bps / 100)}%`;
  const parts = [`${pctOf(split.creatorShareBps)} creator`];
  if (split.clubShareBps > 0) parts.push(`${pctOf(split.clubShareBps)} ticker club`);
  parts.push(`${pctOf(split.protocolShareBps)} protocol`);
  return parts.join(" / ");
}
