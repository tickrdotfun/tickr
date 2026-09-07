# 05 · Anchors: official assets and invented tickers

> On the create page this is the "invent a name" option: the name is the quote asset your coin is priced in, the second half of the pair, not your coin's own ticker.

A launch is priced in whatever it is quoted in. That quote is either an **official anchor** (ETH, USDG, an official Stock Token) or an **invented ticker**: a token somebody named on tickr, which is a one-for-one wrapper of USDG carrying that name.

> BANANA and BREAD run through this page as one worked example, and that is all they are: two names somebody typed. There is no official ticker and no reserved list beyond the anchors below. Any name that is free is yours to use.

|  | Official anchor | Invented ticker |
| --- | --- | --- |
| Quote asset | ETH, USDG, or an official Stock Token issued by Robinhood Assets, listed in `AnchorRegistry` | A `ManagedTickerToken`: 1 BANANA is redeemable for exactly 1 USDG, mint and redeem one for one between transactions (while the pool manager is locked), and the name runs its own pool at a dollar |
| Entry point | `Factory.launchToken` / `LaunchAndBuyRouter.launchAndBuy` | `TickerLauncher.launch(symbol, ...)`: existing ticker or brand new, same call |
| Pair approval | Global (`approvedPairTokens == true`) | Never global. Each coin under it is priced in it through the registrar path, on USDG's economics |
| Issuer | Robinhood Assets for Stock Tokens; native / stablecoin issuer otherwise | Nobody. The wrapper has no owner and no admin function |
| Who holds the ticker | n/a | Whoever minted some and has not redeemed it yet. Nobody at birth; a first buy in `launchAndBuy` mints some against the caller's USDG and spends it on the coin's curve like any other buy |
| What it is worth | Its market | Exactly its counter asset, by construction |
| UI | Official badge | `YOURCOIN/BANANA` with the badge **creator-issued** |

## AnchorRegistry

```
struct Anchor { string ticker; string issuer; uint8 kind; bool active; }

uint8 KIND_NATIVE = 0;          // ETH, registered at address(0) in the constructor
uint8 KIND_STABLE = 1;          // USDG
uint8 KIND_OFFICIAL_STOCK = 2;  // official Stock Token at its canonical address

function register(address token, string ticker, string issuer, uint8 kind, address feed) external onlyOwner;
function setActive(address token, bool active) external onlyOwner;
function reserveTicker(string ticker, bool reserved) external onlyOwner;
function isApproved(address token) external view returns (bool);   // active anchor
function isReservedTicker(string ticker) external view returns (bool);
```

The registry is the list of real assets. It answers two questions: *is this a real anchor?* (`isApproved`) and *is this symbol spoken for?* (`isReservedTicker`). Every anchor's ticker is reserved, so an invented ticker cannot be called NVDA, USDG or ETH.

## What an invented ticker is

A one-for-one wrapper of USDG.

```
contract ManagedTickerToken is ERC20 {
    IERC20 public immutable counter;                        // USDG
    function decimals() public view returns (uint8);        // the counter's, so one for one is literal
    function mint(uint256 amount, address to) external;     // amount USDG in, amount BANANA out; only while the pool manager is locked
    function redeem(uint256 amount, address to) external;   // amount BANANA burned, amount USDG out; the same condition
    function accounting() external view returns (uint256 backing, uint256 circulation); // backing >= circulation, always
    function poolKey() external view returns (PoolKey);     // its own pool against USDG, described below
}
```

No owner, no fee on mint or redeem, no pause, no blacklist, no upgrade. Two kinds of BANANA exist. What is in circulation, everything a wallet or a pool other than the name's own holds, exists only because a dollar was paid for it: deposited through `mint`, or paid into the name's own pool by a buyer. That dollar is its backing, and the only way it leaves is against the burn of that BANANA, or against a sale of it back into the pool. The other kind is the wrapper's own inventory: BANANA it mints to itself and keeps in its own pool positions as the offer to buyers. Inventory is owed to nobody and backed by nothing, it is never in circulation, and it becomes circulation only at the moment a buyer pays for it. So `totalSupply()` counts both, and the number that means something is `circulatingSupply()`; the rule the contract enforces before and after every operation is `backing >= circulation`, not a comparison with the total supply.

