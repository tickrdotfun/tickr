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
require.extensions[".ts"] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f);
const src = (p) => require(path.join(__dirname, "..", "..", "src", p));
module.exports = {
  src,
  wallet: "0x00000000000000000000000000000000000000a1",
  coin: "0x1ebf16a641e5f5e1bf0ed4fa8c126ecf590523cd",
  ticker: "0xf1ff8ca3e0e7f843365b7c7c8e38a093dd0a82d0",
  factory: "0x00000000000000000000000000000000000000f1",
  hashOf: (n) => `0x${n.toString(16).padStart(64, "0")}`,
};
