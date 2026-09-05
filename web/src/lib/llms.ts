import { ALL_DOCS, DOC_GROUPS, rawDoc } from "./docs";
import { TAGLINE } from "./constants";

/**
 * Machine-readable copies of the documentation.
 *
 * The site renders the repository's markdown, so the markdown itself is the better artefact for anything
 * that reads rather than looks: an agent gets the source instead of scraping headings back out of HTML.
 * Shapes follow the llms.txt convention: a short index at /llms.txt and the whole corpus at
 * /llms-full.txt, both plain text, plus one raw file per page.
 */

const RULES = [
  "every figure here is a constant in the contracts, not a projection",
  "a coin's pair is chosen at launch and frozen with it, and so is its fee split",
  "an invented ticker is a one-for-one wrapper of USDG and is not the asset it is named after",
];

export function llmsIndex(origin: string): string {
  const lines: string[] = [
    "# tickr",
    "",
    `> ${TAGLINE} tickr launches coins on Robinhood Chain and prices each one against a pair the creator picks at launch: ETH, USDG, a Stock Token, a coin launched here, or a ticker that does not exist yet and is created on the spot.`,
    "",
    "This file indexes the protocol documentation. Every page below is the markdown the site itself renders, so it is the source rather than a summary of it.",
    "",
    ...RULES.map((r) => `- ${r}`),
    "",
  ];

  for (const g of DOC_GROUPS) {
    lines.push(`## ${g.num}. ${g.label}`, "");
    for (const [i, d] of g.items.entries()) {
      lines.push(`- [${g.num}.${i + 1} ${d.title}](${origin}/docs/${d.slug}.md): ${d.blurb}`);
    }
    lines.push("");
  }

  lines.push(
    "## Everything at once",
    "",
    `- [the whole corpus, one file](${origin}/llms-full.txt): every page above, concatenated`,
    `- [the same as a download](${origin}/tickr-docs.md): identical content, served as an attachment`,
    "",
  );
  return lines.join("\n");
}

export function llmsFull(origin: string): string {
  const out: string[] = [
    "# tickr protocol documentation",
    "",
    `> ${TAGLINE} Generated from ${origin}. Every page is the markdown authored in the repository, in specification order.`,
    "",
    ...RULES.map((r) => `- ${r}`),
    "",
    "---",
    "",
  ];

  for (const g of DOC_GROUPS) {
    for (const [i, d] of g.items.entries()) {
      out.push(`<!-- ${g.num}.${i + 1} ${d.title} | ${origin}/docs/${d.slug} -->`, "", rawDoc(d).trimEnd(), "", "---", "");
    }
  }
  return out.join("\n");
}

export const DOC_COUNT = ALL_DOCS.length;
