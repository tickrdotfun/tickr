import { encodeAbiParameters, getCreate2Address, hexToBytes, bytesToHex, keccak256, encodePacked, type Address, type Hex } from "viem";
import { TOKEN_CREATION_CODE } from "./tokenBytecode";

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
 * Finds the first salt whose predicted address ends in `suffix`. Deterministic from `seed`. Works on bytes with three
 * keccaks per try and yields to the event loop every few thousand tries so the page stays responsive. A four character
 * suffix takes 65,536 tries on average, well under a second in a browser.
 */
export async function grindSalt(opts: {
  deployer: Address;
  initiator: Address;
  initCodeHash: Hex;
  seed: Hex;
  suffix?: string;
  onProgress?: (tries: number) => void;
}): Promise<GrindResult> {
  const suffix = (opts.suffix ?? VANITY_SUFFIX).toLowerCase();
  if (!/^[0-9a-f]+$/.test(suffix) || suffix.length === 0 || suffix.length > 40) throw new Error("bad suffix");
  const want = hexToBytes(`0x${suffix.length % 2 ? "0" + suffix : suffix}`);
  const oddNibble = suffix.length % 2 === 1;

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
  throw new Error(`no address ending in ${suffix} within ${HARD_CAP.toLocaleString()} tries`);
}