It is not a stablecoin in the sense that ever goes wrong. Nothing maintains a price on other venues: what the contract gives is convertibility one for one with the USDG it holds, plus a market of its own that it keeps at a dollar. A name is redeemable for USDG; it is not a promise of a US dollar.

## Why the price holds

A ticker's value is not defended on someone else's market, and it is not discovered by one. It is defined by the contract, in two ways that back each other up.

<figure class="doc-fig"><!-- alt:
                    mint
    1 USDG  ==================>  1 BANANA
    1 USDG  <==================  1 BANANA
                   redeem
    one for one, no fee, while the pool manager is locked
-->
<svg viewBox="0 0 680 172" role="img" aria-label="One USDG can be minted into one BANANA, and one BANANA redeemed back into one USDG, at a one to one rate with no fee, outside any route"><defs><marker id="fig-a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L8 4L0 8z" fill="currentColor"/></marker></defs><g fill="none" stroke="currentColor" stroke-width="1.5"><path d="M180 66H500" marker-end="url(#fig-a)"/><path d="M500 106H180" marker-end="url(#fig-a)"/></g><g font-family="ui-monospace, monospace" font-size="14" fill="currentColor"><text x="60" y="70">1 USDG</text><text x="60" y="110">1 USDG</text><text x="520" y="70">1 BANANA</text><text x="520" y="110">1 BANANA</text><text x="320" y="52" text-anchor="middle">mint</text><text x="320" y="130" text-anchor="middle">redeem</text><text x="340" y="160" text-anchor="middle" font-size="12">one for one, no fee, while the pool manager is locked</text></g></svg>
</figure>

A name is one to twelve ASCII letters or digits, case-folded to upper case; nothing else, so no name can look like NVDA, USDG or ETH through another script. A coin's own symbol follows the same rule, and a coin's name is printable ASCII: letters, digits, punctuation and single spaces, none at either end.

Two consequences follow, and together they are the whole argument:

- **No ceiling to break.** If a ticker ever traded above a dollar somewhere, anyone could mint at one for one and sell into that price. Minting is open to every address, so the supply available to meet a premium is bounded only by the dollars people bring.
- **No floor to fall through.** If it ever traded below a dollar somewhere, anyone could buy there and redeem for the full amount. The wrapper can always pay, because backing covers circulation.

<figure class="doc-fig"><!-- alt:
   above $1 elsewhere: anyone mints at a dollar and sells
                        |
                        v
   $1.00 =====================================
                        ^
                        |
   below $1 elsewhere: anyone buys it and redeems for a dollar
-->
<svg viewBox="0 0 680 196" role="img" aria-label="Above a dollar elsewhere anyone mints at a dollar and sells; below it anyone buys and redeems for a dollar. Both push the price back to the counter asset."><defs><marker id="fig-b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L8 4L0 8z" fill="currentColor"/></marker></defs><g fill="none" stroke="currentColor" stroke-width="1.5"><path d="M60 98H620"/><path d="M340 40V86" marker-end="url(#fig-b)"/><path d="M340 156V110" marker-end="url(#fig-b)"/></g><g font-family="ui-monospace, monospace" font-size="13" fill="currentColor"><text x="340" y="30" text-anchor="middle">above $1 elsewhere: anyone mints at a dollar and sells</text><text x="340" y="180" text-anchor="middle">below $1 elsewhere: anyone buys it and redeems for a dollar</text><text x="30" y="102">$1.00</text></g></svg>
</figure>

