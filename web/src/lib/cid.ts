/**
 * The IPFS name of a file, worked out from its bytes.
 *
 * A CIDv1 over the raw bytes with a sha-256 digest, base32, which is exactly the name a pinning service gives the
 * same bytes. That means the create page can write `ipfs://…` into a coin before anything has been uploaded, and
 * send the bytes only once the launch is on chain: a draft that is never launched costs nothing and pins nothing.
 */
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** `ipfs://bafkrei…` for these bytes, the same string the pinning service will answer with. */
export async function ipfsUriFor(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  // 0x01 CIDv1, 0x55 raw, 0x12 sha2-256, 0x20 its length
  const cid = new Uint8Array(4 + digest.length);
  cid.set([0x01, 0x55, 0x12, 0x20]);
  cid.set(digest, 4);
  return `ipfs://b${base32(cid)}`;
}
