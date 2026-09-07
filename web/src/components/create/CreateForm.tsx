"use client";

import type { Abi } from "viem";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAccount, useChainId, usePublicClient, useReadContract } from "wagmi";
import { encodeFunctionData, erc20Abi, formatUnits, isAddress, parseAbi, parseEther, toHex, type Address, type Hash, type Hex } from "viem";

/** The OpenZeppelin token errors a launch can surface, so a pre-flight names them instead of printing a selector. */
const ERC20_ERRORS = parseAbi([
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);
import { CoinQuoteLauncherAbi, TickerLauncherAbi, FactoryAbi, LaunchAndBuyRouterAbi, StockQuoteLauncherAbi, AnchorRegistryAbi, MarketQuoteLauncherAbi, LaunchDeployerAbi } from "@/lib/abis";
import { ADDRESSES, DEPLOYED, ZERO, isZero, sameAddr } from "@/lib/addresses";
import { TICKER_ALLOCATION } from "@/lib/constants";
import { applySlippage } from "@/lib/pool";
import { bpsToPct, errorMessage, fmtAmount, safeParseUnits, splitLabel, type FeeSplit } from "@/lib/format";
import { useQuoteAssets, type QuoteAsset } from "@/hooks/useQuoteAssets";
import { useEligibleQuoteCoins } from "@/hooks/useCoinQuotes";
import { useTickers } from "@/hooks/useTickers";
import { useEligibleStockTokens } from "@/hooks/useStockTokens";
import { useMarketData } from "@/hooks/useMarketData";
import { useChainTokens } from "@/hooks/useChainTokens";
import { QuotePicker, type PickItem } from "./QuotePicker";
import { useEthUsd } from "@/hooks/useEthUsd";
import { useTx, type WriteFn, KNOWN_ERRORS } from "@/hooks/useTx";
import { StockLogo } from "../StockLogo";
import { OfficialBadge } from "../QuoteChip";
import { TxStatus } from "../TxStatus";
import { Field, Notice, Row } from "../ui";
import { grindSalt, tokenInitCodeHash, type GrindResult } from "@/lib/vanity";
import { Collapse } from "../Collapse";
import { RainbowRule } from "../RainbowRule";
import { LogoPicker } from "./LogoPicker";
import { PairCard } from "./PairCard";
import stocks from "@/data/stocks.json";
import { DEMO } from "@/lib/demoTransport";
import { GlideIndicator, useGlider } from "../motion/Glide";
import { Ceremony, useCeremony } from "../motion/Ceremony";
import { REEL_TICKERS } from "../motion/TickerReel";
import { ActivateCard } from "../token/Activate";
import { createLaunchFlow, type LaunchFlow, type LaunchIntent } from "@/lib/launchFlow";
import { lockName } from "@/lib/activation";
import { readBounded } from "@/lib/readRpc";
import { explorerTx } from "@/lib/chain";

type Tab = "eth" | "usdg" | "official" | "diy" | "coin" | "market";
const SOCIAL_FIELDS = [
  { key: "twitter", label: "X (Twitter)", placeholder: "https://x.com/yourcoin" },
  { key: "discord", label: "Discord", placeholder: "https://discord.gg/yourcoin" },
  { key: "website", label: "Website", placeholder: "https://yourcoin.xyz" },
] as const;
/** The first buy chips, as a share of supply in bps. */
const SHARE_CHIPS = [100, 200] as const;
const TAB_IDS: Tab[] = ["eth", "usdg", "official", "diy", "coin", "market"];
/** What the form shows. eth and usdg are their own tab; every other quote asset is one searchable list; inventing a name is the fourth. */
type Choice = "eth" | "usdg" | "token" | "stocks" | "invent";
const CHOICES: { id: Choice; label: string; keepCase?: boolean; hero?: boolean }[] = [
  { id: "invent", label: "invent a name", hero: true },
  { id: "token", label: "any token" },
  { id: "eth", label: "ETH", keepCase: true },
  { id: "usdg", label: "USDG", keepCase: true },
  { id: "stocks", label: "Robinhood stocks", keepCase: true },
];
const choiceOf = (t: Tab, mode: "new" | "existing"): Choice => (t === "eth" ? "eth" : t === "usdg" ? "usdg" : t === "official" ? "stocks" : t === "diy" && mode === "new" ? "invent" : "token");

/**
 * One line each, all the same shape, so the five read as a set. The detail lives on the step below the choice.
 * The page lowercases its text, so a proper noun has to opt out of that with `cap` to keep its capitals.
 */
/**
 * The empty state's example, drawn once per visit from the same words the hero cycles through. It is only a
 * placeholder: prefilling someone's ticker for them was never the help it looked like, and showing the same word
 * every time made that one word look like the official answer.
 */
/** A word from the reel that can actually be invented: official Stock Token symbols like NVDA are reserved. */
const INVENTABLE = REEL_TICKERS.filter((w) => w !== "NVDA");
function sampleTicker(): string {
  return INVENTABLE[Math.floor(Math.random() * INVENTABLE.length)];
}
// Chosen once per page load in the browser. The server always renders the first word, and React swaps in the
// browser's pick after hydration instead of flagging the two as a mismatch.
const CLIENT_EXAMPLE = typeof window !== "undefined" ? sampleTicker() : REEL_TICKERS[0];
const subscribeNever = () => () => {};
const getClientExample = () => CLIENT_EXAMPLE;
const getServerExample = () => REEL_TICKERS[0];

type Prepared = {
  label: string;
  request: { abi: readonly unknown[]; address: Address; functionName: string; args: readonly unknown[]; value: bigint };
  approve?: { label: string; request: { abi: typeof erc20Abi; address: Address; functionName: "approve"; args: readonly [Address, bigint] } };
  /** which return value is the coin's address */
  tokenIndex: number;
};


/** What fixes a coin's CREATE2 address: its constructor arguments and the wallet launching it. Nothing until all are known. */
function vanityInputs(f: {
  user?: Address;
  supply?: bigint;
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: { twitter: string; telegram: string; discord: string; website: string; farcaster: string };
  seed: Hex;
}): { initCodeHash: Hex; initiator: Address; key: string } | undefined {
  if (!f.user || !f.supply || isZero(ADDRESSES.launchDeployer) || isZero(ADDRESSES.factory) || !f.name.trim() || !f.symbol.trim()) return undefined;
  const initCodeHash = tokenInitCodeHash({
    name: f.name.trim(),
    symbol: f.symbol.trim(),
    logo: f.logo.trim(),
    description: f.description.trim(),
    socials: { ...f.socials },
    supply: f.supply,
    factory: ADDRESSES.factory,
  });
  return { initCodeHash, initiator: f.user, key: `${f.seed}:${initCodeHash}:${f.user.toLowerCase()}` };
}

function randomSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return toHex(b);
}

