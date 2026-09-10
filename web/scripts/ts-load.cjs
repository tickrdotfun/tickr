// Load the product's own TypeScript modules against the real deployment record, with no test overrides.
"use strict";
const fs = require("node:fs"), path = require("node:path"), ts = require("typescript");
require.extensions[".ts"] = (m, f) =>
  m._compile(
    ts.transpileModule(fs.readFileSync(f, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText,
    f,
  );
module.exports = { src: (p) => require(path.join(__dirname, "..", "src", p)) };
