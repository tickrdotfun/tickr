import { isAddress, verifyMessage, type Address, type Hex } from "viem";

/**
 * Who may upload an image through tickr's pinning key: a wallet that signed for it. The signature is free, moves
 * nothing, covers one browser for an hour, and names the wallet, the chain and the expiry, so it cannot be replayed
 * elsewhere or later. The server also asks the chain that the wallet holds a little ETH, so a script has to fund
 * every address it wants to upload from. A creator who declines, or has no wallet connected, is never stopped: the
 * create page stores the image with the coin instead.
 */
export const UPLOAD_AUTH_TTL_MS = 60 * 60_000;
export type UploadAuth = { address: Address; until: number; signature: Hex };

/** The text the wallet shows. Plain words first, then the facts the server checks. */
export function uploadMessage(address: Address, chainId: number, until: number): string {
  return [
    "tickr image uploads",
    "",
    "this signature lets this browser upload coin images through tickr for one hour. it costs nothing and moves nothing.",
    "",
    `wallet: ${address.toLowerCase()}`,
    `chain: ${chainId}`,
    `valid until: ${new Date(until).toISOString()}`,
  ].join("\n");
}

export function encodeUploadAuth(a: UploadAuth): string {
  return btoa(JSON.stringify(a));
}

export function decodeUploadAuth(header: string | null | undefined): UploadAuth | undefined {
  if (!header) return undefined;
  try {
    const o = JSON.parse(atob(header)) as { address?: unknown; until?: unknown; signature?: unknown };
    if (typeof o.address === "string" && isAddress(o.address) && typeof o.until === "number" && Number.isFinite(o.until) && typeof o.signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(o.signature)) {
      return { address: o.address, until: o.until, signature: o.signature as Hex };
    }
  } catch {
    // not ours
  }
  return undefined;
}

export type UploadAuthVerdict = "ok" | "expired" | "too-long" | "bad-signature";

/** The signature and the clock. `now` is a parameter so the cases can be tested at fixed times. */
export async function verifyUploadAuth(a: UploadAuth, chainId: number, now = Date.now()): Promise<UploadAuthVerdict> {
  if (a.until <= now) return "expired";
  if (a.until - now > UPLOAD_AUTH_TTL_MS + 5 * 60_000) return "too-long";
  let ok = false;
  try {
    ok = await verifyMessage({ address: a.address, message: uploadMessage(a.address, chainId, a.until), signature: a.signature });
  } catch {
    ok = false;
  }
  return ok ? "ok" : "bad-signature";
}
