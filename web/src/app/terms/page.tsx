import type { Metadata } from "next";
import Link from "next/link";
import { DISCLOSURE } from "@/lib/constants";
import { DEMO } from "@/lib/demoTransport";

export const metadata: Metadata = { title: "terms", description: "what tickr is, what it cannot do, and what you accept by using it." };

/**
 * Terms written from the contracts, not from a template. Everything asserted here is checkable: the fee split is
 * frozen in `FeePolicy`, the locker has no withdrawal function, and the owner's powers are the ones enumerated in
 * `09-risks.md`. If a contract changes, this page changes with it.
 */
export default function TermsPage() {
  return (
    <div className="terms measure">
      <h1 className="page-title">terms</h1>
      <p className="text-muted">last updated 2026-09-05</p>

      {DEMO && (
        <section>
          <h2>this deployment is a preview</h2>
          <p>
            every launch, price, balance and figure on this site is a recorded snapshot of a test network. no wallet can send a transaction from
            here, and nothing you do on this deployment reaches Robinhood Chain. the rest of this page describes what happens when the contracts
            are live.
          </p>
        </section>
      )}

      <section>
        <h2>what tickr is</h2>
        <p>
          tickr is two things. it is a set of contracts on Robinhood Chain that launch coins into locked Uniswap v4 pools
          and split their fees. it is also this website, which reads those contracts and builds transactions for you to sign.
        </p>
        <p>
          the website never holds your funds or your keys, never signs for you, and cannot reach into anything it has already sent. every
          transaction is built in your browser, shown to you, and signed in your own wallet. what each one does is written down in the <Link href="/docs">docs</Link>, and{" "}
          <a href="https://github.com/tickrdotfun/tickr" target="_blank" rel="noreferrer">
            the code
          </a>{" "}
          is the final word.
        </p>
      </section>

      <section>
        <h2>what is permanent</h2>
        <p>
          a coin&apos;s name, symbol, image, description, pair, fee split and creator tax are written at launch. nobody can change them afterwards,
          including us. the whole supply goes into the coin&apos;s pool. a creator who wants some of the coin buys it from the pool like anyone else, and can
          do so in the launch transaction itself.
        </p>
        <p>
          the coin&apos;s liquidity is a Uniswap v4 position held from the first block by a contract that has no function to move anything out.
          not the creator, not the protocol, not the owner. that is permanent too, and it means the liquidity cannot be pulled and it cannot be
          recovered.
        </p>
        <p>a mistake in any of this cannot be undone. read the review step before you sign it.</p>
      </section>

      <section>
        <h2>what you pay</h2>
        <ul>
          <li>a launch fee in ETH, paid once at creation. it is read live from the factory, so the figure in the form is the figure you pay.</li>
          <li>
            a 1% pool fee, charged inside every swap. it is split at launch and frozen: under an invented ticker, 50% to the coin&apos;s creator,
            10% to the ticker club (its quote side; the coin side&apos;s club share is burned) and 40% to the protocol. on any other pair, 60% to the creator and 40% to the protocol. the coin side of
            every sell splits the same way: the creator&apos;s share and tax are theirs, in the coin; the protocol&apos;s and the club&apos;s shares are burned.
          </li>
          <li>an optional creator tax, chosen by the creator at launch, up to 2% at launch; the owner can raise that ceiling for later launches, never above 10%. it goes entirely to the creator&apos;s fee wallet.</li>
          <li>
            a snipe tax on buys in a coin&apos;s first five seconds: 99% in the launch second, falling to nothing by the fifth. it is burned. the
            launcher&apos;s wallet and its fee wallet do not pay it, and sells never do.
          </li>
        </ul>
        <p>
          every one of these is visible in the transaction before you sign it. tickr takes no share of any coin&apos;s supply, at launch or ever.
          the ticker club is described in the <Link href="/docs/anchors">docs</Link>: it pays the creators of other coins under the same
          ticker, by the buy volume their fee collections stand for. the founder&apos;s coin is captain of the club by default and counts double while it trades; it owns
          nothing and has no say over any other coin.
        </p>
      </section>

      <section>
        <h2>what the owner can and cannot do</h2>
        <p>
          the contracts have an owner. being honest about that is more useful than claiming there is nothing to trust. the owner can change the
          terms of <em>future</em> launches: the launch fee, the fee split, the creator tax ceiling, which assets can be a pair, and whether new
          launches are open at all. the owner can transfer a coin&apos;s fee recipient after a three day timelock.
        </p>
        <p>
          the owner cannot take money out of a pool, the fee escrow or the locker. cannot stop an existing coin from trading. cannot change any
          existing launch&apos;s fees, tax, pair or economics. cannot mint, freeze or blacklist a coin, and cannot touch a pool&apos;s
          liquidity. the full list, function by function, is in <Link href="/docs/risks">risks</Link>.
        </p>
      </section>

      <section>
        <h2>invented tickers and Stock Tokens</h2>
        <p>{DISCLOSURE}</p>
        <p>
          Stock Tokens are issued by Robinhood Assets. tickr reads their registry and pairs only with the addresses in it. a Stock Token is not the
          share it names, carries no shareholder rights, and can trade away from that share&apos;s price. anyone can deploy a contract that copies
          one of those names, so the create page shows you when an address is a lookalike and how many others wear the same symbol. check it.
        </p>
      </section>

      <section>
        <h2>what you are responsible for</h2>
        <ul>
          <li>being old enough and allowed to use crypto assets where you live, and not using tickr from or for anyone in a sanctioned place.</li>
          <li>
            everything you create: names, tickers, descriptions, links and images. do not use what you have no right to use, and do not impersonate
            a person, a company or an asset. the factory refuses the tickers and names of official assets. it cannot refuse everything.
          </li>
          <li>your wallet, your keys, your security, your taxes, and the laws that apply to you.</li>
        </ul>
        <p>
          we can hide anything from these pages at our discretion. that changes nothing on chain: the coin and its pool keep working
          exactly as they did, and anyone can still reach them directly.
        </p>
      </section>

      <section>
        <h2>risk, plainly</h2>
        <p>
          coins launched here are speculative. most memecoins end up worth nothing, and you can lose everything you put in. contracts can have bugs.
          networks can halt or reorganise. prices, market caps, volumes and holder counts on this site are read from public sources and can be
          wrong, late or manipulated.
        </p>
        <p>
          nothing on this site is investment, financial, legal or tax advice, and nothing here is an offer to buy or sell anything. no part of tickr
          promises that any coin will be worth anything.
        </p>
      </section>

      <section>
        <h2>no affiliation, no warranty</h2>
        <p>
          tickr is not affiliated with, endorsed by or sponsored by Robinhood Markets, Robinhood Assets, Uniswap, or any company whose name or
          ticker appears on this site. names and tickers identify assets, nothing more.
        </p>
        <p>
          the site and the contracts are provided as they are, without warranties of any kind. to the fullest extent the law allows, tickr and the
          people behind it are not liable for any loss arising from your use of the site, the coins or the contracts.
        </p>
      </section>

      <section>
        <h2>referring to tickr</h2>
        <p>
          write the name in lowercase and link to the site. do not imply a partnership, an endorsement or an official status without a
          written agreement, and do not present a service you run as run by tickr. onchain data is public and free to read; how you use it is
          on you.
        </p>
      </section>

      <section>
        <h2>changes</h2>
        <p>these terms change when the contracts or the site change. the date at the top says when that last happened.</p>
      </section>
    </div>
  );
}
