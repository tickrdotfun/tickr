// Copies ../contracts/deployments/<chain id>.json (NEXT_PUBLIC_CHAIN_ID, default 4663) into src/lib/deployments.json when it exists,
// otherwise resets it to deployments.example.json (all-zero protocol addresses).
// Runs automatically before `pnpm dev` / `pnpm build`.
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ZERO = "0x0000000000000000000000000000000000000000";
const here = dirname(fileURLToPath(import.meta.url));
const chainId = process.env.NEXT_PUBLIC_CHAIN_ID || "4663";
const src = process.env.DEPLOY_RECORD ? resolve(here, "..", "..", "contracts", process.env.DEPLOY_RECORD) : resolve(here, "..", "..", "contracts", "deployments", `${chainId}.json`);
const example = resolve(here, "..", "src", "lib", "deployments.example.json");
const dest = resolve(here, "..", "src", "lib", "deployments.json");

if (existsSync(src)) {
  copyFileSync(src, dest);
  console.log(`deployments: copied ${src}`);
} else if (existsSync(dest) && JSON.parse(readFileSync(dest, "utf8")).factory !== ZERO) {
  // No contracts folder to read from, but the addresses already in the tree are real: this is a deploy
  // rooted at web/, so keep them rather than blanking the app. Same rule as sync-docs.mjs.
  console.log("deployments: ../contracts not found, keeping the addresses already in src/lib/deployments.json");
} else {
  copyFileSync(example, dest);
  console.log("deployments: nothing to read and nothing in the tree, using example (zero addresses)");
}

// a live build must carry real addresses: a preview replays a fixture and the coming-soon landing has no chain
{
  const live = process.env.VERCEL === "1" && process.env.NEXT_PUBLIC_DEMO !== "1" && process.env.NEXT_PUBLIC_SITE_MODE !== "soon";
  const factory = JSON.parse(readFileSync(dest, "utf8")).factory;
  const fromEnv = process.env.NEXT_PUBLIC_FACTORY; // the documented fallback the app reads when the record is zero
  if (live && (!factory || factory === ZERO) && (!fromEnv || fromEnv === ZERO)) {
    console.error("deployments: refusing a live build with a zero factory address. sync the real record first.");
    process.exit(1);
  }
}
