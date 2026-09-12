// The one fixture every offline suite starts from: deterministic test addresses for the pieces the site reads from
// its deployment record, set before any source module is loaded, so a suite passes on its own with the checked-in
// zero record. These are test values, not a deployment.
"use strict";
const fs = require("node:fs"), path = require("node:path"), ts = require("typescript");
process.env.NEXT_PUBLIC_UNIVERSAL_ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
process.env.NEXT_PUBLIC_MANAGED_TICKER_HOOK = "0x3eC51B11c1AfaaF7B084B7A31B6945413CC5Aac0";
process.env.NEXT_PUBLIC_POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
process.env.NEXT_PUBLIC_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
process.env.NEXT_PUBLIC_FACTORY = "0x00000000000000000000000000000000000000f1";
// the suites never read the checked-in deployment record: it is replaced, in this process only, by the example's
// zero addresses, so the environment above is what every module sees, on any machine and with any record
const recordPath = path.join(__dirname, "..", "..", "src", "lib", "deployments.json");
const example = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "src", "lib", "deployments.example.json"), "utf8"));
require.cache[recordPath] = { id: recordPath, filename: recordPath, loaded: true, exports: example };
require.extensions[".ts"] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f);
// the `@/` alias, resolved as Next resolves it, so a module that imports through it loads here as it does in the site
const SRC = path.join(__dirname, "..", "..", "src");
const Module = require("node:module");
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req.startsWith("@/")) {
    const base = path.join(SRC, req.slice(2));
    for (const f of [base, base + ".ts", base + ".tsx", path.join(base, "index.ts")]) if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return resolveFilename.call(this, req, ...rest);
};
const src = (p) => require(path.join(SRC, p));
module.exports = {
  src,
  wallet: "0x00000000000000000000000000000000000000a1",
  coin: "0x1ebf16a641e5f5e1bf0ed4fa8c126ecf590523cd",
  ticker: "0xf1ff8ca3e0e7f843365b7c7c8e38a093dd0a82d0",
  factory: "0x00000000000000000000000000000000000000f1",
  hashOf: (n) => `0x${n.toString(16).padStart(64, "0")}`,
};
