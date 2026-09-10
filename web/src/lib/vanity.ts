import { encodeAbiParameters, getCreate2Address, hexToBytes, bytesToHex, keccak256, encodePacked, type Address, type Hex } from "viem";
import { TOKEN_CREATION_CODE } from "./tokenBytecode";

/** An address that is not set. Kept local so this module has no dependency on the deployment record. */
const isZero = (a: Address) => /^0x0{40}$/i.test(a);

/**
 * Every coin launched from the create page gets an address ending in this. Nothing on chain enforces it: the factory
 * deploys each coin with CREATE2 at `keccak256(initiator ++ TokenParams.salt)`, and the salt is free, so the page
 * simply tries salts until the predicted address ends the right way. No extra gas, no contract change, no RPC call.
 */
export const VANITY_SUFFIX = "6942";

export type TokenCtorArgs = {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: { twitter: string; telegram: string; discord: string; website: string; farcaster: string };
  supply: bigint;
  factory: Address;
};

/** `keccak256(creationCode ++ abi.encode(constructor args))`, the CREATE2 init code hash of one specific coin. */
export function tokenInitCodeHash(a: TokenCtorArgs): Hex {
  const args = encodeAbiParameters(
    [
      { type: "string" },
      { type: "string" },
      { type: "string" },
      { type: "string" },
      { type: "tuple", components: [{ type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }] },
      { type: "uint256" },
      { type: "address" },
    ],
    [a.name, a.symbol, a.logo, a.description, [a.socials.twitter, a.socials.telegram, a.socials.discord, a.socials.website, a.socials.farcaster], a.supply, a.factory],
  );
  return keccak256(encodePacked(["bytes", "bytes"], [TOKEN_CREATION_CODE, args]));
}

/** Mirrors `LaunchDeployer._salt` and OpenZeppelin `Create2.computeAddress`: the address the factory will deploy to. */
export function predictTokenAddress(deployer: Address, initiator: Address, userSalt: Hex, initCodeHash: Hex): Address {
  return getCreate2Address({
    from: deployer,
    salt: keccak256(encodePacked(["address", "bytes32"], [initiator, userSalt])),
    bytecodeHash: initCodeHash,
  });
}

/** The i-th candidate salt for a seed: `keccak256(seed ++ uint256(i))`, so a seed replays to the same salt. */
export function saltAt(seed: Hex, i: number): Hex {
  return keccak256(encodePacked(["bytes32", "uint256"], [seed, BigInt(i)]));
}

export type GrindResult = { salt: Hex; address: Address; tries: number };

const YIELD_EVERY = 4096;
const HARD_CAP = 2_000_000;

/**
 * Finds the first salt whose predicted address ends in `suffix`, and, when `below` is given, also sorts strictly
 * below that address. Deterministic from `seed`. Works on bytes with three keccaks per try and yields to the event
 * loop every few thousand tries so the page stays responsive. A four character suffix takes 65,536 tries on average,
 * well under a second in a browser.
 *
 * What `below` costs depends entirely on where that address sits, not on its first nibble alone. Names are ground to
 * start `0xF`, which spans 0.9375 to 1.0 of the address space, so the extra work is at most 6.7% and falls towards
 * zero the higher the name sits; one measured name, `0xF9d3…`, costs 2.5%. A name low in the space would cost far
 * more, and one near zero is impossible; the search fails with a clear message rather than returning a wrong answer.
 *
 * `below` is for a coin launched against an invented name: the coin must be currency0 of its pool and the name
 * currency1, which `TickerLauncher` enforces by reverting `CoinNotFirst`. Grinding for it here means a creator is
 * never sent a transaction that reverts. It is not passed for other quote types, and must not be: a coin paired with
 * native ETH can never sort below address zero, so requiring it there would grind for ever.
 */