Both trades are open to every address on the chain, permissionlessly, while the pool manager is locked, which is between transactions, so not from inside a route that is already trading. They are not free of risk: the other venue's price, its fees and its depth are that venue's, and a route through the name's own pool pays that pool's fee, spread and rounding, is bounded by its offer, and may visit it once per transaction. Neither trade depends on tickr, on a market maker, or on anyone's good behaviour.

The name's own pool, described further down, is the second way: the wrapper keeps it at a dollar itself, so the first way is rarely needed.

This is what "only the coin is speculative" means in the contracts rather than in the copy: the pair is defined, and the coin is discovered.

## A coin under a ticker

A coin priced in an invented ticker is an ordinary launch whose pair is the wrapper. `TickerLauncher.launch(symbol, coin, launchConfigId)` creates the ticker if it is new and calls `Factory.launchTokenWithPair` with the USDG economics: the pool opens at 3,236 of the wrapper per billion coins, the entire supply locked in it from the first block. `launchAndBuy(symbol, coin, launchConfigId, usdgIn, minTokensOut)` does the same and then the creator's first buy: `usdgIn` USDG is pulled from the caller, wrapped one for one, and spent in the new pool. That first buy is paid in USDG the caller already holds, so from the site it is one approval and one launch, then the two listing buys: nothing here promises the reference's exact count of signatures for every mode, only its order.

Buying such a coin from the site is one transaction paid in ETH or USDG: the zap turns ETH into USDG through the live pool, turns that into the ticker, through the ticker's own pool or by wrapping one for one, whichever gives more, and buys from the coin's pool. Selling runs the same route backwards and ends in USDG or ETH. Nobody has to hold the wrapper.

Every coin under a ticker sorts below it: the coin is currency0 of its pool and the name currency1, so the base and the quote read the same way on every chart. `TickerLauncher` places every name in the top sixteenth of the address space, and a launch whose coin would sort above its name reverts with `CoinNotFirst`; the site grinds the coin's salt for it, like it does for the `6942` suffix.

## Cost

Launching under a ticker that exists costs the launch fee, 0.0005 ETH. Inventing a new ticker costs `TickerLauncher.NEW_TICKER_FEE`, 0.0015 ETH, on top of it. That fee is not kept: it is converted to USDG in the same transaction and becomes the working dollars of the ticker's own pool, described below.

## Nobody owns a ticker

There is no owner slot, no role, and no line in any later pair's fee split for whoever typed the name first. Opening BANANA with BREAD grants BREAD its own 50% and one thing in the club: the founder's coin is the club's captain by default, and the captain counts double when a pot is split. That is a weight, not a right. The founder cannot touch any other coin's fees, cannot keep anyone out, and holds nothing over the name. `TickerLauncher` itself has no owner either.

## The ticker club


- The club's 10% is booked per paying coin into `pot(ticker, window, coin)`, in the window the fee is swept, and held by the launcher in the ticker itself. Said plainly: a pot lands in the window of the sweep, not of the trades behind it. Anyone may sweep at any time, so a sweep just after a window closes books those fees to the new window. Volumes, which decide the weights, are booked the same way: when a coin's fees are collected, the locker books the quote fees collected divided by the pool fee rate as that coin's volume for the window of the collection. so it stands for buy volume in the quote, since only buys pay fees in the quote, and a coin's weight for a window depends on when someone collected.
- A coin never pays its own creator through the club. Its share of another coin's pot is `pot × its weight / the total weight under the ticker`, the payer's weight included. A coin's weight is its booked window volume, and the captain's is twice its volume, so the total weight is the window's volume plus the captain's volume once more. The payer's own share of its pot goes to the protocol through `sweepDeadPot`, so a coin with dust volume earns dust, and a coin with no volume in the window earns nothing.
- Every club has a captain, decided per window from that window's final booked volumes, so from what was collected in the window, not from trades nobody collected for. The founder's coin, the first launched under the ticker, is captain whenever it has any volume in the window; there is no floor. In a window where it has none, the coin with the most volume under the ticker is captain instead (`topOf`, kept as volume lands, ties to the incumbent), and the founder is captain again in any later window it trades in. Worked example: BREAD founded BANANA, PEEL and CHIP joined, and in one window each of the three traded 1,000 BANANA. Weights are 2,000 for BREAD, 1,000 for PEEL and 1,000 for CHIP, 4,000 in all: of CHIP's pot, BREAD's creator claims a half, PEEL's a quarter, and CHIP's own quarter goes to the protocol. Had BREAD not traded that window, PEEL and CHIP would have tied at 1,000 and the first to record volume would have kept the seat. The seat is a weight and nothing more: the captain has no say over any coin and no access to any fee but its own share. A pot is booked to the window the collection happens in, not the window the trades happened in: a collection held back past a window boundary lands in the next window's pot, with that window's weights and captain. Anyone may call `collectFees` at any time, so a coin that wants its fees booked where they were earned has only to collect before the window closes, and the keeper collects on a schedule. Claims and the protocol sweep pay by amount, so a pot that grows after a claim is still claimable for the rest.
- No volume in the window, no share. A pot with nobody to go to (no other coin traded that window) goes to the protocol, `sweepDeadPot`.
- Claims open when the window closes, so nothing about a claim can move after it becomes claimable. Anyone may call; the money goes to the member's current fee recipient.

