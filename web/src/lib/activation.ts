import {
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseEther,
  stringToHex,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { ADDRESSES, ZERO, isZero } from "./addresses";
import { keyOf, type V4Key } from "./route";

/**
 * Activation: the two buys that follow a launch, exactly as the reference sent them.
 *
 * Chart sites and trackers priced the reference's name from a swap that landed in a wallet after the name's pool
 * existed, and its coin from a buy in a later transaction; the launch transaction, first buy included, counted for
 * neither. So a launch under an invented name ends with two more wallet-signed transactions, one after the other,
 * both through Uniswap's canonical Universal Router with an explicit path of authenticated pool keys:
 *
 *   1. native ETH through the ETH/USDG pool into the name's own pool; the name is the final output, delivered to
 *      the creator's wallet (0.0005 ETH in the reference)
 *   2. after 1 is confirmed and a later block exists: fresh ETH through the same two pools into the coin's pool; the
 *      coin is delivered to the same wallet; the name bought in 1 is kept, not spent (0.001 ETH in the reference)
 *
 * Both stages, always, for a fresh name and for an existing one: skipping one is untested. The amounts are the
 * reference's test parameters, not proven minimums; other amounts need their own acceptance test.
 *
 * Nothing here signs or sends. This module is the pure part: the calldata, the checks on it, the journal a wallet
 * keeps of its attempts, and the verification of what a receipt shows. The hook drives it.
 */

export const PHASES = ["quote", "coin"] as const;
export type Phase = (typeof PHASES)[number];
/** The reference's purchase amounts, in wei. */
export const AMOUNTS: Record<Phase, bigint> = { quote: parseEther("0.0005"), coin: parseEther("0.001") };
/** The reference tolerance on a fresh quote: one percent under it, never zero. */
export const TOLERANCE_BPS = 100;
/** A prepared review is good for this long; after that a fresh quote is required. */
export const REVIEW_TTL_MS = 180_000;
/** How long a quote's deadline runs from the block it was quoted at. */
export const DEADLINE_SECONDS = 300;

/** The name's own pool against USDG: fee 500, spacing 1, behind the one managed hook. */
export const MANAGED_FEE = 500;
export const MANAGED_TICK_SPACING = 1;
export const MAX128 = (1n << 128n) - 1n;
export const MAX256 = (1n << 256n) - 1n;

export const isManagedHookWired = () => !isZero(ADDRESSES.managedTickerHook) && !isZero(ADDRESSES.universalRouter);

/**
 * What kind of name the route bridges through, which decides what its pool must look like.
 *
 * A managed name is a wrapper of a dollar and trades in one pool behind the one managed hook, always at fee 500
 * and spacing 1. A fixed-inventory name has its own market: a plain pool with no hook at all, at whatever fee and
 * spacing its issuer was built with. The two are not interchangeable and neither may be mistaken for the other,
 * so the kind is carried explicitly and the pool is checked against it rather than sniffed from the key.
 *
 * It must come from a read of the chain, the quote registry for the kind and the issuer for the fee and spacing.
 * Nothing here infers it.
 */
export type NameSpec = { kind: "legacy" } | { kind: "market"; fee: number; tickSpacing: number };
export const LEGACY_NAME: NameSpec = { kind: "legacy" };

/** Activation needs the universal router always, and the managed hook only for a managed name. */
export const isActivationWired = (name: NameSpec = LEGACY_NAME) =>
  !isZero(ADDRESSES.universalRouter) && (name.kind === "market" || !isZero(ADDRESSES.managedTickerHook));

export function managedKey(ticker: Address): V4Key {
  return keyOf(ticker, ADDRESSES.usdg, MANAGED_FEE, MANAGED_TICK_SPACING, ADDRESSES.managedTickerHook);
}

export function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

export const same = (a?: string | null, b?: string | null) => (a || "").toLowerCase() === (b || "").toLowerCase();
export const hex = (v: bigint | number): Hex => `0x${BigInt(v).toString(16)}`;
export const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
export const fingerprint = (v: unknown) => keccak256(stringToHex(json(v)));
export const isHash = (v: unknown): v is Hash => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);

// ---------------------------------------------------------------- the route and the calldata

