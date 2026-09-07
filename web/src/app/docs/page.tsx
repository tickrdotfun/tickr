import Link from "next/link";
import { DOC_GROUPS } from "@/lib/docsNav";
import { DISCLOSURE } from "@/lib/constants";
import { ADDRESSES, DEPLOYED } from "@/lib/addresses";
import { DEMO } from "@/lib/demoTransport";
import { explorerAddress } from "@/lib/chain";

const CONTRACTS: [string, string][] = [
  ["Factory", ADDRESSES.factory],
  ["LaunchSeeder", ADDRESSES.launchSeeder],
  ["LaunchLocker", ADDRESSES.launchLocker],
  ["FeeEscrow", ADDRESSES.feeEscrow],
  ["TickerLauncher", ADDRESSES.tickerLauncher],
  ["ZapRouter", ADDRESSES.zapRouter],
  ["ManagedTickerHook", ADDRESSES.managedTickerHook],
  ["CoinQuoteLauncher", ADDRESSES.coinQuoteLauncher],
  ["StockQuoteLauncher", ADDRESSES.stockQuoteLauncher],
  ["LaunchAndBuyRouter", ADDRESSES.launchAndBuyRouter],
  ["AnchorRegistry", ADDRESSES.anchorRegistry],
  ["Uniswap v4 PoolManager", ADDRESSES.poolManager],
  ["Uniswap v4 PositionManager", ADDRESSES.positionManager],
  ["USDG", ADDRESSES.usdg],
  ["WETH", ADDRESSES.weth],
];

/**
 * Every figure is the value the deploy script freezes into a launch. Nothing here is a round figure written for a
 * website: if a number changes in the contracts it has to change here too.
 */
const FIXED: [string, string, string?][] = [
  ["launch fee", "0.0005 ETH", "paid once, at creation"],
  ["new ticker fee", "0.0015 ETH", "on top of the launch fee, only when the name is new. it opens the name's dollar pool"],
  ["pool fee", "1%", "the pool's own lp fee, plus the creator tax"],
  ["of that, to the creator", "50%", "60% on any pair that is not an invented ticker, where there is no club"],
  ["to the ticker club", "10%", "of the base fee on the quote side, under an invented ticker only: a pot for the other coins under the same ticker, by the buy volume their fee collections book over 30 days. the coin side's club share is burned"],
  ["to the protocol", "40%", "4,000 bps, on every pair; half of it buys and burns TICKR"],
  ["creator tax ceiling", "2%", "at launch. the owner can raise that ceiling for later launches, never above 10%. all of it is the creator's"],
  ["buyback vault route", "0%", "off, and frozen off per launch. a separate mechanism from the treasury below"],
  ["treasury buyback and burn", "half", "of the protocol's 40%, in USDG the treasury can convert; it buys and burns TICKR, and the share can only rise. on from the first launch"],
  ["opens at, priced in ETH", "1.68 ETH", "market cap at the first block"],
  ["opens at, priced in USDG", "3,236 USDG", "the same for every invented ticker, which is USDG one for one"],
];

const STEPS: [number, string, string][] = [
  [1, "the coin", "the whole supply is minted to the factory in the launch transaction. nobody holds any of it at creation, the creator included."],
  [
    2,
    "the pool",
    "a plain uniswap v4 pool with no hook is opened at the opening price, and the whole supply goes into one position from that price up. it behaves like a constant product pool whose quote side starts at the opening market cap.",
  ],
  [3, "the lock", "the position is minted to the locker, which has no function to move a position or its principal out. not the creator, not the protocol."],
  [
    4,
    "the fees",
    "the pool fee lands in the locked position. anyone can collect it; the split frozen at launch sends the quote side to the escrow for the creator, the club and the protocol's buyback treasury. the coin side, what sells pay, splits the same way: the creator's share and tax go to the creator's escrow in the coin, the protocol's and the club's shares are burned. a buy in a coin's first five seconds pays a snipe tax, burned too.",
  ],
];

