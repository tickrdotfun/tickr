import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** The PoolManager storage slot holding slot0 of the canonical ETH/USDG pool (fee 100, spacing 1, no hook). */
export function ethUsdgSlot0Slot(usdg: Address): Hex {
  const poolId = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [ZERO, usdg, 100, 1, ZERO],
    ),
  );
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n]));
}
