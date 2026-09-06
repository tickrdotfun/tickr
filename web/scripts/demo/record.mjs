import { chromium } from "playwright";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../../public/demo-rpc.json", import.meta.url));
const RPC = "127.0.0.1:8545";
// keep everything already recorded; this pass only adds what interaction reaches
const map = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
const before = Object.keys(map).length;
const key = (m, p) => `${m}|${JSON.stringify(p ?? []).toLowerCase()}`;

const b = await chromium.launch();

function attach(pg) {
  pg.on("response", async (res) => {
    if (!res.url().includes(RPC)) return;
    let rq, rs;
    try { rq = JSON.parse(res.request().postData() ?? "null"); rs = await res.json(); } catch { return; }
    const reqs = Array.isArray(rq) ? rq : [rq];
    const ress = Array.isArray(rs) ? rs : [rs];
    const byId = new Map(ress.map((r) => [r?.id, r]));
    for (const r of reqs) {
      const a = byId.get(r?.id) ?? ress[0];
      if (r?.method && a && a.error === undefined) map[key(r.method, r.params)] = a.result;
    }
  });
}

const clickByText = async (pg, sel, text, wait = 3500) => {
  for (const el of await pg.$$(sel)) {
    if ((await el.innerText().catch(() => "")).trim().toLowerCase() === text) {
      await el.click().catch(() => {});
      await pg.waitForTimeout(wait);
      return true;
    }
  }
  return false;
};

// ---- the create page: every pair option, and the stock list scrolled to the bottom
{
  const pg = await b.newPage({ viewport: { width: 1440, height: 1400 } });
  attach(pg);
  await pg.goto("http://localhost:3000/create", { waitUntil: "load" });
  await pg.waitForTimeout(5000);
  for (const opt of ["stock tokens", "usdg", "eth", "another coin", "anything"]) {
    const hit = await clickByText(pg, ".seg-item, .tab", opt, 5000);
    if (hit && opt === "stock tokens") {
      // 194 rows: scroll the whole list so anything lazy fires
      for (let i = 0; i < 14; i++) {
        await pg.mouse.wheel(0, 1400);
        await pg.waitForTimeout(700);
      }
      await pg.waitForTimeout(3000);
    }
    // one pair card of each kind, so the card's chain reads are in the recording
    if (hit && (opt === "stock tokens" || opt === "another coin")) {
      const row = await pg.$(".row-card:not([disabled])");
      if (row) {
        await row.click().catch(() => {});
        await pg.waitForTimeout(5000);
        console.log(`  ${opt}: first row clicked (pair card)`);
      }
    }
    console.log(opt, hit ? "clicked" : "not found", Object.keys(map).length);
  }
  await clickByText(pg, ".seg-item, .tab", "existing ticker", 4000);
  {
    const row = await pg.$(".row-card:not([disabled])");
    if (row) {
      await row.click().catch(() => {});
      await pg.waitForTimeout(5000);
      console.log("  existing ticker: first row clicked (pair card)");
    }
  }
  await clickByText(pg, ".seg-item, .tab", "new ticker", 3000);
  await pg.close();
}

// ---- the terms
{
  const pg = await b.newPage({ viewport: { width: 1440, height: 1400 } });
  attach(pg);
  await pg.goto("http://localhost:3000/terms", { waitUntil: "load" });
  await pg.waitForTimeout(1500);
  await pg.close();
}

// ---- the home page: every sort and window
{
  const pg = await b.newPage({ viewport: { width: 1440, height: 1400 } });
  attach(pg);
  await pg.goto("http://localhost:3000/", { waitUntil: "load" });
  await pg.waitForTimeout(5000);
  // every coin the home page can show under any sort or window: the list is capped, and the cap shows a different
  // set for each ordering, so the links are gathered after every click and the union is what gets recorded
  const found = new Set();
  const gather = async () => {
    for (const h of await pg.evaluate(() => [...document.querySelectorAll('a[href^="/t/"]')].map((a) => a.getAttribute("href")))) found.add(h);
  };
  await gather();
  for (const t of ["market cap", "volume", "recent buys", "newest", "24h", "7d", "all time"]) {
    await clickByText(pg, "button, a", t, 2200);
    await gather();
  }
  await pg.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await pg.waitForTimeout(3000);
  await gather();
  const links = [...found];
  await pg.close();

  // ---- every token page, every detail tab, both trade sides
  for (const href of [...new Set(links)]) {
    const tp = await b.newPage({ viewport: { width: 1440, height: 1400 } });
    attach(tp);
    await tp.goto(`http://localhost:3000${href}`, { waitUntil: "load" });
    await tp.waitForTimeout(5000);
    for (const el of await tp.$$(".detail-tab")) { await el.click().catch(() => {}); await tp.waitForTimeout(2200); }
    for (const t of ["sell", "buy"]) await clickByText(tp, ".tab", t, 2200);
    await tp.close();
    console.log(href, Object.keys(map).length);
  }
}

fs.writeFileSync(OUT, JSON.stringify(map));
console.log(`recorded ${Object.keys(map).length} unique calls (was ${before}); ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`);
await b.close();
