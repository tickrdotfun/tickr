/** Three steps, so the words on the cards mean something to someone arriving cold. Deliberately colourless:
 *  on this page a hue means a launch state, and spending it here would dilute that. */
const STEPS = [
  { n: "1", title: "name your coin", body: "pick a name." },
  { n: "2", title: "pick a pair", body: "what your coin is priced in. type any ticker and a new one is created in the same transaction." },
  { n: "3", title: "done", body: "one transaction and it is live. the whole supply goes into the pool, locked, and you earn a cut of every trade." },
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
