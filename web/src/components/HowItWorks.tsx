/** Three steps, so the words on the cards mean something to someone arriving cold. Deliberately colourless:
 *  on this page a hue means a launch state, and spending it here would dilute that. */
const STEPS = [
  { n: "1", title: "name a pair", body: "type any ticker. if it is new, it is created in the same transaction: a one-for-one wrapper of usdg with that name." },
  { n: "2", title: "launch", body: "one transaction deploys the coin and opens its uniswap v4 pool with the whole supply in a position nobody can withdraw." },
  { n: "3", title: "trade", body: "the pool is live from its first block. anyone can buy with ETH whatever the pair is, and the fee goes to the creator." },
] as const;

export function HowItWorks() {
  return (
    <section className="how">
      {STEPS.map((s) => (
        <div key={s.n} className="how-step">
          <span className="how-n num">{s.n}</span>
          <h3 className="how-title">{s.title}</h3>
          <p className="how-body">{s.body}</p>
        </div>
      ))}
    </section>
  );
}