```
function claimClub(address member, address[] payers, uint256 epoch) returns (uint256);   // closed epochs only
function claimable(address member, address[] payers, uint256 epoch) view returns (uint256);
function sweepDeadPot(address token, uint256 epoch) returns (uint256);                   // to the protocol
function pairsOf(address ticker) view returns (address[]);
function captainOf(address ticker, uint256 epoch) view returns (address);                 // the founder's coin while it trades, else the top coin
function topOf(address ticker, uint256 epoch) view returns (address);                     // the most booked volume this epoch, kept as collections land
function volumeOf(address token, uint256 epoch) view returns (uint256);                  // booked at fee collection: quote fees collected / pool fee rate, so buy volume in the quote
function clubVolume(address ticker, uint256 epoch) view returns (uint256);
function pot(address ticker, uint256 epoch, address token) view returns (uint256);
function currentEpoch() view returns (uint256);                                          // block.timestamp / 30 days
```


Outside a ticker there is no club, so an official pair freezes 60% creator, 40% protocol.

## Reserved tickers

`TickerLauncher` refuses any symbol the registry reserves (`TickerReserved`), and so does the factory for the coin itself. USDG, ETH and every official Stock Token symbol are reserved at deploy.

## One ticker per symbol

Symbols are claimed once, case-insensitively: BANANA, banana and Banana are one ticker at one address. A second launch that names it simply joins it. The create page checks `tickerFor` as you type and shows who is already there.

## Required disclosure

Any surface that shows an invented ticker shows this, verbatim:

> Not issued by Robinhood Assets. Not a Stock Token. No mint/redeem against listed shares. An invented ticker is a one-for-one wrapper of USDG: it is worth exactly what it wraps.

## What it inherits

A ticker is exactly as safe as the dollar it wraps. If USDG depegs, freezes, or blacklists the wrapper's address, the ticker follows. That is the same risk as pairing against USDG directly, which every launch on this chain already carries; tickers do not add to it.

## Depth one only

A coin priced in a ticker cannot itself be a quote. `CoinQuoteLauncher.quotePrice` requires the quote coin's pair to be an approved anchor, and a ticker is a wrapper, not an anchor. So every coin on tickr is at most one hop from a real asset: `COIN → TICKER → USDG`, never a tower.

## The name's own pool

A ticker is redeemable one for one for the USDG it wraps, not a promise of a US dollar, and a name with no market is a name no chart can price and no router can reach. So every invented ticker runs its own Uniswap v4 pool against USDG from the moment it is invented, at a fixed 0.05% fee, behind one hook shared by every ticker, `ManagedTickerHook`. The pool is an ordinary pool with ordinary swaps, no custom accounting and no dynamic fee, so any router that trades Uniswap v4 can trade it; whether a third party routes through it, lists it, or shows it the right way round is that party's choice, not something the contracts can promise. The hook only hands each pool's callbacks to the wrapper that owns it.

