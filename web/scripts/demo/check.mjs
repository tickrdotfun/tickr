// Drives a running site the way a visitor would and counts replay misses: home, the first token pages with their
// tabs, and the create page. `node scripts/demo/check.mjs http://localhost:3100` for a local demo build,
// or a deployed preview. Prints the misses per page and whether the club tab shows its captain.
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:3100").replace(/\/$/, "");
const b = await chromium.launch();
const pg = await b.newPage();
let total = 0;
const report = [];

async function misses(label) {
  const m = await pg.evaluate(() => (window.__demoMisses ?? []).length).catch(() => 0);
  total += m;
  report.push(`${label}: ${m} misses`);
}
const clickByText = async (sel, text, wait = 2500) => {
  for (const el of await pg.$$(sel)) {
    if ((await el.innerText().catch(() => "")).trim().toLowerCase() === text) {
      await el.click().catch(() => {});
      await pg.waitForTimeout(wait);
      return true;
    }
  }
  return false;
};

await pg.goto(`${base}/`, { waitUntil: "networkidle" });
await pg.waitForTimeout(2500);
await misses("home");
const hrefs = await pg.$$eval('a[href^="/t/"]', (as) => [...new Set(as.map((a) => a.getAttribute("href")))].slice(0, 6));
let captainSeen = false;
let clubSeen = false;
for (const href of hrefs) {
  await pg.goto(`${base}${href}`, { waitUntil: "networkidle" });
  await pg.waitForTimeout(2500);
  // every detail tab, the club among them, then both trade sides
  for (const el of await pg.$$(".detail-tab")) {
    await el.click().catch(() => {});
    await pg.waitForTimeout(2200);
    const text = (await pg.innerText("body").catch(() => "")).toLowerCase();
    if (text.includes("counts double")) clubSeen = true;
    if (text.includes("captain ×2") || text.includes("captain, counts double")) captainSeen = true;
  }
  for (const t of ["sell", "buy"]) await clickByText(".tab", t, 1500);
  await misses(`token ${href}`);
}
await pg.goto(`${base}/create`, { waitUntil: "networkidle" });
await pg.waitForTimeout(2500);
await misses("create");
await b.close();
console.log(report.join("\n"));
console.log(`total misses: ${total}; club tab seen: ${clubSeen}; captain row seen: ${captainSeen}`);
process.exit(total === 0 ? 0 : 1);
