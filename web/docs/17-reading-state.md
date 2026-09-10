# 17 · Reading state

Everything about a coin is on chain and readable without tickr's own code. This page lists the reads.

## A launch

```solidity
struct LaunchedToken {
    address token;
    address deployer;
    address creatorFeeRecipient;
    address pairToken;      // address(0) = native ETH
    uint256 phantomQuote;   // the virtual quote reserve the pool opened with, raw units of the pair
    uint24 poolFee;         // LP fee in pips: (base + creator tax) * 100, so 10000 for 1%
    int24 tickSpacing;      // 10
    int24 tickLower;
    int24 tickUpper;
    uint128 liquidity;
    uint256 lpTokenId;      // the locked position, owned by LaunchLocker
    uint16 creatorTaxBps;
    bool buybackEnabled;
    uint64 launchedAt;
    bool exists;
}
function getLaunchedToken(address token) view returns (LaunchedToken);
function poolKeyOf(address token) view returns (PoolKey);
function poolIdOf(address token) view returns (bytes32);
function getLaunchFeePolicy(address token) view returns (FeePolicy);
function creatorFeeRecipientOf(address token) view returns (address);
function ctoProposals(address token) view returns (address newRecipient, uint256 effectiveAt, uint256 expiresAt); // an owner proposal to move the fee wallet, zero when none: public until effectiveAt, executable by anyone until expiresAt
function launchCount() view returns (uint256);
function launchAt(uint256 i) view returns (address);
function launchFee() view returns (uint256);           // 0.0005 ETH
function maxCreatorTaxBps() view returns (uint256);    // 200
```

## Pool key and price

The two currencies sorted by address, the fee from the launch record, tick spacing 10, hook zero. `poolKeyOf` and `poolIdOf` return them; to compute them yourself:

```ts
import { encodeAbiParameters, keccak256, zeroAddress } from "viem";
const [currency0, currency1] = BigInt(pairToken) < BigInt(token) ? [pairToken, token] : [token, pairToken];
const key = { currency0, currency1, fee: poolFee, tickSpacing: 10, hooks: zeroAddress };
const poolId = keccak256(encodeAbiParameters(
  [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
  [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
));
// spot price: slot0 lives at keccak256(abi.encode(poolId, uint256(6))) in the PoolManager
const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n]));
const word = await client.readContract({ address: POOL_MANAGER, abi: poolManagerAbi, functionName: "extsload", args: [slot] });
const sqrtPriceX96 = BigInt(word) & ((1n << 160n) - 1n);
// price of currency1 in currency0 = (sqrtPriceX96 / 2^96)^2, raw units
```

Market cap is that price times the supply of 1,000,000,000 coins, in the pair. The math behind the opening price is in [03 price and market cap](./03-curve-math.md).

## Fees owed

```solidity
// LaunchLocker
function pendingFees(address token) view returns (uint256 amount0, uint256 amount1); // in the pool's currency order
// FeeEscrow
function balanceOf(address recipient) view returns (uint256);                       // ETH
function balanceOfToken(address recipient, address token) view returns (uint256);   // any ERC-20
```

## Redeemable names

```solidity
// TickerLauncher
function tickerFor(string symbol) view returns (address);   // zero if not invented yet
function isTicker(address) view returns (bool);
function tickerCount() view returns (uint256);
function tickerAt(uint256 i) view returns (address);
function pairsOf(address ticker) view returns (address[]);
function captainOf(address ticker, uint256 epoch) view returns (address);   // counts double in that epoch's split: the founder's coin while it trades, else the top coin
function topOf(address ticker, uint256 epoch) view returns (address);       // the most booked volume under the ticker in the epoch
function NEW_TICKER_FEE() view returns (uint256);           // 0.0015 ETH
function INVENTORY_FLOOR() view returns (uint256);          // 10,000e6: the offer of every name's pool at rest
function predictTicker(string symbol) view returns (address); // where the name lives, invented or not
function poolKeyOf(address ticker) view returns (PoolKey);   // the name's own pool against USDG
// ManagedTickerToken: a one for one wrapper with its own pool
function counter() view returns (IERC20);                   // USDG
function mint(uint256 amount, address to);                  // only while the pool manager is locked, so not from inside a route
function redeem(uint256 amount, address to);
function poolKey() view returns (PoolKey);                  // WRAPPER/USDG, fee 500, spacing 1, hooks = ManagedTickerHook
function accounting() view returns (uint256 backing, uint256 circulation); // backing covers circulation, always
function circulatingSupply() view returns (uint256);        // what is out: totalSupply less the wrapper's own inventory
function usableBacking() view returns (uint256);            // backing less what the bridge position keeps
function inventoryCapacity() view returns (uint256);        // the most one buy through the pool can take: floor + 4 x circulation
function hook() view returns (address);
// ManagedTickerHook
function tokenOf(bytes32 poolId) view returns (address);     // the wrapper behind a pool, zero for any other pool
function issuer() view returns (address);                   // the ticker launcher
```

`totalSupply()` of a wrapper counts its own unsold inventory, which is neither owed to anyone nor backed until sold; read `circulatingSupply()` for what is out.