export const EXECUTE_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
export const QUOTER_ABI = parseAbi([
  "function quoteExactInput((address exactCurrency,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint128 exactAmount) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
/** UniversalRouter 2.1.1's ExactInputParams: the `minHopPriceX36` array sits between the path and the amounts. */
export const EXACT_TYPE = {
  name: "params",
  type: "tuple",
  components: [
    { name: "currencyIn", type: "address" },
    {
      name: "path",
      type: "tuple[]",
      components: [
        { name: "intermediateCurrency", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" },
        { name: "hookData", type: "bytes" },
      ],
    },
    { name: "minHopPriceX36", type: "uint256[]" },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
  ],
} as const;
const COMMANDS: Hex = "0x1004"; // V4_SWAP, SWEEP
const ACTIONS: Hex = "0x070c0f"; // SWAP_EXACT_IN, SETTLE_ALL, TAKE_ALL

export type Pools = { funding: V4Key; bridge: V4Key; main: V4Key; name?: NameSpec };

/** The pool the name itself trades in: behind the managed hook, or its own hookless market. */
export function bridgeKey(ticker: Address, name: NameSpec = LEGACY_NAME): V4Key {
  if (name.kind === "legacy") return managedKey(ticker);
  return keyOf(ticker, ADDRESSES.usdg, name.fee, name.tickSpacing, ZERO);
}

export function poolId(k: V4Key): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
}

/** The three authenticated pools of a launch under a name, in route order: ETH/USDG, the name's own, the coin's own. */
export function poolsFor(ticker: Address, main: V4Key, name: NameSpec = LEGACY_NAME): Pools {
  return { funding: { currency0: ZERO, currency1: ADDRESSES.usdg, fee: 100, tickSpacing: 1, hooks: ZERO }, bridge: bridgeKey(ticker, name), main, name };
}

/** The path a phase walks from native ETH, each hop checked against what the pools must be. */
export function routeFor(p: Pools, phase: Phase) {
  check(phase === "quote" || phase === "coin", "unknown activation phase");
  const pools = [p.funding, p.bridge, p.main];
  check(same(p.funding.currency0, zeroAddress) && same(p.funding.currency1, ADDRESSES.usdg) && p.funding.fee === 100 && p.funding.tickSpacing === 1 && same(p.funding.hooks, zeroAddress), "wrong funding pool");
  const name = p.name ?? LEGACY_NAME;
  if (name.kind === "legacy") {
    check(p.bridge.fee === MANAGED_FEE && p.bridge.tickSpacing === MANAGED_TICK_SPACING && !isZero(p.bridge.hooks) && same(p.bridge.hooks, ADDRESSES.managedTickerHook), "wrong managed pool");
  } else {
    // a market's pool has no hook, so nothing can adjust the trade after the fact. Its fee and spacing are the
    // issuer's, read from the chain, and the pool must be the one that prices the name in dollars
    check(Number.isInteger(name.fee) && name.fee > 0 && name.fee < 1_000_000, "market fee out of range");
    check(Number.isInteger(name.tickSpacing) && name.tickSpacing > 0 && name.tickSpacing <= 32_767, "market tick spacing out of range");
    check(p.bridge.fee === name.fee && p.bridge.tickSpacing === name.tickSpacing, "the market pool is not the issuer's");
    check(isZero(p.bridge.hooks), "a market pool must have no hook");
    check(same(p.bridge.currency0, ADDRESSES.usdg) || same(p.bridge.currency1, ADDRESSES.usdg), "the market must price the name in dollars");
  }
  check(same(p.main.hooks, zeroAddress) && p.main.fee > 0 && p.main.fee < 1_000_000 && p.main.tickSpacing > 0 && p.main.tickSpacing <= 32_767, "wrong coin pool");
  let input: Address = zeroAddress;
  return pools.slice(0, phase === "quote" ? 2 : 3).map((pool) => {
    check(BigInt(pool.currency0) < BigInt(pool.currency1), "pool currencies must be sorted");
    check(same(input, pool.currency0) || same(input, pool.currency1), "disconnected route");
    const output = same(input, pool.currency0) ? pool.currency1 : pool.currency0;
    input = output;
    return { intermediateCurrency: output, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks, hookData: "0x" as Hex };
  });
}

export const outputOf = (p: Pools, phase: Phase): Address => (phase === "quote" ? (same(p.bridge.currency0, ADDRESSES.usdg) ? p.bridge.currency1 : p.bridge.currency0) : same(p.main.currency0, p.bridge.currency0) || same(p.main.currency0, p.bridge.currency1) ? p.main.currency1 : p.main.currency0);

/** One percent under a positive quote, never zero: the only minimum a buy is ever sent with. */
export function minimumOutput(quoted: bigint, slippageBps = TOLERANCE_BPS): bigint {
  check(typeof quoted === "bigint" && quoted > 0n && quoted <= MAX128, "a positive quote is required");
  check(Number.isInteger(slippageBps) && slippageBps >= 0 && slippageBps <= 100, "slippage cannot exceed 1%");
  const minimum = (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
  check(minimum > 0n, "the rounded minimum is zero");
  return minimum;
}

export function encodeBuy(args: { wallet: Address; pools: Pools; phase: Phase; amountIn: bigint; minimumOut: bigint; deadline: number }): Hex {
  const path = routeFor(args.pools, args.phase);
  const wallet = args.wallet.toLowerCase() as Address;
  check(/^0x[0-9a-f]{40}$/.test(wallet), "malformed wallet");
  check(![zeroAddress, ADDRESSES.universalRouter, ADDRESSES.poolManager, ...path.map((p) => p.intermediateCurrency), ...path.map((p) => p.hooks)].some((a) => same(a, wallet)), "invalid activation recipient");
  check(args.amountIn > 0n && args.amountIn <= MAX128, "a positive input is required");
  check(args.minimumOut > 0n && args.minimumOut <= MAX128, "a positive minimum is required");
  check(Number.isSafeInteger(args.deadline) && args.deadline > 0, "a bounded deadline is required");
  const output = path[path.length - 1].intermediateCurrency;
  const params = [
    encodeAbiParameters([EXACT_TYPE], [{ currencyIn: zeroAddress, path, minHopPriceX36: [], amountIn: args.amountIn, amountOutMinimum: args.minimumOut }]),
    encodeAbiParameters(parseAbiParameters("address,uint256"), [zeroAddress, args.amountIn]),
    encodeAbiParameters(parseAbiParameters("address,uint256"), [output, args.minimumOut]),
  ];
  const inputs = [encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [ACTIONS, params]), encodeAbiParameters(parseAbiParameters("address,address,uint256"), [zeroAddress, wallet, 0n])];
  return encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [COMMANDS, inputs, BigInt(args.deadline)] });
}