export async function grindSalt(opts: {
  deployer: Address;
  initiator: Address;
  initCodeHash: Hex;
  seed: Hex;
  suffix?: string;
  /** The name this coin will be priced in. The predicted address must sort strictly below it. */
  below?: Address;
  onProgress?: (tries: number) => void;
}): Promise<GrindResult> {
  const suffix = (opts.suffix ?? VANITY_SUFFIX).toLowerCase();
  if (!/^[0-9a-f]+$/.test(suffix) || suffix.length === 0 || suffix.length > 40) throw new Error("bad suffix");
  const want = hexToBytes(`0x${suffix.length % 2 ? "0" + suffix : suffix}`);
  const oddNibble = suffix.length % 2 === 1;
  // compared as bytes, most significant first, so no bigint is needed in the hot loop
  const below = opts.below ? hexToBytes(opts.below) : undefined;
  if (below && below.length !== 20) throw new Error("bad below address");

  // seed ++ uint256(i)
  const saltIn = new Uint8Array(64);
  saltIn.set(hexToBytes(opts.seed), 0);
  // initiator ++ userSalt
  const nsIn = new Uint8Array(52);
  nsIn.set(hexToBytes(opts.initiator), 0);
  // 0xff ++ deployer ++ salt ++ initCodeHash
  const c2 = new Uint8Array(85);
  c2[0] = 0xff;
  c2.set(hexToBytes(opts.deployer), 1);
  c2.set(hexToBytes(opts.initCodeHash), 53);

  for (let i = 0; i < HARD_CAP; i++) {
    // big-endian counter in the low bytes of the second word; earlier bytes stay zero
    let v = i;
    for (let b = 63; b >= 56; b--) {
      saltIn[b] = v & 0xff;
      v = Math.floor(v / 256);
    }
    const userSalt = keccak256(saltIn, "bytes");
    nsIn.set(userSalt, 20);
    c2.set(keccak256(nsIn, "bytes"), 21);
    const h = keccak256(c2, "bytes");
    // the address is the low 20 bytes of the hash; compare its tail to the wanted bytes
    let ok = true;
    for (let k = 0; k < want.length && ok; k++) {
      const hb = h[32 - want.length + k];
      const wb = want[k];
      ok = k === 0 && oddNibble ? (hb & 0x0f) === wb : hb === wb;
    }
    // and, for an invented name, the address has to sort below it as well
    if (ok && below) {
      ok = false;
      for (let k = 0; k < 20; k++) {
        const ab = h[12 + k];
        const bb = below[k];
        if (ab !== bb) {
          ok = ab < bb;
          break;
        }
      }
    }
    if (ok) {
      const address = bytesToHex(h.slice(12)) as Address;
      const salt = bytesToHex(userSalt) as Hex;
      return { salt, address, tries: i + 1 };
    }
    if ((i + 1) % YIELD_EVERY === 0) {
      opts.onProgress?.(i + 1);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  throw new Error(
    opts.below
      ? `no address ending in ${suffix} and sorting below ${opts.below} within ${HARD_CAP.toLocaleString()} tries`
      : `no address ending in ${suffix} within ${HARD_CAP.toLocaleString()} tries`,
  );
}

export function vanityInputs(f: {
  user?: Address;
  supply?: bigint;
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: { twitter: string; telegram: string; discord: string; website: string; farcaster: string };
  seed: Hex;
  /** The invented name this coin is priced in, when it is priced in one. */
  below?: Address;
  /** The deployed addresses this build talks to; passed in so the keying can be tested without the app. */
  addresses: { launchDeployer: Address; factory: Address };
}): { initCodeHash: Hex; initiator: Address; below?: Address; key: string } | undefined {
  const addresses = f.addresses;
  if (!f.user || !f.supply || isZero(addresses.launchDeployer) || isZero(addresses.factory) || !f.name.trim() || !f.symbol.trim()) return undefined;
  const initCodeHash = tokenInitCodeHash({
    name: f.name.trim(),
    symbol: f.symbol.trim(),
    logo: f.logo.trim(),
    description: f.description.trim(),
    socials: { ...f.socials },
    supply: f.supply,
    factory: addresses.factory,
  });
  // the name is part of the key: change what the coin is priced in and the ground address must be thrown away,
  // because an address that sorts below one name need not sort below another
  const below = f.below && !isZero(f.below) ? f.below : undefined;
  return {
    initCodeHash,
    initiator: f.user,
    below,
    key: `${f.seed}:${initCodeHash}:${f.user.toLowerCase()}:${below?.toLowerCase() ?? "none"}`,
  };
}
