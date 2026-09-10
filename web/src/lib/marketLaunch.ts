import { parseAbi, type Abi, type Address, type Hex } from "viem";
import { ADDRESSES, isZero, sameAddr } from "./addresses";

/**
 * Launching a coin priced in a fixed-inventory name.
 *
 * Two things make this different from a launch under a wrapper, and both have to be settled before the wallet
 * opens, not after:
 *
 *  - **Ordering.** The coin has to sort below the name, so it is currency0 of its own pool. The launcher checks
 *    it and reverts otherwise, which costs a launch fee to discover. So the address is ground for in advance,
 *    against the name's address, which for a name that does not exist yet has to be predicted first.
 *  - **Disclosure.** What leaves the wallet is the launch fee, and the first buy if one is made. Neither is
 *    guessed here: the fee is read from the factory and the buy is what the creator asked for.
 *
 * Nothing in this file sends anything. It works out what the launch will be, and says what it costs.
 */

export const LAUNCHER_ABI = parseAbi([
  "function predictName(bytes32 salt, string symbol, uint8 decimals) view returns (address)",
  "function previewEconomics(uint256 launchConfigId, address name) view returns (bytes32)",
  "function economics() view returns ((uint256 phantomQuote,uint8 decimals))",
  "function requiredDecimals() view returns (uint8)",
  "function launch((string name,string symbol,string logo,string description,(string telegram,string twitter,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params, uint256 launchConfigId, address name_) payable returns (address token, bytes32 poolId)",
  "function createAndLaunch(bytes32 nameSalt, string symbol, uint8 decimals, (string name,string symbol,string logo,string description,(string telegram,string twitter,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params, uint256 launchConfigId) payable returns (address name, address token, bytes32 poolId)",
]);

export const isMarketLaunchWired = () => !isZero(ADDRESSES.marketTickerLauncher) && !isZero(ADDRESSES.marketTickerDeployer);

/**
 * A name to launch against: one that exists, or one this launch will make.
 *
 * A new name carries no decimals of its own choosing. The market opens at parity in raw units and the economics
 * are the counter's, so the two only agree while the decimals match; the launcher refuses anything else. The
 * decimals are therefore read from the launcher rather than offered as a field.
 */
export type NameChoice = { kind: "existing"; address: Address } | { kind: "new"; salt: Hex; symbol: string };

export type LaunchReads = {
  predictName(salt: Hex, symbol: string, decimals: number): Promise<Address>;
  previewEconomics(launchConfigId: number, name: Address): Promise<Hex>;
  launchFee(): Promise<bigint>;
  /** The counter's decimals, which every name must carry. Read, never assumed. */
  requiredDecimals(): Promise<number>;
};

export type LaunchPlan = {
  /** The name the coin will be priced in, whether or not it exists yet. */
  name: Address;
  /** True when this launch creates the name as well as the coin. */
  createsName: boolean;
  /** The coin's address must sort strictly below this. The grinder takes it as its `below`. */
  mustSortBelow: Address;
  /** What the factory will check the launch against. */
  expectedEconomics: Hex;
  /** Every amount that leaves the wallet, named. */
  costs: { label: string; amount: bigint; asset: "ETH" }[];
  /** The decimals the name carries, which is the counter's and nothing else. */
  decimals: number;
};

export class MarketLaunchUnavailable extends Error {}

const need = (why: string): never => {
  throw new MarketLaunchUnavailable(why);
};

/**
 * Work out the launch. `firstBuy` is what the creator chose to spend on the opening purchase, in wei, and zero
 * when they chose not to make one; it is listed either way so the total is never a surprise.
 */
export async function planMarketLaunch(
  reads: LaunchReads,
  choice: NameChoice,
  launchConfigId: number,
  firstBuy: bigint = 0n,
): Promise<LaunchPlan> {
  if (!isMarketLaunchWired()) return need("no market launcher is recorded for this deployment");
  if (firstBuy < 0n) return need("a first buy cannot be negative");

  const decimals = await reads.requiredDecimals();
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return need("the launcher reported impossible decimals");

  let name: Address;
  if (choice.kind === "existing") {
    if (!choice.address || isZero(choice.address)) return need("pick a name to launch against");
    name = choice.address;
  } else {
    if (!/^[A-Za-z0-9]{1,16}$/.test(choice.symbol)) return need("a new name needs a short plain symbol");
    // not the caller's to pick: a name with other decimals prices every coin under it wrong by a power of ten,
    // and the launcher refuses it, so the plan never offers it
    name = await reads.predictName(choice.salt, choice.symbol, decimals);
    if (isZero(name)) return need("the launcher could not say where the name would land");
  }

  const [expectedEconomics, fee] = await Promise.all([reads.previewEconomics(launchConfigId, name), reads.launchFee()]);

  const costs: LaunchPlan["costs"] = [{ label: "launch fee", amount: fee, asset: "ETH" }];
  if (firstBuy > 0n) costs.push({ label: "your first buy", amount: firstBuy, asset: "ETH" });

  return { name, createsName: choice.kind === "new", mustSortBelow: name, expectedEconomics, costs, decimals };
}

/** What the whole launch will take out of the wallet, before gas. */
export const totalDisclosed = (plan: LaunchPlan) => plan.costs.reduce((t, c) => t + c.amount, 0n);

/** Whether a ground address is actually usable against this plan. The launcher checks the same thing. */
export const ordersCorrectly = (plan: LaunchPlan, coin: Address) =>
  !!coin && !sameAddr(coin, plan.mustSortBelow) && BigInt(coin) < BigInt(plan.mustSortBelow);

/** The reads above, against a viem client. */
export function launchReadsFrom(
  client: { readContract(a: { abi: Abi; address: Address; functionName: string; args?: readonly unknown[] }): Promise<unknown> },
  launchFee: () => Promise<bigint>,
): LaunchReads {
  const at = ADDRESSES.marketTickerLauncher;
  return {
    predictName: (salt, symbol, decimals) =>
      client.readContract({ abi: LAUNCHER_ABI as Abi, address: at, functionName: "predictName", args: [salt, symbol, decimals] }) as Promise<Address>,
    previewEconomics: (id, name) =>
      client.readContract({ abi: LAUNCHER_ABI as Abi, address: at, functionName: "previewEconomics", args: [BigInt(id), name] }) as Promise<Hex>,
    requiredDecimals: async () =>
      Number(await client.readContract({ abi: LAUNCHER_ABI as Abi, address: at, functionName: "requiredDecimals" })),
    launchFee,
  };
}