export function decodeBuy(data: Hex) {
  const outer = decodeFunctionData({ abi: EXECUTE_ABI, data });
  check(outer.functionName === "execute" && outer.args[0] === COMMANDS && outer.args[1].length === 2, "unexpected router command");
  const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes,bytes[]"), outer.args[1][0]);
  check(actions === ACTIONS && params.length === 3, "unexpected router action");
  const swap = decodeAbiParameters([EXACT_TYPE], params[0])[0];
  const settle = decodeAbiParameters(parseAbiParameters("address,uint256"), params[1]);
  const take = decodeAbiParameters(parseAbiParameters("address,uint256"), params[2]);
  const refund = decodeAbiParameters(parseAbiParameters("address,address,uint256"), outer.args[1][1]);
  check(same(swap.currencyIn, zeroAddress) && swap.minHopPriceX36.length === 0, "unexpected swap input");
  check(same(settle[0], zeroAddress) && settle[1] === swap.amountIn, "wrong settlement cap");
  check(same(take[0], swap.path[swap.path.length - 1]?.intermediateCurrency || zeroAddress) && take[1] === swap.amountOutMinimum, "wrong output settlement");
  check(same(refund[0], zeroAddress) && refund[2] === 0n, "wrong native refund");
  return { swap, recipient: refund[1] as Address, deadline: Number(outer.args[2]) };
}

// ---------------------------------------------------------------- the journal

/** The transaction as reviewed and as sent: explicit fees, gas and nonce, nothing left to the wallet's discretion. */
export type Request = { from: Address; to: Address; data: Hex; value: Hex; nonce: Hex; chainId: number; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };

export type Review = {
  phase: Phase;
  request: Request;
  /** the cost ceiling the person approved: value plus gas at the fee cap, with headroom */
  maximum: string;
  preparedAt: number;
  ledgerFingerprint: string;
  quote: string;
  minimum: string;
  deadline: number;
  /** the confirmed hash of the quote purchase, required on the coin purchase; empty on the quote purchase */
  predecessorHash: string;
  pools: Pools;
  gasEstimate: string;
};

export type Attempt = { review: Review; createdAt: number; hash?: Hash };
/** One wallet's record of one coin's activation, in this browser. Never cleared, never resent. */
export type Ledger = { version: 1; chainId: number; wallet: Address; coin: Address; ticker: Address; attempts: Attempt[]; declined: Attempt[] };

export const ledgerKey = (chainId: number, wallet: Address, coin: Address) => `tickr.activation.v2.${chainId}.${wallet.toLowerCase()}.${coin.toLowerCase()}`;

export const emptyLedger = (chainId: number, wallet: Address, coin: Address, ticker: Address): Ledger => ({ version: 1, chainId, wallet, coin, ticker, attempts: [], declined: [] });

export function validateReview(l: Ledger, v: Review) {
  const t = v.request;
  const offset = PHASES.indexOf(v.phase);
  check(offset >= 0 && Number.isSafeInteger(v.deadline) && v.deadline > 0 && Number.isFinite(v.preparedAt), "malformed activation review");
  check(BigInt(t.value) === AMOUNTS[v.phase], "the purchase amount differs from the disclosed one");
  check(BigInt(v.minimum) === minimumOutput(BigInt(v.quote)), "the minimum differs from the 1% quote limit");
  check(same(t.from, l.wallet) && same(t.to, ADDRESSES.universalRouter) && t.chainId === l.chainId, "the transaction identity changed");
  check(v.phase === "quote" ? v.predecessorHash === "" : isHash(v.predecessorHash), "missing or unexpected preceding receipt");
  check(BigInt(t.gas) > 0n && BigInt(t.gas) <= 32_000_000n && BigInt(t.maxFeePerGas) > 0n && BigInt(t.maxPriorityFeePerGas) === 0n, "invalid fees");
  check(t.data === encodeBuy({ wallet: l.wallet, pools: v.pools, phase: v.phase, amountIn: AMOUNTS[v.phase], minimumOut: BigInt(v.minimum), deadline: v.deadline }), "the calldata changed");
  check(BigInt(v.maximum) >= maximumCost(t), "the approved maximum is below the transaction's own cost");
  check(same(decodeBuy(t.data).recipient, l.wallet), "the recipient changed");
  check(same(outputOf(v.pools, v.phase), v.phase === "quote" ? l.ticker : l.coin), "the output is not the expected asset");
}

export function validateLedger(l: unknown, chainId: number, wallet: Address, coin: Address): Ledger {
  const x = l as Ledger;
  check(x && x.version === 1 && x.chainId === chainId && same(x.wallet, wallet) && same(x.coin, coin) && Array.isArray(x.attempts) && Array.isArray(x.declined), "another or invalid activation record exists; it is kept as it is");
  check(x.attempts.length <= 2, "too many activation attempts recorded");
  for (const [i, a] of x.attempts.entries()) {
    validateReview(x, a.review);
    check(a.review.phase === PHASES[i] && Number.isFinite(a.createdAt), "invalid activation order");
    check(!a.hash || isHash(a.hash), "invalid saved activation hash");
    if (i === 1) check(!!x.attempts[0].hash && same(a.review.predecessorHash, x.attempts[0].hash), "the coin review lost its preceding receipt");
  }
  return x;
}

type Store = Pick<Storage, "getItem" | "setItem">;

export function loadLedger(s: Pick<Storage, "getItem">, chainId: number, wallet: Address, coin: Address, ticker: Address): Ledger {
  const raw = s.getItem(ledgerKey(chainId, wallet, coin));
  if (!raw) return emptyLedger(chainId, wallet, coin, ticker);
  return validateLedger(JSON.parse(raw), chainId, wallet, coin);
}