The club: `pot(ticker, epoch, coin)`, `volumeOf(coin, epoch)` (booked when the coin's fees are collected, as the quote fees collected divided by the pool fee rate: buy volume in the quote, in the epoch of the collection), `clubVolume(ticker, epoch)`, `claimable(member, payers, epoch)`, `claimClub(member, payers, epoch)`, `sweepDeadPot(coin, epoch)`, `currentEpoch()`; epochs are thirty days. See [05 redeemable names](./05-anchors.md).

## Which kind of name a quote asset is

Do not infer it from the token. Ask the registry, which answers by provenance: which issuer deployed the name.

```solidity
QuoteRegistry.kindOf(address name) returns (uint8)
// 0 unknown          neither issuer made it, or it predates the registry
// 1 redeemable       TickerLauncher: a one-for-one USDG wrapper, mint and redeem
// 2 fixed inventory  MarketTickerDeployer: 500,000,000 at 6 decimals, its own market, no redeem
```

`0` is not an error and must not be treated as one. FUN, the name TICKR is priced in, returns `0` because it
predates the registry, and everything on chain that reads this treats an unclassified name the way it always
did: as a redeemable wrapper, which is what FUN is. `TickerLauncher.isTicker(addr)` still answers the same
question for the redeemable kind alone and is what the site keys its pricing on today.

Pricing consequence worth knowing before you integrate: a redeemable name is worth one USDG by construction, so
you may price it at a dollar. A fixed-inventory name is worth whatever its own USDG pool says, so you must read
that pool. Pricing one at a dollar is wrong and will misreport every coin quoted in it.

## The coin itself

```solidity
// Token
function logo() view returns (string);
function description() view returns (string);
function socials() view returns (Socials);
function liquidityPool() view returns (bytes32);      // its pool id
function owner() view returns (address);              // always zero: there is no owner
function contractURI() view returns (string);         // ERC-7572 JSON, inline: name, symbol, description, image, links
function launchedAt() view returns (uint64);
function SNIPE_WINDOW() view returns (uint256);       // 5 seconds
function currentSnipeTaxBps(address recipient) view returns (uint256);   // the snipe tax a buy pays right now, zero for the launch's own wallets and after the window
function launchedBlock() view returns (uint64);
function protectionEndsAtBlock() view returns (uint256);          // the launch block plus three: the first block with no caps
function remainingBuy(address wallet) view returns (uint256);    // coins the wallet may still buy under the 5.5% cap; max when no cap applies, zero in the launch block
function remainingHold(address wallet) view returns (uint256);   // coins the wallet may still receive, bought or sent, under the 5% cap; same rules
// LaunchDeployer
function MAX_NAME() view returns (uint256);           // 64, then MAX_SYMBOL 16, MAX_LOGO 8192, MAX_DESCRIPTION 2048, MAX_SOCIAL 256
```

## Any token with a market

```solidity
// MarketQuoteLauncher
struct Market { address pool; address counter; uint24 fee; uint256 depth; uint256 inBand; }
function bestMarket(address quote) view returns (Market);   // reverts with the reason when there is none
function minDepth(address counter) view returns (uint256);  // the floor, total and within the band
function BAND_BPS() view returns (uint256);                 // 500
```

## The buyback treasury

```solidity
// BuybackTreasury: the protocol's fee share, buying and burning TICKR
function earmarkedUsdg() view returns (uint256);   // dollars set aside for buys
function totalUsdgSpent() view returns (uint256);
function totalTickrBurned() view returns (uint256);
function lastBuyAt() view returns (uint256);
function nextBuyAt() view returns (uint256);        // zero until the first buy
function previewBuy() view returns (uint256 usdgIn, uint256 minTickrOut);
function official() view returns (address tickr, address fun);
function collect(address[] tokens) returns (uint256 usdgTotal, uint256 toTeam, uint256 earmarked);
function buy() returns (uint256 usdgIn, uint256 tickrOut);
// events
event Collected(uint256 usdgTotal, uint256 toTeam, uint256 earmarked);
event Forwarded(address indexed asset, uint256 amount);       // an unconvertible asset sent whole to the team
event BoughtAndBurned(uint256 usdgIn, uint256 tickrOut, address indexed caller);
// constants: MAX_IMPACT_BPS 300, MIN_INTERVAL 10 minutes, MAX_TRANCHE_BPS 500, SHARE_DELAY 3 days
function buybackShareBps() view returns (uint16);       // the burn share in force, 5000 at the start; only ever raised
function pendingShareBps() view returns (uint16);       // a proposed raise waiting out its delay, zero when none
function shareEffectiveAt() view returns (uint256);     // when the pending raise may be applied
function proposeBuybackShare(uint16 bps);               // the factory owner only; higher than the current share, at most 10000
function applyBuybackShare();                           // anyone, once shareEffectiveAt has passed
// launcher(): the ticker launcher the treasury is bound to; zero until its first collect or buy
```

## The site's own endpoints

`/api/pair/<address>` describes any address as a possible quote asset: registry match, lookalikes, pools. `/api/pin` pins an image or metadata to IPFS for the create page. `/llms.txt` and `/llms-full.txt` mirror these docs; `/docs/<slug>.md` serves each page as markdown.
