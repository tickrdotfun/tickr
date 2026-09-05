/**
 * The shape of a docs search hit, and how hits are ranked. No node imports: this half runs in the browser.
 * The index itself is built on the server by `docsIndex.ts` and handed to the search box as a prop.
 */
export type DocSection = {
  /** page slug, plus the heading anchor when the hit is inside a section */
  href: string;
  page: string;
  num: string;
  heading: string;
  /** lower-cased haystack: page title, heading, and the section's text */
  body: string;
  /** first sentences of the section, for the result's second line */
  snippet: string;
};

/**
 * Rank matches. Every word in the query must appear somewhere in the entry, so a two-word query narrows
 * instead of widening; a hit in the heading outranks a hit in the prose, and an exact phrase outranks both.
 */
export function searchDocs(index: DocSection[], query: string, limit = 8): DocSection[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const words = q.split(/\s+/).filter(Boolean);

  const scored = index
    .map((s) => {
      const heading = s.heading.toLowerCase();
      if (!words.every((w) => s.body.includes(w))) return { s, score: 0 };
      let score = 1;
      if (heading.includes(q)) score += 12;
      if (s.page.toLowerCase().includes(q)) score += 6;
      if (s.body.includes(q)) score += 4;
      for (const w of words) {
        if (heading.includes(w)) score += 3;
        if (heading.startsWith(w)) score += 2;
      }
      // a short heading that matches is usually the more precise answer
      score += Math.max(0, 3 - heading.length / 20);
      return { s, score };
    })
    .filter((r) => r.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((r) => r.s);
}
