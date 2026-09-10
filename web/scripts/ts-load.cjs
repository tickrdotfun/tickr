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
// the product uses the "@/..." alias that tsconfig maps to src/. node does not know it, so map it here or
// every module that imports a sibling by alias fails to load under test.
const Module = require("node:module");
const SRC = path.join(__dirname, "..", "src");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(SRC, request.slice(2));
  return resolve.call(this, request, ...rest);
};

module.exports = { src: (p) => require(path.join(SRC, p)) };
