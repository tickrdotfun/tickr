# 05 · Anchors: official assets and invented tickers

> On the create page this is the "invent a name" option: the name is the quote asset your coin is priced in, the second half of the pair, not your coin's own ticker.

A launch is priced in whatever it is quoted in. That quote is either an **official anchor** (ETH, USDG, an official Stock Token) or an **invented ticker**: a token somebody named on tickr, which is a one-for-one wrapper of USDG carrying that name.

> BANANA and BREAD run through this page as one worked example, and that is all they are: two names somebody typed. There is no official ticker and no reserved list beyond the anchors below. Any name that is free is yours to use.

|  | Official anchor | Invented ticker |
| --- | --- | --- |
| Quote asset | ETH, USDG, or an official Stock Token issued by Robinhood Assets, listed in `AnchorRegistry` | A `TickerToken`: 1 BANANA is always exactly 1 USDG, mint and redeem any time |
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
contract TickerToken is ERC20 {
    IERC20 public immutable counter;                       // USDG
    function decimals() public view returns (uint8);       // the counter's, so one-for-one is literal
    function mint(uint256 amount, address to) external;    // amount USDG in, amount BANANA out
    function redeem(uint256 amount, address to) external;  // amount BANANA burned, amount USDG out
    function reserve() external view returns (uint256);    // USDG held; always >= totalSupply()
}
```

That is the whole contract. No owner, no fee, no pause, no blacklist, no upgrade, no mint without a deposit. A BANANA exists only because a USDG was deposited for it, and the only way that USDG leaves is against the burn of that BANANA. `totalSupply() <= reserve()` holds from the first block to the last.

It is not a stablecoin in the sense that ever goes wrong. Nothing maintains the price: there is no peg to defend, only convertibility.

## Why the price holds

A ticker's value is not defended, and it is not discovered by a market. It is defined by the contract.

<figure class="doc-fig"><!-- alt:
                    mint
    1 USDG  ==================>  1 BANANA
    1 USDG  <==================  1 BANANA
                   redeem
    one for one, no fee, no limit, open to anyone
-->
<svg viewBox="0 0 680 172" role="img" aria-label="One USDG can always be minted into one BANANA, and one BANANA redeemed back into one USDG, at a one to one rate with no fee"><defs><marker id="fig-a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--tickr-signal)"></path></marker></defs><rect x="25" y="40" width="175" height="90" rx="45" fill="none" stroke="var(--border)"></rect><text x="112" y="80" text-anchor="middle" fill="var(--text)" font-size="22" font-weight="700">1 USDG</text><text x="112" y="102" text-anchor="middle" fill="var(--dim)" font-size="12.5">a real dollar</text><rect x="480" y="40" width="175" height="90" rx="45" fill="none" stroke="color-mix(in srgb, var(--tickr-sw-yellow) 42%, transparent)"></rect><text x="567" y="80" text-anchor="middle" fill="var(--tickr-sw-yellow)" font-size="22" font-weight="700">1 BANANA</text><text x="567" y="102" text-anchor="middle" fill="var(--dim)" font-size="12.5">an invented ticker</text><text x="340" y="59" text-anchor="middle" fill="var(--muted)" font-size="13" font-weight="600">mint</text><line x1="212" y1="70" x2="466" y2="70" stroke="var(--tickr-signal)" stroke-width="2" marker-end="url(#fig-a)"></line><text x="340" y="93" text-anchor="middle" fill="var(--dim)" font-size="12">1 : 1, no fee, any time</text><line x1="468" y1="104" x2="214" y2="104" stroke="var(--tickr-signal)" stroke-width="2" marker-end="url(#fig-a)"></line><text x="340" y="124" text-anchor="middle" fill="var(--muted)" font-size="13" font-weight="600">redeem</text></svg>
</figure>

A name is one to twelve ASCII letters or digits, case-folded to upper case; nothing else, so no name can look like NVDA, USDG or ETH through another script. A coin's own symbol follows the same rule, and a coin's name is printable ASCII: letters, digits, punctuation and single spaces, none at either end. so the reserved names cannot be dodged by a space or by a lookalike letter from another script; emoji and other scripts belong in the description and the image. `mint` pulls `amount` of USDG and issues exactly what arrived, which is `amount` for USDG. `redeem` burns `amount` and returns exactly `amount` of USDG. Neither has a fee, a cap, a cooldown, or a check on who is calling, and there is no function anywhere that issues a unit without a deposit behind it. `totalSupply() <= reserve()` therefore holds in every state the contract can reach.

Two consequences follow, and together they are the whole argument:

- **No ceiling to break.** If a ticker ever traded above its counter asset, anyone could mint at one-for-one and sell into that price. Minting is unbounded, so the supply available to meet a premium is unbounded.
- **No floor to fall through.** If it ever traded below, anyone could buy and redeem for the full amount. The vault can always pay, because supply never exceeds reserve.

<figure class="doc-fig"><!-- alt:
   above $1: anyone mints at a dollar and sells
                        |
                        v
   $1.00 =====================================
                        ^
                        |
   below $1: anyone buys it and redeems for a dollar
-->
<svg viewBox="0 0 680 196" role="img" aria-label="Above a dollar anyone mints at a dollar and sells; below it anyone buys and redeems for a dollar. Both push the price back to the counter asset."><defs><marker id="fig-b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="var(--tickr-sw-yellow)"></path></marker></defs><text x="340" y="26" text-anchor="middle" fill="var(--muted)" font-size="13.5">above a dollar, anyone mints at one-for-one and sells</text><line x1="340" y1="42" x2="340" y2="86" stroke="var(--tickr-sw-yellow)" stroke-width="2" marker-end="url(#fig-b)"></line><line x1="40" y1="98" x2="640" y2="98" stroke="var(--tickr-signal)" stroke-width="2.5"></line><text x="40" y="88" fill="var(--tickr-signal)" font-size="14" font-weight="700">$1.00</text><text x="640" y="88" text-anchor="end" fill="var(--dim)" font-size="12.5">the only price that holds</text><line x1="340" y1="154" x2="340" y2="110" stroke="var(--tickr-sw-yellow)" stroke-width="2" marker-end="url(#fig-b)"></line><text x="340" y="176" text-anchor="middle" fill="var(--muted)" font-size="13.5">below it, anyone buys and redeems for the full amount</text></svg>
</figure>

Both trades are riskless while the vault is open, which it always is. Note that neither depends on tickr, on a market maker, or on anyone's good behaviour: the arbitrage is available to every address on the chain, permissionlessly.


This is what "only the coin is speculative" means in the contracts rather than in the copy: the pair is defined, and the coin is discovered.

## A coin under a ticker

A coin priced in an invented ticker is an ordinary launch whose pair is the wrapper. `TickerLauncher.launch(symbol, coin, launchConfigId)` creates the ticker if it is new and calls `Factory.launchTokenWithPair` with the USDG economics: the pool opens at 3,236 of the wrapper per billion coins, the entire supply locked in it from the first block. `launchAndBuy(symbol, coin, launchConfigId, usdgIn, minTokensOut)` does the same and then the creator's first buy: `usdgIn` USDG is pulled from the caller, wrapped one for one, and spent in the new pool.

Buying such a coin from the site is one transaction paid in ETH or USDG: the zap turns ETH into USDG through the live pool, wraps it into the ticker one for one, and buys from the coin's pool. Selling runs the same route backwards and ends in USDG or ETH. Nobody has to hold the wrapper.

## Cost

Launching under a ticker that exists costs the launch fee, 0.0005 ETH. Inventing a new ticker costs `TickerLauncher.NEW_TICKER_FEE`, 0.0015 ETH, on top of it. That fee is not kept: it is converted to USDG in the same transaction and opens the ticker's dollar pool, described below.

## Nobody owns a ticker

There is no owner slot, no role, and no line in any later pair's fee split for whoever typed the name first. Opening BANANA with BREAD grants BREAD its own 60% and one thing in the club: the founder's coin is the club's captain by default, and the captain counts double when a pot is split. That is a weight, not a right. The founder cannot touch any other coin's fees, cannot keep anyone out, and holds nothing over the name. `TickerLauncher` itself has no owner either.

## The ticker club


- The club's 10% is booked per paying coin into `pot(ticker, window, coin)`, in the window the fee is swept, and held by the launcher in the ticker itself.
- A coin never pays its own creator through the club. Its share of another coin's pot is `pot × its weight / the total weight under the ticker`, the payer's weight included. A coin's weight is its window volume, and the captain's is twice its volume, so the total weight is the window's volume plus the captain's volume once more. The payer's own share of its pot goes to the protocol through `sweepDeadPot`, so a coin with dust volume earns dust, and a coin with no volume in the window earns nothing.
- Every club has a captain, decided per window from that window's final volumes. The founder's coin, the first launched under the ticker, is captain whenever it has any volume in the window; there is no floor. In a window where it has none, the coin with the most volume under the ticker is captain instead (`topOf`, kept as volume lands, ties to the incumbent), and the founder is captain again in any later window it trades in. Worked example: BREAD founded BANANA, PEEL and CHIP joined, and in one window each of the three traded 1,000 BANANA. Weights are 2,000 for BREAD, 1,000 for PEEL and 1,000 for CHIP, 4,000 in all: of CHIP's pot, BREAD's creator claims a half, PEEL's a quarter, and CHIP's own quarter goes to the protocol. Had BREAD not traded that window, PEEL and CHIP would have tied at 1,000 and the first to record volume would have kept the seat. The seat is a weight and nothing more: the captain has no say over any coin and no access to any fee but its own share. A pot is booked to the window the paying coin last traded in, not the window the sweep happens in, so holding a sweep back past a window boundary cannot move a pot away from the coins that were trading when it was earned. Claims and the protocol sweep pay by amount, so a pot that grows after a claim is still claimable for the rest.
- No volume in the window, no share. A pot with nobody to go to (no other coin traded that window) goes to the protocol, `sweepDeadPot`.
- Claims open when the window closes, so nothing about a claim can move after it becomes claimable. Anyone may call; the money goes to the member's current fee recipient.

```
function claimClub(address member, address[] payers, uint256 epoch) returns (uint256);   // closed epochs only
function claimable(address member, address[] payers, uint256 epoch) view returns (uint256);
function sweepDeadPot(address token, uint256 epoch) returns (uint256);                   // to the protocol
function pairsOf(address ticker) view returns (address[]);
function captainOf(address ticker, uint256 epoch) view returns (address);                 // the founder's coin while it trades, else the top coin
function topOf(address ticker, uint256 epoch) view returns (address);                     // the most volume this epoch, kept as volume lands
function volumeOf(address token, uint256 epoch) view returns (uint256);
function clubVolume(address ticker, uint256 epoch) view returns (uint256);
function pot(address ticker, uint256 epoch, address token) view returns (uint256);
function currentEpoch() view returns (uint256);                                          // block.timestamp / 30 days
```


Outside a ticker there is no club, so an official pair freezes 70% creator, 30% protocol.

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

## The chart pool

A ticker has no market of its own and needs none. Chart sites do not know that: they price a pair by walking from its quote token to a dollar through pools. So the moment a ticker is invented, `LaunchSeeder.seedDollarPool`, callable only by the ticker launcher named on the factory, turns the ticker fee into USDG through the live ETH/USDG pool, mints half of it into the wrapper, and opens a plain Uniswap v4 WRAPPER/USDG pool at exactly one dollar with all of that liquidity inside 0.1% of a dollar, the position locked in `LaunchLocker`. One small swap follows so indexers list the pair. From that block on, every coin under the ticker has a path to a dollar on any chart.

The pool is created behind `ChartGuardHook`: it can only be opened by the seeder and only at one dollar, liquidity can only be added inside that band, and any swap that would leave the pool more than 0.02% from a dollar reverts. So the pool cannot be pushed off a dollar at any size; it is a real pool with real trades inside the band and a wall outside it. Anyone can open a second WRAPPER/USDG pool without the guard, at any price, because Uniswap pools are permissionless; that pool is theirs, not the ticker's, and every trade in it away from a dollar hands an arbitrage to whoever mints or redeems the wrapper. Which pool a chart site reads is that site's choice; the guarded one always says a dollar. The size of the pool is set by the ticker fee, one constant, and can be raised for future tickers.