What the wrapper does with them. Its unsold inventory is the buy side: tokens it mints to itself, owed to nobody and backed by nothing until somebody buys them, when the dollars paid become their backing. At rest that offer is `INVENTORY_FLOOR`, ten thousand dollars' worth (the value the reference traded with; not ten thousand dollars deposited anywhere), and it grows by four times whatever is in circulation, so one buy through the pool can take that much and fills whole or not at all; the site wraps one for one for anything larger. The wrapper's backing is the sell side: every dollar anyone paid in, on offer at a dollar each, so whatever is in circulation can always come back. Before every outside swap the wrapper rebuilds both positions and re-centres the price at exactly one dollar, paying for the tiny re-centring swap from its own surplus, never from the backing; after the swap it checks that the fill was whole, that the price is within two ticks of a dollar, and that the backing still covers the circulation. If any of that fails the swap reverts and nothing moved. One visit to the pool per transaction; a route that crosses the same name's pool twice reverts.

The surplus that pays for re-centring is the ticker fee, converted to USDG in the launch transaction and handed to the wrapper as a donation that nobody can redeem, plus the pool's own fees as they accrue. Backing covers circulation before and after every operation, and `mint` and `redeem` still work one for one at any time (while the pool manager is locked, so not from inside a route), so the pool cannot be pushed off a dollar at any size: a buy above the offer or a sell above the circulation reverts whole. Ordinary swaps in the pool carry the pool's fee, spread and rounding; they are not the fee-free exact mint and redeem. The name's positions are managed by the wrapper and rebuilt at every swap; they are not the locked launch position of a coin, and are not described as one. Only the wrapper adds or removes liquidity in its pool, and only while it is maintaining; the pool holds no position of anyone else's. Anyone can open a second WRAPPER/USDG pool without the hook, at any price, because Uniswap pools are permissionless; that pool is theirs, not the ticker's, and every trade in it away from a dollar hands an arbitrage to whoever mints or redeems the wrapper.

## Listing: the two buys after a launch

Chart sites and trackers priced the reference launch's name from a swap that landed in a wallet after the name's pool existed, and its coin from a buy in a transaction after the launch. The launch transaction itself, first buy included, counted for neither. So a launch under a name is not finished until two more transactions land, one after the other, both sent through Uniswap's canonical Universal Router with an explicit path of the launch's own pool keys, exactly as the reference sent them:

1. `0.0005 ETH` of the name, through the ETH/USDG pool and the name's own pool, the name delivered to the creator's wallet.
2. After that receipt is confirmed and a later block exists: `0.001 ETH` of the coin with fresh ETH, through the same two pools and the coin's own, the coin delivered to the same wallet. The name bought in the first stays in the wallet.

Both stages, every time, for a fresh name and for an existing one; skipping the first is an untested shortcut. Each is a separate wallet signature with its own fresh quote from Uniswap's quoter, a minimum one percent under it that is never zero, an explicit gas and fee cap, and its own cost ceiling; a quote that cannot be read stops the step, it never lowers the protection. The site keeps a record of each attempt in the browser before the wallet opens, records the transaction hash the moment the wallet returns it, waits for pending transactions rather than resending, and asks for the hash by hand when a wallet's answer was lost. It shows a coin as listed only when both receipts are canonical, in order, and show the router's swaps on exactly those pools and the delivery to the wallet. The amounts are the reference's test parameters, not proven minimums or dollar values; other amounts need their own acceptance test.

Both buys landing is not the same as showing up on a chart: chart sites and aggregators index on their own clock and by their own rules, the reference's name showed up minutes later, and a price on a chart is not a trade. tickr does not promise a place on any chart, a market of any size, or a market capitalisation. The coin trades on tickr either way.