/** Save, then read back: a write that did not land is a stop, never a reason to sign. */
export function saveLedger(s: Store, l: Ledger) {
  validateLedger(l, l.chainId, l.wallet, l.coin);
  const key = ledgerKey(l.chainId, l.wallet, l.coin);
  const raw = json(l);
  s.setItem(key, raw);
  check(s.getItem(key) === raw, "the activation record could not be saved durably. nothing was sent; fix storage and try again.");
}

export const maximumCost = (t: Request) => BigInt(t.value) + BigInt(t.gas) * BigInt(t.maxFeePerGas);
export const paddedGas = (estimate: bigint) => (estimate * 120n + 99n) / 100n + 50_000n;
export const permissionCeiling = (value: bigint, gas: bigint, fee: bigint) => ((value + gas * fee) * 125n) / 100n;
export const reviewExpired = (v: Review, now = Date.now()) => now - v.preparedAt > REVIEW_TTL_MS || now < v.preparedAt;

/** The identity of a submitted transaction against the reviewed one: sender, target, payload, nonce, value, chain. */
export function matchIdentity(actual: { from?: string; to?: string | null; input?: string; nonce?: number | bigint; value?: bigint; chainId?: number }, expected: Request) {
  check(actual && same(actual.from, expected.from) && same(actual.to, expected.to) && same(actual.input, expected.data), "the submitted transaction differs from the reviewed one. stop for review.");
  check(actual.nonce !== undefined && BigInt(actual.nonce) === BigInt(expected.nonce), "the submitted nonce differs. stop for review.");
  check(actual.value !== undefined && BigInt(actual.value) === BigInt(expected.value), "the submitted value differs. stop for review.");
  check(actual.chainId === undefined || Number(actual.chainId) === expected.chainId, "the submitted chain differs. stop for review.");
}

// ---------------------------------------------------------------- what a receipt proves

const EVENTS = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

export type Log = { address: Address; topics: Hex[]; data: Hex };

/**
 * A phase's receipt logs must show: one ordinary swap made by the router on each pool of the route, in order, each
 * consuming the previous one's whole output; the final output landing in the wallet, whole, at least the minimum;
 * and on the coin phase, none of the name bought in the quote phase leaving the wallet. Returns what the wallet
 * received.
 */
export function verifyTradeLogs(l: Ledger, phase: Phase, logs: Log[], minimum: bigint, pools: Pools): bigint {
  const route = phase === "quote" ? [pools.funding, pools.bridge] : [pools.funding, pools.bridge, pools.main];
  const output = phase === "quote" ? l.ticker : l.coin;
  const swaps: { id: Hex; amount0: bigint; amount1: bigint }[] = [];
  let received = 0n;
  for (const log of logs) {
    let d;
    try {
      d = decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    if (d.eventName === "Transfer" && same(log.address, output)) {
      if (same(d.args.to, l.wallet)) received += d.args.value;
      if (same(d.args.from, l.wallet)) received -= d.args.value;
    }
    if (d.eventName === "Swap" && same(log.address, ADDRESSES.poolManager) && same(d.args.sender, ADDRESSES.universalRouter)) swaps.push({ id: d.args.id, amount0: d.args.amount0, amount1: d.args.amount1 });
    if (phase === "coin" && d.eventName === "Transfer" && same(log.address, l.ticker)) check(!same(d.args.from, l.wallet), "the coin purchase must not spend the name bought into the wallet");
  }
  check(swaps.length === route.length, "unexpected number of router swaps");
  let input: Address = zeroAddress;
  let amount = AMOUNTS[phase];
  for (const [i, key] of route.entries()) {
    const swap = swaps[i];
    const input0 = same(input, key.currency0);
    const paid = input0 ? swap.amount0 : swap.amount1;
    const out = input0 ? swap.amount1 : swap.amount0;
    check(swap.id === poolId(key) && paid < 0n && -paid === amount && out > 0n, "a swap is not on the expected pool with the expected input");
    input = input0 ? key.currency1 : key.currency0;
    amount = out;
  }
  check(same(input, output) && amount >= minimum && received === amount, "the wallet must receive the complete final output, not an intermediate");
  return received;
}

/** The lock every signing step of a wallet takes, across tabs, so two tabs cannot both open the wallet. */
export const lockName = (chainId: number, wallet: Address) => `tickr-signing-${chainId}-${wallet.toLowerCase()}`;

export type { Hex };
