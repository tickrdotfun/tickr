/** Three steps, so the words on the cards mean something to someone arriving cold. One word of each title carries
 *  the accent, so the three read as name → pair → done at a glance; the rest of the card stays colourless, because
 *  on this page a hue means a launch state and spending it on body copy would dilute that. */
const STEPS = [
  { n: "1", accent: "name", after: " your coin", body: "pick a name." },
  // the newline is deliberate: `.how-body` keeps it (white-space: pre-line)
  { n: "2", before: "pick a ", accent: "pair", body: "what your coin is priced in,\ncan literally be anything." },
  { n: "3", accent: "done", body: "nice, you just created a random/unique coin, no other launchpad in the world allows this.\ncrypto will never be the same." },
] as const;

export function HowItWorks() {
  return (
    <section className="how">
      {STEPS.map((s) => (
        <div key={s.n} className="how-step">
          <span className="how-n num">{s.n}</span>
          <h3 className="how-title">
            {"before" in s ? s.before : ""}
            <span className="how-accent">{s.accent}</span>
            {"after" in s ? s.after : ""}
          </h3>
          <p className="how-body">{s.body}</p>
        </div>
      ))}
    </section>
  );
}