export default function DocsOverview() {
  return (
    <>
      <article className="docs-article">
        <header className="docs-head">
          <span className="docs-head-n num">§ 0</span>
          <h1 className="docs-head-t">overview</h1>
          <p className="docs-head-d">what tickr is, the numbers a launch is frozen with, and what one transaction does.</p>
        </header>

        <p>
          tickr launches coins on <span className="cap">Robinhood Chain</span> and prices each one against a pair the
          creator picks at creation. that pair can be ETH, USDG, a <span className="cap">Stock Token</span>, a coin this
          factory has already launched, or a ticker that does not exist anywhere yet and is created on the spot.
        </p>
        <p>
          nothing in it gives the operator custody. the factory mints, the pool holds the supply and the liquidity, the locker holds the
          position, and the escrow holds fees until whoever earned them claims them. every launch and every trade is a
          transaction you sign yourself.
        </p>

        <h2 id="fixed-at-launch" className="docs-h2">fixed at launch</h2>
        <p className="docs-note">
          written into the token&apos;s own policy when it is created, and never writable again. the launcher reads
          them back before it will sign, so a launch that quotes you different terms reverts instead of settling.
        </p>
        <dl className="docs-facts">
          {FIXED.map(([k, v, note]) => (
            <div key={k} className="docs-fact">
              <dt>{k}</dt>
              <dd className="num">{v}</dd>
              {note && <span className="docs-fact-n">{note}</span>}
            </div>
          ))}
        </dl>

        <h2 id="one-transaction" className="docs-h2">one transaction</h2>
        <p className="docs-note">a launch is one transaction. there is no curve to fill and nothing to graduate. the pool exists from that block on.</p>
        <ol className="docs-phases">
          {STEPS.map(([n, name, body]) => (
            <li key={name}>
              <span className="docs-phase-n num">{n}</span>
              <div>
                <code className="docs-phase-t">{name}</code>
                <p>{body}</p>
              </div>
            </li>
          ))}
        </ol>

        <h2 id="what-this-can-cost-you" className="docs-h2">what this can cost you</h2>
        <ul className="docs-warn">
          <li>a name and a symbol are text. two coins can carry the same ones, so the address is the only identity.</li>
          <li>
            a coin&apos;s price is whatever its own pool says at that block. it is not quoted against, backed by, or
            redeemable for the thing its ticker is named after.
          </li>
          <li>
            a launch can be thin, can be sold into by its creator, and can end up worth nothing. none of that is a
            failure of the contracts.
          </li>
        </ul>

        <h2 id="invented-tickers-the-disclosure" className="docs-h2">invented tickers, the disclosure</h2>
        <p className="docs-disclosure">
          <em className="cap">{DISCLOSURE}</em>
        </p>

        <h2 id="the-pages" className="docs-h2">the pages</h2>
        {DOC_GROUPS.map((g) => (
          <div key={g.label} className="docs-index-group" style={{ ["--mk" as string]: g.swatch }}>
            <div className="docs-index-head">
              <span className="docs-rail-n num">{g.num}</span>
              {g.label}
            </div>
            <ul className="docs-index">
              {g.items.map((d, i) => (
                <li key={d.slug}>
                  <span className="docs-index-n num">
                    {g.num}.{i + 1}
                  </span>
                  <Link href={`/docs/${d.slug}`} className="docs-index-t">
                    {d.title}
                  </Link>
                  <span className="docs-index-b">{d.blurb}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <h2 id="addresses" className="docs-h2">addresses</h2>
        <p className="docs-note">
          read from the deployment file this build was made with, which is chain <span className="num">4663</span>.
        </p>
        {DEMO && (
          <p className="docs-note">
            this is the preview. the addresses below belong to the recording it replays and are not contracts on Robinhood Chain; the
            live addresses are published here at launch.
          </p>
        )}
        {DEPLOYED ? (
          <div className="table-wrap">
            <table className="docs-addr">
              <tbody>
                {CONTRACTS.map(([name, addr]) => (
                  <tr key={name}>
                    <td className="cap">{name}</td>
                    <td>
                      {DEMO ? (
                        <span className="num">{addr}</span>
                      ) : (
                        <a className="num" href={explorerAddress(addr)} target="_blank" rel="noreferrer">
                          {addr}
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted">nothing is deployed for this build yet.</p>
        )}
      </article>

      <aside className="docs-onthis" aria-label="On this page">
        <div className="docs-onthis-k">on this page</div>
        <a href="#fixed-at-launch">fixed at launch</a>
        <a href="#one-transaction">one transaction</a>
        <a href="#what-this-can-cost-you">what this can cost you</a>
        <a href="#the-pages">the pages</a>
        <a href="#addresses">addresses</a>
      </aside>
    </>
  );
}
