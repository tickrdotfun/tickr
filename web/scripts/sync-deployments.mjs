// Copies ../contracts/deployments/<chain id>.json (NEXT_PUBLIC_CHAIN_ID, default 4663) into src/lib/deployments.json when it exists,
// otherwise resets it to deployments.example.json (all-zero protocol addresses).
// Runs automatically before `pnpm dev` / `pnpm build`.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { getAddress } from "viem";
import { liveProblems, missingRequired } from "./lib/recordSchema.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ZERO = "0x0000000000000000000000000000000000000000";
const here = dirname(fileURLToPath(import.meta.url));
const chainId = process.env.NEXT_PUBLIC_CHAIN_ID || "4663";
const src = process.env.DEPLOY_RECORD ? resolve(here, "..", "..", "contracts", process.env.DEPLOY_RECORD) : resolve(here, "..", "..", "contracts", "deployments", `${chainId}.json`);
const example = resolve(here, "..", "src", "lib", "deployments.example.json");
const dest = resolve(here, "..", "src", "lib", "deployments.json");

let origin = "example";
if (existsSync(src)) {
  copyFileSync(src, dest);
  origin = "copied";
  console.log(`deployments: copied ${src}`);
} else if (existsSync(dest) && JSON.parse(readFileSync(dest, "utf8")).factory !== ZERO) {
  origin = "kept";
  // No contracts folder to read from, but the addresses already in the tree are real: this is a deploy
  // rooted at web/, so keep them rather than blanking the app. Same rule as sync-docs.mjs.
  console.log("deployments: ../contracts not found, keeping the addresses already in src/lib/deployments.json");
} else {
  copyFileSync(example, dest);
  console.log("deployments: nothing to read and nothing in the tree, using example (zero addresses)");
}

// every address in the record is written in its checksummed form: a mixed-case value with the wrong case is not an
// address to the client library, and the record is what the site and its tests read
{
  const record = JSON.parse(readFileSync(dest, "utf8"));
  let fixed = 0;
  for (const [k, v] of Object.entries(record)) {
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) continue;
    const c = getAddress(v);
    if (c !== v) { record[k] = c; fixed++; }
  }
  if (fixed) { writeFileSync(dest, JSON.stringify(record, null, 2) + "\n"); console.log(`deployments: ${fixed} address(es) rewritten in checksum form`); }
}

// a live build must carry real addresses: a preview replays a fixture and the coming-soon landing has no chain
{
  // a live build is any build that is neither the preview nor the coming-soon page, on any host
  const live = (process.env.VERCEL === "1" || process.env.CF_LIVE === "1" || process.env.CI === "true") && process.env.NEXT_PUBLIC_DEMO !== "1" && process.env.NEXT_PUBLIC_SITE_MODE !== "soon";
  const record = JSON.parse(readFileSync(dest, "utf8"));
  const missing = missingRequired(record, process.env);
  if (live && missing.length) {
    console.error(`deployments: refusing a live build with zero addresses for ${missing.join(", ")}. sync the real record first.`);
    process.exit(1);
  }
  if (live) {
    // the record must be the one written for this chain, read from the contracts folder now, well formed, complete
    // after genesis, and activated: the schema and the checks live in scripts/lib/recordSchema.mjs, with their test
    const problems = liveProblems(record, { chainId, origin, src, env: process.env });
    if (problems.length) {
      console.error(`deployments: refusing a live build: ${problems.join("; ")}.`);
      process.exit(1);
    }
  }
}