export function CreateForm() {
  const client = usePublicClient();
  const { address: user } = useAccount();
  const tx = useTx();
  const assets = useQuoteAssets();
  const ceremony = useCeremony();
  const chainId = useChainId();
  const launchedToken = useRef<Address | undefined>(undefined);
  // the launch landed: under an invented name the page shows its last step, the two buys that activate it, until
  // they land, and no link before that; any other launch shows its receipt and its link
  const [activating, setActivating] = useState<{ token: Address; isTicker: boolean; hash?: Hex } | undefined>(undefined);
  // a launch this wallet started and this browser has not seen through: settled before anything new is offered.
  // `blockedNote` is a record this browser cannot even read: nothing new is offered until it can
  const [pendingLaunch, setPendingLaunch] = useState<LaunchIntent | undefined>(undefined);
  const [pendingNote, setPendingNote] = useState<string>("");
  const [blockedNote, setBlockedNote] = useState<string>("");
  const [recoverHash, setRecoverHash] = useState("");
  const retriedSquat = useRef(false);
  // one salt per attempt, so a retry after a failed send lands on the same address; a launch resumed from the
  // journal keeps its seed, so a second signature could only ever be the same coin, which cannot deploy twice
  const [seed, setSeed] = useState<Hex>(() => {
    try {
      const w = typeof window !== "undefined" ? window : undefined;
      const raw = w?.localStorage.getItem("tickr.launch.seed.hint");
      return raw && /^0x[0-9a-f]{64}$/i.test(raw) ? (raw as Hex) : randomSalt();
    } catch {
      return randomSalt();
    }
  });
  // every coin's address ends in 6942: the salt is ground from the seed above once the fields are final. the review
  // and the transaction share one cache so the address shown is the address deployed.
  const vanityCache = useRef<Map<string, Promise<GrindResult>>>(new Map());
  // one example for the life of the page, so the placeholder does not change under the cursor while typing
  const example = useSyncExternalStore(subscribeNever, getClientExample, getServerExample);

  // ---- form state
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [logo, setLogo] = useState("");
  const [description, setDescription] = useState("");
  // `telegram` stays in the contract's Socials struct, written empty: tickr never asks for one.
  const [socials, setSocials] = useState({ twitter: "", telegram: "", discord: "", website: "", farcaster: "" });
  const [feeWallet, setFeeWallet] = useState("");
  const [creatorTax, setCreatorTax] = useState(""); // percent, as typed
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => {
    const t = params.get("tab");
    return TAB_IDS.includes(t as Tab) ? (t as Tab) : "diy";
  });
  const [choice, setChoice] = useState<Choice>(() => {
    const t = params.get("tab");
    return TAB_IDS.includes(t as Tab) ? choiceOf(t as Tab, "new") : "invent";
  });
  const [official, setOfficial] = useState<Address | undefined>();
  const [quoteCoin, setQuoteCoin] = useState<Address | undefined>();
  // any token on the chain with a market of its own
  const [marketToken, setMarketToken] = useState<Address | undefined>();
  // The anything tab either invents a new ticker or joins one that already exists.
  const [diyMode, setDiyMode] = useState<"new" | "existing">("new");
  const [diyQuote, setDiyQuote] = useState<Address | undefined>();
  const [firstBuy, setFirstBuy] = useState("");
  // the dev buy is entered as coins wanted or as quote spent; the transaction always carries the quote amount
  const [devMode, setDevMode] = useState<"tokens" | "spend">("tokens");
  const [devTokens, setDevTokens] = useState("");
  const [configId, setConfigId] = useState("0");
  // An invented ticker is a one-for-one wrapper of USDG: the only choice is its symbol.
  const [diy, setDiy] = useState({ anchorTicker: "" });
  const [formError, setFormError] = useState<string | undefined>();
  const [step, setStep] = useState(0);
  // any address pasted on the pair step: resolved to one of tickr's pair kinds, or shown for what it is.
  // a shared /create?pair=0x… link starts here too; resolving it clears the field and selects the pair
  const [pasted, setPasted] = useState(() => {
    const p = params.get("pair");
    return p && isAddress(p) ? p : "";
  });
  const [pastedNote, setPastedNote] = useState<string | undefined>();
  const prefilled = useRef(false);
  const { trackRef: tabTrack, indRef: tabInd } = useGlider(choice);
  const { trackRef: stepTrack, indRef: stepInd } = useGlider(step);

  // ---- chain reads
  const launchFee = useReadContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "launchFee", query: { enabled: DEPLOYED } });
  // what inventing a new name costs on top of the launch fee: it buys the dollars that open the name's guarded pool
  const newTickerFee = useReadContract({
    abi: TickerLauncherAbi,
    address: ADDRESSES.tickerLauncher,
    functionName: "NEW_TICKER_FEE",
    query: { enabled: DEPLOYED && !isZero(ADDRESSES.tickerLauncher) },
  });
  const maxTax = useReadContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "maxCreatorTaxBps", query: { enabled: DEPLOYED } });
  // the split every new launch is frozen with
  const policy = useReadContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "defaultPolicy", query: { enabled: DEPLOYED } });
  const configCount = useReadContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "launchConfigCount", query: { enabled: DEPLOYED } });
  const cfgId = BigInt(Number(configId) || 0);
  const config = useReadContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "getLaunchConfig", args: [cfgId], query: { enabled: DEPLOYED } });

  const usdgAsset: QuoteAsset | undefined = assets.data?.find((a) => sameAddr(a.address, ADDRESSES.usdg)) ?? assets.data?.find((a) => a.kind === 1 && a.active);
  const stocksQ = useEligibleStockTokens();
  const officials = stocksQ.data ?? [];
  const selectedStock = officials.find((o) => sameAddr(o.address, official));
  const pairToken: Address | undefined = tab === "eth" ? ZERO : tab === "usdg" ? (usdgAsset?.address ?? ADDRESSES.usdg) : tab === "official" ? official : undefined;
  const pairAsset = tab === "eth" ? undefined : tab === "usdg" ? usdgAsset : undefined;
  const pairDecimals = tab === "eth" ? 18 : (pairAsset?.decimals ?? (tab === "usdg" ? 6 : 18));
  const pairSymbol = tab === "eth" ? "ETH" : (pairAsset?.symbol ?? (tab === "usdg" ? "USDG" : "-"));

  const pairEcon = useReadContract({
    abi: FactoryAbi,
    address: ADDRESSES.factory,
    functionName: "pairTokenEconomics",
    args: pairToken && !isZero(pairToken) ? [pairToken] : undefined,
    query: { enabled: DEPLOYED && !!pairToken && !isZero(pairToken) },
  });

  // ticker reads
  const coinsQ = useEligibleQuoteCoins();
  const coins = coinsQ.data ?? [];
  const selectedCoin = coins.find((c) => sameAddr(c.address, quoteCoin));
  const coinOn = tab === "coin" && !isZero(ADDRESSES.coinQuoteLauncher);
  const stockEcon = useReadContract({
    abi: StockQuoteLauncherAbi,
    address: ADDRESSES.stockQuoteLauncher,
    functionName: "previewLaunch",
    args: official ? [cfgId, official] : undefined,
    query: { enabled: tab === "official" && !!official && !isZero(ADDRESSES.stockQuoteLauncher) },
  });
  const coinEcon = useReadContract({
    abi: CoinQuoteLauncherAbi,
    address: ADDRESSES.coinQuoteLauncher,
    functionName: "previewLaunch",
    args: quoteCoin ? [cfgId, quoteCoin] : undefined,
    query: { enabled: coinOn && !!quoteCoin },
  });
  const chainQ = useChainTokens();
  const ethUsd = useEthUsd();
  const chainTokens = useMemo(() => chainQ.data ?? [], [chainQ.data]);
  const selectedMarket = chainTokens.find((c) => sameAddr(c.address, marketToken));
  const marketEcon = useReadContract({
    abi: MarketQuoteLauncherAbi,
    address: ADDRESSES.marketQuoteLauncher,
    functionName: "previewLaunch",
    args: marketToken ? [cfgId, marketToken] : undefined,
    query: { enabled: tab === "market" && !!marketToken && !isZero(ADDRESSES.marketQuoteLauncher) },
  });
  const diyOn = tab === "diy" && !isZero(ADDRESSES.tickerLauncher);
  const sharedOn = diyOn && diyMode === "existing";
  // the split this launch will freeze: 50 / 10 / 40 under a ticker, where the club exists; elsewhere the club's
  // share is the creator's, 60 / 40
  const split: FeeSplit | undefined = policy.data
    ? diyOn
      ? { creatorShareBps: Number(policy.data[1]), clubShareBps: Number(policy.data[2]), protocolShareBps: Number(policy.data[3]) }
      : { creatorShareBps: Number(policy.data[1]) + Number(policy.data[2]), clubShareBps: 0, protocolShareBps: Number(policy.data[3]) }
    : undefined;
  const diyQuotesQ = useTickers();
  const diyQuotes = diyQuotesQ.data ?? [];
  const selectedDiyQuote = diyQuotes.find((q) => sameAddr(q.quoteToken, diyQuote));
  // one preview serves both paths: the ticker's address is deterministic, so a launch can hash its terms
  // against a ticker that will only be created inside the launch
  const tickerSymbol = sharedOn ? (selectedDiyQuote?.ticker ?? "") : diy.anchorTicker.trim();
  const tickerPreview = useReadContract({
    abi: TickerLauncherAbi,
    address: ADDRESSES.tickerLauncher,
    functionName: "previewLaunch",
    args: tickerSymbol ? [tickerSymbol, cfgId] : undefined,
    query: { enabled: diyOn && tickerSymbol.length > 0, refetchInterval: 10_000 },
  });

  const tickerUp = diy.anchorTicker.trim().toUpperCase();

  // ---- economics preview: the opening market cap in the pair's own units, and the pool fee
  const econ = (() => {
    const c = config.data;
    if (!c) return undefined;
    const base = { supply: c.supply, baseFeeBps: c.baseFeeBps };
    if (tab === "diy") {
      const e = tickerPreview.data?.[3];
      if (!e && DEMO && ethUsd.data) {
        const phantom = safeParseUnits((1.68 * ethUsd.data).toFixed(2), 6) ?? 0n;
        const symbol = sharedOn ? (selectedDiyQuote?.ticker || "QUOTE") : tickerUp || "QUOTE";
        return { ...base, phantom, decimals: 6, symbol };
      }
      if (!e) return undefined;
      const symbol = sharedOn ? (selectedDiyQuote?.ticker || "QUOTE") : tickerUp || "QUOTE";
      return { ...base, phantom: e.phantomQuote, decimals: Number(e.decimals), symbol };
    }
    if (tab === "coin") {
      const e = coinEcon.data?.[1];
      if (!e) return undefined;
      return { ...base, phantom: e.phantomQuote, decimals: 18, symbol: selectedCoin?.symbol || "COIN" };
    }
    if (tab === "official") {
      const e = stockEcon.data?.[1];
      if (!e) return undefined;
      return { ...base, phantom: e.phantomQuote, decimals: Number(e.decimals), symbol: selectedStock?.ticker || "STOCK" };
    }
    if (tab === "market") {
      const e = marketEcon.data?.[1];
      if (e) return { ...base, phantom: e.phantomQuote, decimals: Number(e.decimals), symbol: selectedMarket?.symbol || "TOKEN" };
      // the preview has no launcher to ask: the same sum from the listed price, for display only
      if (DEMO && selectedMarket?.priceUsd && ethUsd.data) {
        const units = (4.2 * 0.4 * ethUsd.data) / selectedMarket.priceUsd;
        const phantom = safeParseUnits(units.toFixed(Math.min(6, selectedMarket.decimals)), selectedMarket.decimals) ?? 0n;
        if (phantom > 0n) return { ...base, phantom, decimals: selectedMarket.decimals, symbol: selectedMarket.symbol };
      }
      return undefined;
    }
    if (tab === "eth") return { ...base, phantom: c.phantomQuote, decimals: 18, symbol: "ETH" };
    const e = pairEcon.data;
    if (!e || e[0] === 0n) return undefined;
    return { ...base, phantom: e[0], decimals: Number(e[1]), symbol: pairSymbol };
  })();

  const taxBps = Math.max(0, Math.min(1000, Math.round((Number(creatorTax) || 0) * 100)));
  const maxTaxBps = maxTax.data !== undefined ? Number(maxTax.data) : 200;
  const baseFeeBps = config.data ? Number(config.data.baseFeeBps) : 100;
  const poolFeeBps = baseFeeBps + taxBps;
  // the first buy is paid in whatever the coin is priced in: USDG for an invented ticker (wrapped on the way in),
  // the Stock Token, the quote coin, or the pair itself
  const firstBuySymbol = tab === "diy" ? (usdgAsset?.symbol ?? "USDG") : tab === "official" ? (selectedStock?.ticker ?? "") : tab === "coin" ? (selectedCoin?.symbol ?? "") : tab === "market" ? (selectedMarket?.symbol ?? "") : pairSymbol;
  const firstBuyDecimals = tab === "diy" ? (usdgAsset?.decimals ?? 6) : tab === "official" ? (selectedStock?.decimals ?? 18) : tab === "coin" ? 18 : tab === "market" ? (selectedMarket?.decimals ?? 18) : pairDecimals;
  const firstBuyReady = tab === "diy" ? (sharedOn ? !!diyQuote : tickerUp.length > 0) : tab === "official" ? !!official : tab === "coin" ? !!quoteCoin : tab === "market" ? !!marketToken : true;
  const firstBuyAmt = safeParseUnits(firstBuy, firstBuyDecimals) ?? 0n;

  /**
   * What the first buy gets, at the opening state: the position behaves like a constant product pool whose quote
   * side starts at the opening market cap, and the pool fee comes off the input. The pool opens a tick or two
   * above that price, so the minimum sent along allows for it.
   */
  const firstBuyPreview = (() => {
    if (!econ || firstBuyAmt === 0n) return undefined;
    const net = (firstBuyAmt * BigInt(10_000 - poolFeeBps)) / 10_000n;
    const tokensOut = (net * econ.supply) / (econ.phantom + net);
    return { tokensOut, fee: firstBuyAmt - net };
  })();

  /** The quote needed to take a share of the supply from the opening state: the inverse of the preview above, fee included. */
  function quoteForShare(bps: number): string {
    if (!econ) return "";
    return quoteForTokens((econ.supply * BigInt(bps)) / 10_000n);
  }
  /** The quote needed to take `t` coins from the opening state, fee included. */
  function quoteForTokens(t: bigint): string {
    if (!econ || t <= 0n) return "";
    if (t >= econ.supply) return "";
    const net = (econ.phantom * t) / (econ.supply - t) + 1n;
    const gross = (net * 10_000n) / BigInt(10_000 - poolFeeBps) + 1n;
    const n = Number(formatUnits(gross, firstBuyDecimals));
    return String(Number(n >= 1 ? n.toFixed(4) : n.toPrecision(4)));
  }

  // the dev buy as a share of the supply, live, whichever way it was entered
  const devShare = (() => {
    const supply = config.data?.supply;
    if (!supply) return undefined;
    const coins = devMode === "tokens" ? (safeParseUnits(devTokens, 18) ?? 0n) : (firstBuyPreview?.tokensOut ?? 0n);
    if (coins <= 0n) return undefined;
    return (Number((coins * 100_000n) / supply) / 1000).toFixed(2);
  })();

  // dollars per unit of the quote, where a dollar figure can be established: ETH from its pool, USDG and tickers at one,
  // a Stock Token from its feed. a coin quote is left unpriced rather than guessed.
  const quoteUsd = tab === "eth" ? (ethUsd.data ?? undefined) : tab === "usdg" || tab === "diy" ? 1 : tab === "official" ? selectedStock?.priceUsd : tab === "market" ? selectedMarket?.priceUsd : undefined;
  const usdNote = econ && quoteUsd ? `about $${(Number(formatUnits(econ.phantom, econ.decimals)) * quoteUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : undefined;

  // inventing a new name: the launch fee plus the ticker fee; joining a name that exists costs the launch fee alone
  const inventing = diyOn && !sharedOn;
  const tickerFeeDue = inventing ? (newTickerFee.data ?? 0n) : 0n;
  const valueTotal = (launchFee.data ?? 0n) + tickerFeeDue + (tab === "eth" ? firstBuyAmt : 0n);

  function validate(): string | undefined {
    if (!user) return "Connect a wallet first.";
    if (!DEPLOYED) return "Contracts are not deployed.";
    if (!name.trim() || !symbol.trim()) return "Name and ticker are required.";
    if (reservedSymbol.data === true) return `${coinSymbolUp} is an anchor ticker on Robinhood Chain, so a coin cannot use it.`;
    if (nameReserved) return `"${name.trim()}" is the name of an official asset, so a coin cannot use it.`;
    if (!/^[\x20-\x7E]+$/.test(name.trim())) return "Names use plain letters, digits and punctuation. Emoji and other scripts go in the description or the image.";
    if (!logo.trim()) return "Add an image for your coin.";
    if (!description.trim()) return "Write a description for your coin.";
    if (feeWallet && !isAddress(feeWallet)) return "Fee wallet is not a valid address.";
    if (taxBps > maxTaxBps) return `Creator tax exceeds the factory max (${bpsToPct(maxTaxBps)}).`;
    if (!config.data?.enabled) return "Selected launch config is disabled.";
    if (tab === "official") {
      if (isZero(ADDRESSES.stockQuoteLauncher)) return "Stock Token launches are not available yet.";
      if (!official) return "Pick a Stock Token.";
      if (!stockEcon.data) return "That Stock Token has no fresh price right now.";
    }
    if (tab === "coin") {
      if (isZero(ADDRESSES.coinQuoteLauncher)) return "Coin-quoted launches are not available yet.";
      if (!quoteCoin) return "Pick a coin to price against.";
      if (!coinEcon.data) return "That coin cannot be used as a quote right now.";
    }
    if (tab === "market") {
      if (isZero(ADDRESSES.marketQuoteLauncher)) return "Launches priced in a chain token are not available yet.";
      if (!marketToken) return "Pick a token to price against.";
      if (!marketEcon.data) return "That token has no deep enough market right now.";
    }
    if (tab !== "diy" && tab !== "eth" && !econ) return "Pair token is not approved on the factory.";
    if (firstBuyAmt > 0n && !firstBuyPreview) return "The first buy has no preview yet. Wait a moment, or clear it.";
    if (inventing && newTickerFee.data === undefined) return "Could not read the new ticker fee. Try again in a moment.";
    if (tab === "diy" && sharedOn) {
      if (!diyQuote) return "Pick a ticker to price against.";
      if (!tickerPreview.data) return "That ticker cannot be launched against right now.";
    } else if (tab === "diy") {
      if (isZero(ADDRESSES.tickerLauncher)) return "Creating tickers is not available yet.";
      if (!diy.anchorTicker.trim()) return "Pick a ticker.";
      if (reservedTicker.data === true) return `${tickerUp} is an anchor ticker, so it cannot be an invented ticker. Pick another.`;
      if (!tickerPreview.data) return "Could not preview this launch. Try again in a moment.";
    }
    return undefined;
  }

  const supplyForVanity = config.data?.supply;
  const vanityInp = useMemo(
    () => (step === 2 ? vanityInputs({ user, supply: supplyForVanity, name, symbol, logo, description, socials, seed }) : undefined),
    [step, user, supplyForVanity, name, symbol, logo, description, socials, seed],
  );
  useEffect(() => {
    if (!vanityInp) return;
    let p = vanityCache.current.get(vanityInp.key);
    if (!p) {
      p = grindSalt({ deployer: ADDRESSES.launchDeployer, initiator: vanityInp.initiator, initCodeHash: vanityInp.initCodeHash, seed });
      vanityCache.current.set(vanityInp.key, p);
    }
    // the grind runs ahead of the launch so the salt is ready when the wallet opens; the result lives in the cache
    p.catch(() => {});
    return () => {};
  }, [vanityInp, seed]);

  /** The ground salt and address for the current fields, one promise per seed, init code and wallet. */
  function vanityFor(useSeed: Hex = seed): Promise<GrindResult> | undefined {
    const inp = vanityInputs({ user, supply: config.data?.supply, name, symbol, logo, description, socials, seed: useSeed });
    if (!inp) return undefined;
    let p = vanityCache.current.get(inp.key);
    if (!p) {
      p = grindSalt({ deployer: ADDRESSES.launchDeployer, initiator: inp.initiator, initCodeHash: inp.initCodeHash, seed: useSeed });
      vanityCache.current.set(inp.key, p);
    }
    return p;
  }

  /** One approve step when the launcher may not pull `amount` of `token` from the user yet; nothing otherwise. */
  async function approveIfNeeded(token: Address, spender: Address, amount: bigint, symbolLabel: string): Promise<Prepared["approve"]> {
    if (!client || !user) return undefined;
    const allowance = await client.readContract({ abi: erc20Abi, address: token, functionName: "allowance", args: [user, spender] });
    if (allowance >= amount) return undefined;
    return { label: `Approve ${symbolLabel}`, request: { abi: erc20Abi, address: token, functionName: "approve", args: [spender, amount] } };
  }

  const storage = () => window.localStorage;

  /** The wallet's signing lock across tabs, shared with the activation. No lock manager, no signing. */
  const withLock = async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (!user) throw new Error("no wallet");
    if (typeof navigator === "undefined" || !navigator.locks) throw new Error("this browser cannot hold a signing lock across tabs, so nothing is sent from it. use a current desktop browser.");
    return navigator.locks.request(lockName(chainId, user), { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error("another tab is launching or listing with this wallet. finish there, or close it without clearing its records.");
      return fn();
    }) as Promise<T>;
  };

  /** The creation engine for this wallet: reads only, the lock held by whoever calls it. */
  const flowFor = (locks: "own" | "held"): LaunchFlow | undefined => {
    if (!client || !user) return undefined;
    const c = client;
    return createLaunchFlow({
      chainId,
      wallet: user,
      factory: ADDRESSES.factory,
      storage: storage(),
      reads: {
        transaction: (h) => readBounded(() => c.getTransaction({ hash: h }).then((x) => ({ hash: x.hash, from: x.from, to: x.to, input: x.input, nonce: x.nonce, value: x.value, chainId: x.chainId })).catch((e) => (/not be found|NotFound|could not be found/i.test(String(e)) ? null : Promise.reject(e)))),
        receipt: (h) => readBounded(() => c.getTransactionReceipt({ hash: h }).then((x) => ({ transactionHash: x.transactionHash, blockHash: x.blockHash, blockNumber: x.blockNumber, status: x.status, logs: x.logs as { address: Address; topics: Hex[]; data: Hex }[] })).catch((e) => (/not be found|NotFound|could not be found/i.test(String(e)) ? null : Promise.reject(e)))),
        block: (n) => readBounded(() => c.getBlock({ blockNumber: n }).then((b) => ({ hash: b.hash as Hash, number: b.number })).catch(() => null)),
        blockNumber: () => readBounded(() => c.getBlockNumber()),
      },
      locks: locks === "held" ? { request: (_n, fn) => fn() } : typeof navigator !== "undefined" && navigator.locks ? { request: (name, fn) => navigator.locks.request(name, { ifAvailable: true }, async (lock) => { if (!lock) throw new Error("another tab is launching or listing with this wallet."); return fn(); }) as ReturnType<typeof fn> } : undefined,
    });
  };

  /** Settles the record against the chain, reads only: the receipt, the coin, or the fact that the answer is still missing. */
  async function reconcile(): Promise<void> {
    const f = flowFor("own");
    if (!f) return;
    let v: LaunchIntent | undefined;
    try {
      v = f.load();
    } catch (e) {
      setBlockedNote(errorMessage(e));
      return;
    }
    setBlockedNote("");
    if (!v) {
      setPendingLaunch(undefined);
      setPendingNote("");
      return;
    }
    if (v.status === "prepared") {
      setPendingLaunch(v);
      setPendingNote("the wallet's answer to your launch was lost. if the wallet shows the transaction, paste its hash; it is matched against exactly what was reviewed. nothing is sent again.");
      return;
    }
    if (v.status === "launched" && v.token) {
      setPendingLaunch(undefined);
      launchedToken.current = v.token;
      setActivating({ token: v.token, isTicker: v.isTicker, hash: v.hash });
      return;
    }
    if (v.status === "reverted") {
      setPendingLaunch(v);
      setPendingNote("your launch reverted on chain; only gas was spent. you can start a new one.");
      return;
    }
    try {
      const r = await f.settle();
      if (r.state === "launched" && r.record.token) {
        setPendingLaunch(undefined);
        setPendingNote("");
        launchedToken.current = r.record.token;
        setActivating({ token: r.record.token, isTicker: r.record.isTicker, hash: r.record.hash });
        return;
      }
      setPendingLaunch(r.record);
      setPendingNote(
        r.state === "waiting"
          ? "your launch is not visible on chain under its hash yet. if the wallet repriced it, paste the new hash; it is matched against exactly what was reviewed. reads continue; nothing is resent."
          : r.state === "pending"
            ? "your launch is pending on chain. reads continue; nothing is resent."
            : r.state === "confirming"
              ? "your launch is in a block; waiting for one more."
              : "your launch reverted on chain; only gas was spent. you can start a new one.",
      );
    } catch (e) {
      setPendingLaunch(v);
      setPendingNote(`the chain could not be read for your launch (${errorMessage(e)}). reads are retried; nothing is resent.`);
    }
  }

  /** The hash the wallet shows for a launch whose answer was lost: accepted only as the reviewed transaction. */
  async function recoverLaunch(input: string): Promise<void> {
    const f = flowFor("own");
    if (!f) return;
    try {
      await f.recover(input);
      await reconcile();
    } catch (e) {
      setPendingNote(errorMessage(e));
    }
  }

  /** A reverted launch, read as such, is cleared so the next one can start; nothing unsettled ever is. */
  async function clearSettled() {
    const f = flowFor("own");
    if (!f) return;
    try {
      await f.clear();
    } catch (e) {
      setPendingNote(errorMessage(e));
      return;
    }
    setPendingLaunch(undefined);
    setPendingNote("");
    setSeed(randomSalt());
  }

  // on mount, and when the wallet or chain changes: the record is settled before anything is offered
  useEffect(() => {
    if (!user || !client || DEMO) return;
    const t = setTimeout(() => void reconcile(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, chainId, client]);

  /** Builds the exact call a launch makes, once, so the pre-flight and the signature cannot disagree. */
  async function prepare(useSeed: Hex = seed): Promise<Prepared> {
    if (!client) throw new Error("no client");
    const fee = launchFee.data ?? 0n;
    const ground = await vanityFor(useSeed); // the same promise the review step shows, so the address cannot differ
    const salt = ground?.salt ?? useSeed;
    // the deployer's own prediction must agree with the page's, or the site's copy of the bytecode has drifted
    if (ground && user && config.data && !DEMO) {
      const predicted = await client.readContract({
        abi: LaunchDeployerAbi,
        address: ADDRESSES.launchDeployer,
        functionName: "predictToken",
        args: [user, { name: name.trim(), symbol: symbol.trim(), logo: logo.trim(), description: description.trim(), socials: { ...socials }, creatorFeeRecipient: (feeWallet || user) as Address, creatorTaxBps: taxBps, buybackEnabled: false, expectedEconomics: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex, salt }, config.data.supply],
      });
      if (!sameAddr(predicted, ground.address)) throw new Error("the address preview does not match the deployer. reload the page and try again.");
    }
    const creatorFeeRecipient = (feeWallet || user) as Address;
    const base = {
      name: name.trim(),
      symbol: symbol.trim(),
      logo: logo.trim(),
      description: description.trim(),
      socials: { ...socials },
      creatorFeeRecipient,
      creatorTaxBps: taxBps,
      buybackEnabled: false,
      expectedEconomics: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
      salt,
    };
    // the pool opens a tick or two above the opening price; a first buy allows one percent for that
    const minOut = firstBuyPreview ? applySlippage(firstBuyPreview.tokensOut, 100) : 0n;
    if (tab === "diy") {
      // read the terms right before sending, so a stale preview reverts instead of settling. the fee for a new
      // name is due only when the name does not exist yet
      const [, exists, expected] = await client.readContract({ abi: TickerLauncherAbi, address: ADDRESSES.tickerLauncher, functionName: "previewLaunch", args: [tickerSymbol, cfgId] });
      const p = { ...base, expectedEconomics: expected };
      const value = fee + (exists ? 0n : (newTickerFee.data ?? 0n));
      if (firstBuyAmt > 0n) {
        return {
          label: sharedOn ? "Launch and buy" : `Create ${tickerUp}, launch and buy`,
          approve: await approveIfNeeded(ADDRESSES.usdg, ADDRESSES.tickerLauncher, firstBuyAmt, usdgAsset?.symbol ?? "USDG"),
          request: { abi: TickerLauncherAbi, address: ADDRESSES.tickerLauncher, functionName: "launchAndBuy", args: [tickerSymbol, p, cfgId, firstBuyAmt, minOut], value },
          tokenIndex: 1,
        };
      }
      return {
        label: sharedOn ? "Launch" : `Create ${tickerUp} and launch`,
        request: { abi: TickerLauncherAbi, address: ADDRESSES.tickerLauncher, functionName: "launch", args: [tickerSymbol, p, cfgId], value },
        tokenIndex: 1,
      };
    }
    if (tab === "official") {
      const preview = await client.readContract({ abi: StockQuoteLauncherAbi, address: ADDRESSES.stockQuoteLauncher, functionName: "previewLaunch", args: [cfgId, official!] });
      const p = { ...base, expectedEconomics: preview[0] };
      if (firstBuyAmt > 0n) {
        return {
          label: "Launch and buy",
          approve: await approveIfNeeded(official!, ADDRESSES.stockQuoteLauncher, firstBuyAmt, selectedStock?.ticker ?? "the Stock Token"),
          request: { abi: StockQuoteLauncherAbi, address: ADDRESSES.stockQuoteLauncher, functionName: "launchWithStockQuoteAndBuy", args: [p, cfgId, official!, firstBuyAmt, minOut], value: fee },
          tokenIndex: 0,
        };
      }
      return {
        label: "Launch",
        request: { abi: StockQuoteLauncherAbi, address: ADDRESSES.stockQuoteLauncher, functionName: "launchWithStockQuote", args: [p, cfgId, official!], value: fee },
        tokenIndex: 0,
      };
    }
    if (tab === "coin") {
      const preview = await client.readContract({ abi: CoinQuoteLauncherAbi, address: ADDRESSES.coinQuoteLauncher, functionName: "previewLaunch", args: [cfgId, quoteCoin!] });
      const p = { ...base, expectedEconomics: preview[0] };
      if (firstBuyAmt > 0n) {
        return {
          label: "Launch and buy",
          approve: await approveIfNeeded(quoteCoin!, ADDRESSES.coinQuoteLauncher, firstBuyAmt, selectedCoin?.symbol ?? "the quote coin"),
          request: { abi: CoinQuoteLauncherAbi, address: ADDRESSES.coinQuoteLauncher, functionName: "launchWithCoinQuoteAndBuy", args: [p, cfgId, quoteCoin!, firstBuyAmt, minOut], value: fee },
          tokenIndex: 0,
        };
      }
      return {
        label: "Launch",
        request: { abi: CoinQuoteLauncherAbi, address: ADDRESSES.coinQuoteLauncher, functionName: "launchWithCoinQuote", args: [p, cfgId, quoteCoin!], value: fee },
        tokenIndex: 0,
      };
    }
    if (tab === "market") {
      const preview = await client.readContract({ abi: MarketQuoteLauncherAbi, address: ADDRESSES.marketQuoteLauncher, functionName: "previewLaunch", args: [cfgId, marketToken!] });
      const p = { ...base, expectedEconomics: preview[0] };
      if (firstBuyAmt > 0n) {
        return {
          label: "Launch and buy",
          approve: await approveIfNeeded(marketToken!, ADDRESSES.marketQuoteLauncher, firstBuyAmt, selectedMarket?.symbol ?? "the token"),
          request: { abi: MarketQuoteLauncherAbi, address: ADDRESSES.marketQuoteLauncher, functionName: "launchWithMarketQuoteAndBuy", args: [p, cfgId, marketToken!, firstBuyAmt, minOut], value: fee },
          tokenIndex: 0,
        };
      }
      return {
        label: "Launch",
        request: { abi: MarketQuoteLauncherAbi, address: ADDRESSES.marketQuoteLauncher, functionName: "launchWithMarketQuote", args: [p, cfgId, marketToken!], value: fee },
        tokenIndex: 0,
      };
    }
    const pair = pairToken!;
    const expected = await client.readContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "previewLaunchEconomics", args: [cfgId, pair] });
    const p = { ...base, expectedEconomics: expected };
    const recipient = user as Address;
    const approve = !isZero(pair) && firstBuyAmt > 0n ? await approveIfNeeded(pair, ADDRESSES.launchAndBuyRouter, firstBuyAmt, pairSymbol) : undefined;
    return {
      label: firstBuyAmt > 0n ? "Launch and buy" : "Launch",
      request: {
        abi: LaunchAndBuyRouterAbi,
        address: ADDRESSES.launchAndBuyRouter,
        functionName: "launchAndBuy",
        args: [p, cfgId, pair, firstBuyAmt, minOut, recipient],
        value: fee + (isZero(pair) ? firstBuyAmt : 0n),
      },
      approve,
      tokenIndex: 0,
    };
  }

  /** eth_call the launch as it would be sent. Nothing is signed; the answer is the contract's, not ours. */
  /**
   * Calls the launch exactly as it would be sent, with `eth_call`, before the wallet is ever opened. Nothing is
   * signed and nothing is shown: its only job is that a launch the contract would reject never reaches a
   * signing prompt as an unreadable wallet error. The sender's balance is overridden, because the question is
   * whether the contract accepts the call, not whether this wallet can pay for it today.
   */
  async function preflight(useSeed: Hex = seed): Promise<Prepared | undefined> {
    if (!client) return undefined;
    const pr = await prepare(useSeed);
    if (DEMO || !user) return pr;
    const account = user;
    // a launch that pulls a token cannot be simulated until its approval has landed, so with an approve step pending
    // the approve is what gets checked; the launch is checked by the wallet once the allowance exists
    const req = (pr.approve ? pr.approve.request : pr.request) as unknown as Parameters<typeof client.simulateContract>[0];
    await client.simulateContract({
      ...req,
      abi: [...(req.abi as Abi), ...ERC20_ERRORS, ...KNOWN_ERRORS] as Abi, // so token errors decode by name
      account,
      stateOverride: [{ address: account, balance: parseEther("1000") }],
    });
    return pr;
  }

  const isSquat = (e: unknown) => /PoolAlreadyExists|PoolAlreadyInitialized/.test(String(e ?? ""));
  // the closed gate, in words: until the first launch, and whenever the owner closes launching, nobody can launch
  const plainRevert = (e: unknown) =>
    /NotWhitelisted|LaunchDisabled|LaunchesClosed/.test(errorMessage(e) + String(e ?? ""))
      ? "launches are not open on this deployment yet. the first launch opens them, and then anyone can launch."
      : errorMessage(e);
  /** The retry carries the new seed explicitly: state set in this render is not visible to this call. */
  function retryWithFreshSalt(): Promise<boolean> {
    retriedSquat.current = true;
    const fresh = randomSalt();
    setSeed(fresh);
    return submit(fresh);
  }

  async function submit(useSeed: Hex = seed): Promise<boolean> {
    const err = validate();
    setFormError(err);
    if (err || !user || !client) return false;
    try {
      // the wallet only signs what the contract has already accepted
      const pr = await preflight(useSeed);
      if (!pr) return false;
      // the record first, durably and under the wallet's lock, then the wallet: a reload or another tab finds the
      // record and settles it before offering anything new. the nonce is fixed the moment the launch is sent
      const ground = await (vanityFor(useSeed)?.catch(() => undefined) ?? Promise.resolve(undefined));
      const wallet = user;
      if (!wallet) return false;
      const c = client;
      const launchRequest = pr.request;
      const data = encodeFunctionData({ abi: launchRequest.abi as Abi, functionName: launchRequest.functionName, args: launchRequest.args as unknown[] });
      const outcome = await withLock(async () => {
        const f = flowFor("held");
        if (!f) throw new Error("no engine");
        const [latest, pending] = await Promise.all([readBounded(() => c.getTransactionCount({ address: wallet, blockTag: "latest" })), readBounded(() => c.getTransactionCount({ address: wallet, blockTag: "pending" }))]);
        if (latest !== pending) throw new Error("this wallet has a transaction pending. wait for it; nothing is sent on top of it.");
        await f.begin({ seed: useSeed, predicted: ground?.address, label: pr.label, isTicker: tab === "diy", tickerSymbol: tab === "diy" ? tickerUp : undefined, to: launchRequest.address, data, value: launchRequest.value.toString(), nonce: pending + (pr.approve ? 1 : 0) });
        try {
          window.localStorage.setItem("tickr.launch.seed.hint", useSeed);
        } catch {
          // the record above is what matters
        }
        // an approve lands first, under the same lock, then the launch is simulated with the allowance in place, then signed
        if (pr.approve) {
          const ok = await tx.run([{ label: pr.approve.label, request: (w: WriteFn) => w(pr.approve!.request) }]);
          if (!ok) {
            f.declined();
            return { kind: "declined" as const, failure: tx.lastError.current };
          }
          const req = launchRequest as unknown as Parameters<typeof c.simulateContract>[0];
          await c.simulateContract({ ...req, abi: [...(req.abi as Abi), ...ERC20_ERRORS, ...KNOWN_ERRORS] as Abi, account: wallet });
        }
        const hash = await tx.run([
          {
            label: pr.label,
            request: async (w: WriteFn) => {
              // the nonce right before the wallet opens: an approval may have moved it
              const n = await readBounded(() => c.getTransactionCount({ address: wallet, blockTag: "pending" }));
              f.amend({ nonce: n });
              return w({ ...(launchRequest as unknown as Parameters<WriteFn>[0]), nonce: n } as Parameters<WriteFn>[0]);
            },
            onHash: (h: Hash) => f.markSent(h),
            // a repricing is adopted only when it is the same request; otherwise the runner stops for review
            onReplaced: (r) => f.replaced({ hash: r.hash, from: r.from, to: r.to, input: r.input, nonce: r.nonce, value: r.value, chainId: r.chainId }),
          },
        ]);
        if (!hash) {
          const failure = tx.lastError.current;
          if (f.load()?.status === "sent") return { kind: "sent" as const };
          const msg = errorMessage(failure) + String(failure ?? "");
          const code = (failure as { code?: number; cause?: { code?: number } } | undefined)?.code ?? (failure as { cause?: { code?: number } } | undefined)?.cause?.code;
          if (code === 4001 || /User rejected|user rejected|rejected the request|denied transaction/i.test(msg)) {
            // the wallet says it declined before anything left it: the one definite decline
            f.declined();
            return { kind: "declined" as const, failure };
          }
          if (isSquat(failure) && !retriedSquat.current) {
            // the wallet reported the revert before broadcasting: nothing was sent, the address is taken
            f.declined();
            return { kind: "squat" as const };
          }
          return { kind: "unknown" as const };
        }
        const rc = tx.receipts.current.get(hash);
        const r = await f.settle(rc ? { transactionHash: rc.transactionHash, blockHash: rc.blockHash, blockNumber: rc.blockNumber, status: rc.status, logs: rc.logs as { address: Address; topics: Hex[]; data: Hex }[] } : undefined);
        return { kind: "settled" as const, r };
      });
      if (outcome.kind === "squat") return retryWithFreshSalt();
      if (outcome.kind === "declined") return false;
      if (outcome.kind === "sent" || outcome.kind === "unknown") {
        await reconcile();
        return false;
      }
      if (outcome.r.state !== "launched" || !outcome.r.record.token) {
        await reconcile();
        return false;
      }
      launchedToken.current = outcome.r.record.token;
      setActivating({ token: outcome.r.record.token, isTicker: tab === "diy", hash: outcome.r.record.hash });
      try {
        window.localStorage.removeItem("tickr.launch.seed.hint");
      } catch {
        // fine
      }
      setSeed(randomSalt());
      return true;
    } catch (e) {
      // somebody opened this exact pool key first: a fresh salt is a fresh address and a fresh key, once
      if (isSquat(e) && !retriedSquat.current) return retryWithFreshSalt();
      setFormError(plainRevert(e));
      return false;
    }
  }

  // ---- a shared link can name the pair: /create?tab=official&pair=0x…
  function resolveAddress(addr: string): boolean {
    if (!isAddress(addr)) return false;
    const done = (note: string) => {
      setPastedNote(note);
      setPasted("");
      return true;
    };
    const stock = stocks.assets.find((x) => sameAddr(x.address as Address, addr as Address));
    if (stock) {
      setTab("official");
      setOfficial(stock.address as Address);
      setChoice("stocks");
      return done(`${stock.symbol} is a Stock Token in the Robinhood Assets registry: selected.`);
    }
    if (sameAddr(addr as Address, ADDRESSES.usdg)) {
      setTab("usdg");
      setChoice("usdg");
      return done("that is USDG: selected.");
    }
    const t = diyQuotes.find((x) => sameAddr(x.quoteToken, addr as Address));
    if (t) {
      setTab("diy");
      setDiyMode("existing");
      setDiyQuote(t.quoteToken);
      setChoice("token");
      return done(`${t.ticker} is an invented name: selected.`);
    }
    const ct = chainTokens.find((x) => sameAddr(x.address, addr as Address));
    if (ct) {
      setTab("market");
      setMarketToken(ct.address);
      setChoice("token");
      return done(`${ct.symbol} has a market on the chain: selected.`);
    }
    const c = coins.find((x) => sameAddr(x.address, addr as Address));
    if (c) {
      setTab("coin");
      setQuoteCoin(c.address);
      setChoice("token");
      return done(`${c.symbol} is a tickr coin: selected.`);
    }
    return false;
  }
  // tickers and coins arrive async, so try the link's address again as each list lands
  const pairParam = params.get("pair");
  useEffect(() => {
    if (prefilled.current || !pairParam || !isAddress(pairParam)) return;
    if (resolveAddress(pairParam) || (!diyQuotesQ.isLoading && !coinsQ.isLoading)) prefilled.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairParam, diyQuotes.length, coins.length, diyQuotesQ.isLoading, coinsQ.isLoading]);


  // ---- the token list: coins launched here, invented names, Stock Tokens with a feed. figures come from the market data the home grid already reads.
  const market = useMarketData();
  const marketRows = useMemo(() => market.data?.rows ?? [], [market.data]);
  const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const pickItems: PickItem[] = useMemo(() => {
    const out: PickItem[] = [];
    const coins = coinsQ.data ?? [];
    const diyQuotes = diyQuotesQ.data ?? [];
    for (const t of chainTokens) {
      out.push({ kind: "market", address: t.address, symbol: t.symbol, name: t.name, logo: t.logo, figure: t.marketCapUsd ? `${compact(t.marketCapUsd)}` : undefined, figureNote: `${compact(t.depthEth)} ETH depth`, tags: t.venues, weight: t.depthEth });
    }
    for (const c of coins) {
      const r = marketRows.find((x) => sameAddr(x.launch.token, c.address));
      const mc = r?.marketCapUsd;
      out.push({ kind: "coin", address: c.address, symbol: c.symbol, name: c.name, logo: c.logo, figure: mc ? `${compact(mc)}` : undefined, figureNote: mc ? "market cap" : undefined, weight: mc ?? 0 });
    }
    for (const q of diyQuotes) {
      const under = marketRows.filter((x) => sameAddr(x.quote.address, q.quoteToken)).length;
      out.push({ kind: "name", address: q.quoteToken, symbol: q.ticker, name: "", figure: `${under} ${under === 1 ? "coin" : "coins"}`, figureNote: "priced in it, one USDG each", weight: under });
    }
    return out;
  }, [coinsQ.data, diyQuotesQ.data, marketRows, chainTokens]);
  const pickLoading = coinsQ.isLoading || diyQuotesQ.isLoading || chainQ.isLoading;
  const selectedPick: Address | undefined = choice !== "token" ? undefined : tab === "coin" ? quoteCoin : tab === "market" ? marketToken : tab === "diy" && diyMode === "existing" ? diyQuote : undefined;
  function pick(it: PickItem) {
    setChoice(it.kind === "stock" ? "stocks" : "token");
    setPasted("");
    setPastedNote(undefined);
    if (it.kind === "stock") {
      setTab("official");
      setOfficial(it.address);
    } else if (it.kind === "market") {
      setTab("market");
      setMarketToken(it.address);
    } else if (it.kind === "coin") {
      setTab("coin");
      setQuoteCoin(it.address);
    } else {
      setTab("diy");
      setDiyMode("existing");
      setDiyQuote(it.address);
    }
  }
  function choose(c: Choice) {
    setChoice(c);
    setPastedNote(undefined);
    if (c === "eth") setTab("eth");
    else if (c === "usdg") setTab("usdg");
    else if (c === "stocks") setTab("official");
    else if (c === "invent") {
      setTab("diy");
      setDiyMode("new");
    } else {
      // back to the list: keep whatever was picked before, else wait for a pick
      if (marketToken) setTab("market");
      else if (quoteCoin) setTab("coin");
      else if (diyQuote) {
        setTab("diy");
        setDiyMode("existing");
      } else setTab("coin");
    }
  }

  const upd = <K extends keyof typeof diy>(k: K, v: (typeof diy)[K]) => setDiy((s) => ({ ...s, [k]: v }));
  const launchLabel = tab === "diy" && !sharedOn ? (firstBuyAmt > 0n ? "Create ticker, launch and buy" : "Create ticker and launch") : firstBuyAmt > 0n ? "Launch and buy" : "Launch";
  // A ticker is minted once. If it already exists, the creator joins it instead of minting another.
  const takenBy = useReadContract({
    abi: TickerLauncherAbi,
    address: ADDRESSES.tickerLauncher,
    functionName: "tickerFor",
    args: [tickerUp],
    query: { enabled: diyOn && diyMode === "new" && tickerUp.length > 0 },
  });
  const tickerTaken = !!takenBy.data && !isZero(takenBy.data);
  // The registry reserves every anchor ticker (ETH, USDG, each official Stock Token), so an invented ticker cannot imitate one.
  const reservedTicker = useReadContract({
    abi: AnchorRegistryAbi,
    address: ADDRESSES.anchorRegistry,
    functionName: "isReservedTicker",
    args: [tickerUp],
    query: { enabled: tab === "diy" && tickerUp.length > 0 && !isZero(ADDRESSES.anchorRegistry) },
  });
  // The coin's own symbol and name cannot imitate an anchor either: the factory refuses them at launch, so say so here
  const coinSymbolUp = symbol.trim().toUpperCase();
  const reservedSymbol = useReadContract({
    abi: AnchorRegistryAbi,
    address: ADDRESSES.anchorRegistry,
    functionName: "isReservedTicker",
    args: [coinSymbolUp],
    query: { enabled: coinSymbolUp.length > 0 && !isZero(ADDRESSES.anchorRegistry) },
  });
  const reservedName = useReadContract({
    abi: AnchorRegistryAbi,
    address: ADDRESSES.anchorRegistry,
    functionName: "isReservedName",
    args: [name.trim()],
    query: { enabled: name.trim().length > 0 && !isZero(ADDRESSES.anchorRegistry) },
  });
  const symbolState: "checking" | "available" | "reserved" | undefined =
    coinSymbolUp.length === 0 ? undefined : reservedSymbol.data === true ? "reserved" : reservedSymbol.isFetching ? "checking" : "available";
  const nameReserved = reservedName.data === true;

  // The quote token carries the ticker itself, so the pair reads TEST/YOURTICKER on any explorer.
  const quoteSymbol = tickerUp;
  const quoteTicker =
    tab === "diy"
      ? sharedOn
        ? (selectedDiyQuote?.ticker ?? "")
        : tickerUp
      : tab === "coin"
        ? (selectedCoin?.symbol ?? "")
        : tab === "market"
          ? (selectedMarket?.symbol ?? "")
        : tab === "official"
          ? (selectedStock?.ticker ?? "")
          : pairSymbol === "-"
            ? ""
            : pairSymbol;
  const coinTicker = symbol.trim().toUpperCase();
  // The pair everyone will see on a chart.
  const pairLeft = coinTicker || "YOURCOIN";
  const pairRight = quoteTicker || (tab === "diy" ? example : "QUOTE");
  const canAdvance = step === 0 ? (tab === "diy" ? (sharedOn ? !!diyQuote : tickerUp.length > 0 && reservedTicker.data !== true && !tickerTaken) : tab === "coin" ? !!quoteCoin : tab === "market" ? !!marketToken : tab === "official" ? !!official : true) : !!name.trim() && !!symbol.trim() && !!logo.trim() && !!description.trim();

  const STEP_LABELS = ["Pair", "Coin", "Review"];

  const tickerState: "checking" | "available" | "taken" | "reserved" =
    reservedTicker.data === true ? "reserved" : tickerTaken ? "taken" : reservedTicker.isFetching || takenBy.isFetching ? "checking" : "available";

  const seedLine: string | undefined = inventing && tickerUp.length > 0 && newTickerFee.data ? `${fmtAmount(newTickerFee.data, 18)} eth of it opens ${tickerUp}'s dollar pool` : undefined;
  const targetLabel = "opening cap";
  const targetValue = econ ? `${fmtAmount(econ.phantom, econ.decimals, { sig: 4 })} ${econ.symbol}` : "-";

  const preview = (
    <aside className="preview-card lg:sticky lg:top-28 mt-12 lg:mt-0">
      <RainbowRule className="mb-4" />
      <div className="pv-eyebrow">preview</div>

      <div className="pv-pair num">
        {pairLeft}
        <span className="pv-slash">/</span>
        <span className="sw-yellow">{pairRight}</span>
      </div>
      {tab === "diy" && tickerUp.length > 0 && (
        <div className={`pv-avail ${sharedOn ? "shared" : tickerState}`}>
          {sharedOn ? "existing ticker, shared" : tickerState}
        </div>
      )}

      <div className="pv-cost">
        <span className="pv-k">you send</span>
        <span className="pv-amount num">
          {fmtAmount(valueTotal, 18)}
          <span className="pv-unit">eth</span>
        </span>
        {seedLine && <span className="pv-sub">{seedLine}</span>}
      </div>

      <dl className="pv-grid">
        <div>
          <dt>{targetLabel}</dt>
          <dd className="num">{targetValue}</dd>
          {usdNote && <span className="pv-note">{usdNote}</span>}
        </div>
        <div>
          <dt>pool fee</dt>
          <dd className="num">{config.data ? bpsToPct(poolFeeBps) : "-"}</dd>
          <span className="pv-note">{config.data ? (taxBps > 0 ? `${bpsToPct(baseFeeBps)} base + ${bpsToPct(taxBps)} you` : `${bpsToPct(baseFeeBps)} base`) : ""}</span>
        </div>
      </dl>
    </aside>
  );

  if (blockedNote) {
    return (
      <div className="max-w-2xl">
        <div className="mb-6">
          <h1>The last launch record cannot be read.</h1>
          <p className="text-muted mt-3">{blockedNote}</p>
        </div>
        <button type="button" className="btn" onClick={() => void reconcile()}>
          try reading it again
        </button>
      </div>
    );
  }
  if (pendingLaunch) {
    return (
      <div className="max-w-2xl">
        <div className="mb-6">
          <h1>A launch is not settled yet.</h1>
          <p className="text-muted mt-3">{pendingNote || "checking your last launch against the chain, reads only."}</p>
        </div>
        <div className="activate">
          <div className="label">your launch</div>
          <div className="mt-3 text-[14px] space-y-2">
            <div>{pendingLaunch.label}</div>
            {pendingLaunch.hash && (
              <div className="num">
                <a href={explorerTx(pendingLaunch.hash)} target="_blank" rel="noreferrer">
                  {pendingLaunch.hash}
                </a>
              </div>
            )}
            {pendingLaunch.predicted && <div className="text-muted num">coin address {pendingLaunch.predicted}</div>}
          </div>
          <div className="flex flex-wrap items-center gap-3 mt-5">
            {pendingLaunch.status !== "prepared" && pendingLaunch.status !== "reverted" && (
              <button type="button" className="btn btn-primary" onClick={() => void reconcile()}>
                check again, no spending
              </button>
            )}
            {(pendingLaunch.status === "prepared" || pendingLaunch.status === "sent") && (
              <>
                <input className="input num" style={{ minWidth: 340 }} value={recoverHash} placeholder="0x… the transaction hash the wallet shows, never a key" onChange={(e) => setRecoverHash(e.target.value)} aria-label="launch transaction hash" />
                <button type="button" className="btn btn-primary" disabled={!recoverHash} onClick={() => void recoverLaunch(recoverHash)}>
                  match this hash
                </button>
                <span className="text-muted text-[13px]">only the transaction that was reviewed is accepted, under its first hash or the one the wallet repriced it to. if the wallet shows nothing at all, the record waits until it does.</span>
              </>
            )}
            {pendingLaunch.status === "reverted" && (
              <button type="button" className="btn btn-primary" onClick={() => void clearSettled()}>
                start a new launch
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (activating) {
    if (!activating.isTicker) {
      return (
        <div className="max-w-2xl">
          <div className="mb-6">
            <h1>Launched.</h1>
            <p className="text-muted mt-3">your coin is live and trades on tickr now.</p>
          </div>
          <div className="activate" data-state="done">
            <div className="label">your coin</div>
            <div className="mt-3 text-[14px] space-y-2">
              <div className="num">{activating.token}</div>
              {activating.hash && (
                <div className="num">
                  <a href={explorerTx(activating.hash)} target="_blank" rel="noreferrer">
                    launch transaction
                  </a>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 mt-5">
              <Link href={`/t/${activating.token}`} className="btn btn-primary no-underline" onClick={() => void flowFor("own")?.clear().catch(() => undefined)}>
                open your coin
              </Link>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void flowFor("own")?.clear().catch(() => undefined);
                  setActivating(undefined);
                }}
              >
                launch another
              </button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="max-w-2xl">
        <div className="mb-6">
          <h1>Launched. One last step.</h1>
          <p className="text-muted mt-3">
            Your coin is live and trades on tickr now. Chart sites and trackers price it only after the two small buys below land, in transactions after the launch,
            from the wallet that launched.{" "}
            {activating.hash && (
              <a href={explorerTx(activating.hash)} target="_blank" rel="noreferrer">
                launch transaction
              </a>
            )}
          </p>
        </div>
        <ActivateCard token={activating.token} title="list your coin" onDone={() => void flowFor("own")?.clear().catch(() => undefined)} />
      </div>
    );
  }

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-14 lg:items-start">
      <div className="min-w-0">
      <div ref={stepTrack} className="glide-track flex gap-1 mb-12">
        <GlideIndicator indRef={stepInd} />
        {STEP_LABELS.map((label, i) => (
          <button
            key={label}
            type="button"
            className="tab glide-item"
            data-active={step === i}
            data-glide-active={step === i}
            onClick={() => i <= step && setStep(i)}
            disabled={i > step}
          >
            <span className={`num mr-2 ${["sw-yellow", "sw-blue", "sw-pink"][i]}`}>{i + 1}</span>
            {label}
          </button>
        ))}
      </div>

      {step === 0 && (
        <div className="view-fade">
          <div className="pair-choose">
            <div className="label label-muted mb-3">what your coin is priced in</div>
            <div ref={tabTrack} className="glide-track flex flex-wrap">
              <GlideIndicator indRef={tabInd} />
              {CHOICES.filter((c) => c.id !== "token" || !isZero(ADDRESSES.marketQuoteLauncher) || coinsQ.data?.length || diyQuotesQ.data?.length).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`tab glide-item ${c.hero ? "tab-hero" : ""} ${c.keepCase ? "keep-case" : ""}`}
                  data-active={choice === c.id}
                  data-glide-active={choice === c.id}
                  onClick={() => choose(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {choice === "eth" && (
            <div className="quote-card">
              <div className="flex items-center gap-2">
                <span className="num font-semibold text-white text-[17px]">ETH</span>
                <span className="qp-kind">native</span>
              </div>
              <p className="text-muted mt-2">
                your coin opens at a <span className="num text-white">{targetValue}</span> market cap{usdNote ? `, ${usdNote}` : ""}. the whole supply sits in a pool against <span className="cap">ETH</span>, and every fee it earns is paid in <span className="cap">ETH</span>.
              </p>
            </div>
          )}

          {choice === "usdg" && (
            <>
              {usdgAsset && !usdgAsset.approved && <div className="text-muted">Not currently approved as a pair token.</div>}
              {!isZero(ADDRESSES.usdg) && <PairCard address={ADDRESSES.usdg} />}
            </>
          )}

          {choice === "token" && (
            <>
              <RainbowRule className="mb-4" />
              <h2>pick a token</h2>
              <div className="mt-6">
                <QuotePicker
                  items={pickItems}
                  loading={pickLoading}
                  selected={selectedPick}
                  onSelect={pick}
                  onAddress={(v) => {
                    setPasted(v);
                    setPastedNote(undefined);
                    if (!resolveAddress(v))
                      setPastedNote("this address is not a quote asset on tickr. a coin can be priced in ETH, USDG, a Stock Token from the Robinhood Assets registry, any token with a market, a tickr coin, or a name you invent. here is what it is:");
                  }}
                />
              </div>
              {pastedNote && <p className="text-[13px] text-muted mt-3">{pastedNote}</p>}
              {isAddress(pasted) && !selectedPick && <PairCard address={pasted as Address} />}
              {selectedPick && <PairCard address={selectedPick} />}
              {tab === "coin" && isZero(ADDRESSES.coinQuoteLauncher) && quoteCoin && <Notice kind="warn">Coin-quoted launches are not available on this deployment.</Notice>}
              {tab === "market" && !DEMO && isZero(ADDRESSES.marketQuoteLauncher) && marketToken && <Notice kind="warn">Launches priced in a chain token are not available on this deployment.</Notice>}
              {tab === "market" && selectedMarket && (
                <p className="text-[13px] text-muted mt-3">
                  priced from its {selectedMarket.counter} pool on Uniswap v3, {compact(selectedMarket.depthEth)} ETH deep, at the moment you launch.
                </p>
              )}
            </>
          )}

          {choice === "stocks" && (
            <>
              <RainbowRule className="mb-4" />
              <h2>pick a Stock Token</h2>
              <div className="mt-7">
                {stocksQ.isLoading || assets.isLoading ? (
                  <div className="text-muted">Loading Stock Tokens…</div>
                ) : officials.length === 0 ? (
                  <div className="text-muted">
                    No <span className="cap">Stock Tokens</span> are registered on this deployment yet.
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-3 mb-4">
                      <OfficialBadge />
                      <span className="text-dim text-[13px]">
                        issued by <span className="cap">Robinhood Assets</span>. a Stock Token needs a published price feed to size the opening market cap.{" "}
                        {officials.filter((o) => o.priceUsd !== undefined).length} of {officials.length} have one today.
                      </span>
                    </div>
                    <div className={`grid sm:grid-cols-2 lg:grid-cols-3 gap-3 ${official ? "dim-group" : ""}`}>
                      {officials.map((o) => (
                        <button
                          key={o.address}
                          type="button"
                          disabled={o.priceUsd === undefined}
                          title={o.priceUsd === undefined ? "no price feed published for this asset yet" : undefined}
                          onClick={() => {
                            setTab("official");
                            setOfficial(o.address);
                          }}
                          className="row-card px-4 py-3 text-left flex items-center justify-between gap-3 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                          data-selected={sameAddr(official, o.address)}
                          data-picked={sameAddr(official, o.address)}
                        >
                          <span className="flex items-center gap-2.5 min-w-0">
                            <StockLogo ticker={o.ticker} />
                            <span className="font-semibold num">{o.ticker}</span>
                          </span>
                          <span className="num text-dim text-[13px]">
                            {o.priceUsd === undefined ? "no feed" : `$${o.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {official && <PairCard address={official} />}
            </>
          )}

          {choice === "invent" && (
            <>
              <RainbowRule className="mb-4" />
              <h2>invent a quote asset</h2>
              <p className="text-muted mt-3">
                name the asset your coin is priced in. the pair reads{" "}
                <span className="num text-white">
                  {pairLeft}/<span className="sw-yellow">{tickerUp || example}</span>
                </span>
                .
              </p>
              <div className="ticker-field mt-6">
                <input
                  className="num ticker-input"
                  value={diy.anchorTicker}
                  onChange={(e) => upd("anchorTicker", e.target.value.toUpperCase())}
                  placeholder={example}
                  maxLength={12}
                  autoFocus
                />
                {tickerUp.length > 0 && (
                  <span className={`avail-chip ${tickerState}`} aria-live="polite">
                    {tickerState === "checking" ? "checking" : tickerState === "available" ? "available" : tickerState === "taken" ? "taken" : "reserved"}
                  </span>
                )}
              </div>
              {tickerTaken && (
                <p className="text-[13px] text-signal mt-3">
                  <span className="num">{tickerUp}</span> already exists.{" "}
                  <button
                    type="button"
                    className="underline hover:text-white"
                    onClick={() => {
                      setDiyQuote(takenBy.data as Address);
                      setDiyMode("existing");
                      setChoice("token");
                    }}
                  >
                    Use it instead
                  </button>{" "}
                  and your coin is priced in the one everyone already trades.
                </p>
              )}
              {reservedTicker.data === true && (
                <p className="text-[13px] text-signal mt-3">
                  <span className="num">{tickerUp}</span> is an anchor ticker on <span className="cap">Robinhood Chain</span>, so it cannot be an invented name. Pick another.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="view-fade">
          <RainbowRule className="mb-4" />
          <h2>Name your coin</h2>
          <p className="text-muted mt-3">the ticker and name are written into the contract and cannot be changed. the whole supply goes into the pool, locked.</p>
          <div className="mt-5 text-[15px]">
            <span className="label label-muted mr-3">pair</span>
            <span className="num text-white text-[17px]">
              {pairLeft}/<span className="sw-yellow">{pairRight}</span>
            </span>
          </div>
          {/* the ticker leads: it is what the pair reads and what people type, the name is the label under it */}
          <div className="grid sm:grid-cols-2 gap-5 mt-7">
            <Field label="Ticker">
              <div className="ticker-field">
                <input className="num" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="STAND" maxLength={16} autoFocus />
                {symbolState && (
                  <span className={`avail-chip ${symbolState}`} aria-live="polite">
                    {symbolState}
                  </span>
                )}
              </div>
            </Field>
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Banana Stand" maxLength={64} />
            </Field>
          </div>
          {reservedSymbol.data === true && (
            <p className="text-[13px] text-signal mt-3">
              <span className="num">{coinSymbolUp}</span> is an anchor ticker on <span className="cap">Robinhood Chain</span>. the factory refuses it, so pick another.
            </p>
          )}
          {nameReserved && (
            <p className="text-[13px] text-signal mt-3">
              &quot;{name.trim()}&quot; is the name of an official asset. the factory refuses it, so pick another.
            </p>
          )}
          <div className="mt-5">
            <LogoPicker value={logo} onChange={setLogo} />
          </div>
          <div className="mt-5">
            <Field label="Description" hint={`shown on the coin's page and stored with the coin. ${description.length.toLocaleString()} of 1,000 characters.`}>
              <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} placeholder="what this coin is, in a sentence or two." />
            </Field>
          </div>
          <div className="mt-7">
            <Collapse label="Social links (optional)" defaultOpen>
              <div className="grid sm:grid-cols-3 gap-5">
                {SOCIAL_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label}>
                    <input value={socials[f.key]} onChange={(e) => setSocials((v) => ({ ...v, [f.key]: e.target.value }))} placeholder={f.placeholder} inputMode="url" />
                  </Field>
                ))}
              </div>
              <p className="text-[13px] text-dim mt-3">full links. they are stored with the coin and cannot be changed later.</p>
            </Collapse>
          </div>
          <div className="module mt-8">
            <div className="label label-muted">creator tax, your cut of every trade</div>
            <div className="flex items-center gap-5 mt-4">
              <input
                type="range"
                className="tax-range"
                min={0}
                max={maxTaxBps}
                step={10}
                value={Math.min(taxBps, maxTaxBps)}
                onChange={(e) => setCreatorTax((Number(e.target.value) / 100).toFixed(1))}
                aria-label="creator tax percent"
              />
              <span className="num text-white text-[22px] font-semibold w-20 text-right">{bpsToPct(taxBps)}</span>
            </div>
            <p className="text-[13px] text-dim mt-3">
              on top of the {bpsToPct(baseFeeBps)} base fee, and part of the pool fee itself, so every venue charges it. set once at launch. up to {bpsToPct(maxTaxBps)}.
            </p>
          </div>

          {firstBuyReady && (
            <div className="module mt-8">
              <div className="flex items-center justify-between gap-3">
                <div className="label label-muted">dev buy</div>
                <div className="flex gap-1">
                  {(["coins", "spend"] as const).map((m) => (
                    <button key={m} type="button" className="tab" data-active={(devMode === "tokens" ? "coins" : "spend") === m} onClick={() => setDevMode(m === "coins" ? "tokens" : "spend")}>
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <div className="dev-row mt-3">
                {devMode === "tokens" ? (
                  <input
                    className="num"
                    inputMode="numeric"
                    value={devTokens}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9]/g, "");
                      setDevTokens(v);
                      setFirstBuy(v ? quoteForTokens(safeParseUnits(v, 18) ?? 0n) : "");
                    }}
                    placeholder="50000000"
                  />
                ) : (
                  <input className="num" inputMode="decimal" value={firstBuy} onChange={(e) => setFirstBuy(e.target.value)} placeholder="0.0" />
                )}
                <span className="dev-unit num">{devMode === "tokens" ? symbol || "coins" : firstBuySymbol}</span>
                {devShare !== undefined && <span className="dev-unit num text-white">{devShare}% of supply</span>}
              </div>
              {econ && (
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <span className="text-[12px] text-dim mr-1">of supply</span>
                  {SHARE_CHIPS.map((bps) => (
                    <button
                      key={bps}
                      type="button"
                      className="pct-chip"
                      onClick={() => {
                        setDevTokens(formatUnits((econ.supply * BigInt(bps)) / 10_000n, 18).replace(/\..*$/, ""));
                        setFirstBuy(quoteForShare(bps));
                      }}
                      title={`buy ${bps / 100}% of the supply in the launch transaction`}
                    >
                      {bps / 100}%
                    </button>
                  ))}
                </div>
              )}
              <p className="text-[13px] text-dim mt-3">bought inside the launch transaction itself, at the opening price. it pays no snipe tax; any other buy in the coin&apos;s first five seconds does, burned.</p>
              {firstBuyPreview && econ && firstBuyAmt > 0n && (
                <div className="text-[14px] text-muted mt-2">
                  {devMode === "tokens" ? (
                    <>
                      costs about <span className="num text-white">{fmtAmount(firstBuyAmt, firstBuyDecimals)}</span> {firstBuySymbol}, for about{" "}
                      <span className="num text-white">{fmtAmount(firstBuyPreview.tokensOut, 18)}</span> {symbol || "coins"}
                    </>
                  ) : (
                    <>
                      you would receive about <span className="num text-white">{fmtAmount(firstBuyPreview.tokensOut, 18)}</span> {symbol || "coins"}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="view-fade">
          <RainbowRule className="mb-4" />
          <h2>Review</h2>

          <div className="mt-6">
            <span className="label label-muted">the pair people will see</span>
            <div className="num mt-2 text-[clamp(26px,4.4vw,40px)] font-bold leading-none">
              {pairLeft}/<span className="sw-yellow">{pairRight}</span>
            </div>
          </div>

          <p className="text-muted mt-6">
            {tab === "diy" && sharedOn ? (
              <>
                <span className="num text-white">{symbol || "Your coin"}</span> priced in{" "}
                <span className="num text-white">{selectedDiyQuote?.ticker ?? "a shared ticker"}</span>, a ticker somebody
                already invented. Its dollar pool and its club are shared.
              </>
            ) : tab === "diy" ? (
              <>
                <span className="num text-white">{symbol || "Your coin"}</span> priced in{" "}
                <span className="num text-white">{quoteSymbol}</span>.
              </>
            ) : tab === "coin" ? (
              <>
                <span className="num text-white">{symbol || "Your coin"}</span> priced in{" "}
                <span className="num text-white">{selectedCoin?.symbol ?? "another coin"}</span>. Every buy of yours is a
                buy of theirs.
              </>
            ) : (
              <>
                <span className="num text-white">{symbol || "Your coin"}</span> priced in{" "}
                <span className="num text-white">{pairSymbol}</span>.
              </>
            )}
          </p>

          <div className="mt-7">
            <Row k="Launch fee" v={`${fmtAmount(launchFee.data, 18)} ETH`} />
            {inventing && <Row k={`New ticker fee, opens ${tickerUp || "the name"}'s dollar pool`} v={`${fmtAmount(newTickerFee.data, 18)} ETH`} />}
            <Row k="Supply" v={config.data ? fmtAmount(config.data.supply, 18, { sig: 3 }) : "-"} />
            <Row k="Opening market cap" v={econ ? `${fmtAmount(econ.phantom, econ.decimals, { sig: 4 })} ${econ.symbol}${usdNote ? `, ${usdNote}` : ""}` : "-"} />
            {tab === "official" && selectedStock?.priceUsd !== undefined && (
              <Row
                k={
                  <span className="inline-flex items-center gap-2">
                    <StockLogo ticker={selectedStock.ticker} size={18} />
                    {selectedStock.ticker} price
                  </span>
                }
                v={`$${selectedStock.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
              />
            )}
            <Row k="Pool fee" v={config.data ? `${bpsToPct(baseFeeBps)} base + ${bpsToPct(taxBps)} you = ${bpsToPct(poolFeeBps)}` : "-"} />
            {split && <Row k="The base fee splits" v={splitLabel(split).replace("% creator", "% you")} />}
            {quoteTicker && <Row k="Fees paid in" v={quoteTicker} />}
            {firstBuyAmt > 0n && <Row k="First buy" v={`${fmtAmount(firstBuyAmt, firstBuyDecimals)} ${firstBuySymbol}`} />}
            {firstBuyPreview && <Row k="You would receive about" v={`${fmtAmount(firstBuyPreview.tokensOut, 18)} ${symbol || "tokens"}`} />}
            <Row k="Creator tax" v={bpsToPct(taxBps)} />
          </div>

          {tab === "diy" && !sharedOn && (
            <div className="mt-8">
              <div className="label mb-2">What {quoteSymbol || "the ticker you pair against"} is</div>
              <div className="flex h-[3px] overflow-hidden rounded-full">
                {TICKER_ALLOCATION.map((sp) => (
                  <div key={sp.label} style={{ width: `${sp.bps / 100}%` }} className="bg-green" title={sp.label} />
                ))}
              </div>
              <div className="text-[13px] text-muted mt-2">
                {TICKER_ALLOCATION.map((sp) => (
                  <span key={sp.label}>
                    <span className="num text-white">{sp.bps / 100}%</span> {sp.label}.
                  </span>
                ))}
              </div>
              <div className="text-[13px] text-dim mt-2">{firstBuyAmt > 0n ? `Your coin: the whole supply into its pool, locked. Your first buy of ${fmtAmount(firstBuyAmt, firstBuyDecimals)} ${firstBuySymbol} then buys from it, in the same transaction.` : "Your coin: the whole supply into its pool, locked. You hold none of it at creation."}</div>
            </div>
          )}

          <div className="mt-10">
            <Collapse label="Advanced">
              <div className="adv">
                <Field label="Creator wallet" hint="receives creator fees and the creator tax. leave blank to use your connected wallet.">
                  <input className="num" value={feeWallet} onChange={(e) => setFeeWallet(e.target.value)} placeholder={user ?? "0x…"} />
                </Field>
                {configCount.data !== undefined && configCount.data > 1n && (
                  <Field label="Launch config">
                    <select value={configId} onChange={(e) => setConfigId(e.target.value)}>
                      {Array.from({ length: Number(configCount.data) }, (_, i) => (
                        <option key={i} value={i}>
                          #{i}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
            </Collapse>
          </div>

          {isZero(ADDRESSES.tickerLauncher) && tab === "diy" && (
            <div className="mt-4">
              <Notice kind="warn">The ticker launcher is not deployed; creating tickers is unavailable.</Notice>
            </div>
          )}
        </div>
      )}

      {/* the thing you came to do leads the row; going back is the secondary move and sits after it */}
      <div className="flex items-center gap-3 mt-12">
        {step < 2 ? (
          <button type="button" className="btn btn-cta" disabled={!canAdvance || (step === 1 && (reservedSymbol.data === true || nameReserved))} onClick={() => setStep(step + 1)}>
            Continue
          </button>
        ) : (
          <button
            className="btn btn-gradient"
            disabled={tx.busy || !user || !DEPLOYED || ceremony.phase !== "idle"}
            onClick={() => {
              const err = validate();
              setFormError(err);
              if (!err) ceremony.ask();
            }}
          >
            {tx.busy ? tx.step ?? "Working…" : launchLabel}
          </button>
        )}
        {step > 0 && (
          <button type="button" className="btn" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {step === 2 && !user && <span className="text-muted text-[14px]">Connect a wallet to launch.</span>}
      </div>


      {formError && (
        <div className="mt-4">
          <Notice kind="danger">{formError}</Notice>
        </div>
      )}
      <div className="mt-4">
        <TxStatus {...tx} />
      </div>

      <Ceremony
        phase={ceremony.phase}
        question="Launch this coin?"
        subject={symbol || name || "Untitled"}
        detail={
          (inventing
            ? `${tickerUp || "The ticker"} is created with its own dollar pool, then your coin's pool opens with the whole supply locked in it.`
            : "Your coin's pool opens with the whole supply locked in it.") +
          (firstBuyAmt > 0n
            ? ` Your first buy of ${fmtAmount(firstBuyAmt, firstBuyDecimals)} ${firstBuySymbol} then buys from the pool like anyone else, at the opening price.`
            : " You hold none of it at creation.")
        }
        confirmLabel={launchLabel}
        actingLabel="Launching"
        doneLabel="Launched"
        onCancel={ceremony.cancel}
        onConfirm={() =>
          ceremony.run(submit, () => {
            // the completion was set when the receipt was read; nothing to do here
          })
        }
      />
    </div>
      {preview}
    </div>
  );
}
