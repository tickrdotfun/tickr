// Copies ../docs/*.md into web/docs/ when the repository's docs folder is there, so the markdown that
// the site renders travels inside the app. Without this a deploy rooted at web/ has no ../docs and the
// loader throws at build time.
//
// Same shape as sync-deployments.mjs: the repo is the source of truth when it is present, and the copy
// already in the tree is the fallback when it is not.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { generate } from "./gen-selectors.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "..", "docs");
const dest = resolve(here, "..", "docs");

if (!existsSync(resolve(src, "SPEC.md"))) {
  const have = existsSync(dest) ? readdirSync(dest).filter((f) => f.endsWith(".md")).length : 0;
  console.log(`docs: ../docs not found, using the ${have} markdown file(s) already in web/docs`);
  process.exit(0);
}

// the selector tables in docs 18 come from the compiled ABIs, regenerated here so the copy below carries them
generate();
mkdirSync(dest, { recursive: true });
const files = readdirSync(src).filter((f) => f.endsWith(".md"));
for (const f of files) copyFileSync(resolve(src, f), resolve(dest, f));
console.log(`docs: copied ${files.length} markdown file(s) from ${src}`);
