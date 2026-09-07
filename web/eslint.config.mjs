import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // build outputs of the Cloudflare adapter and wrangler, never sources
    ".open-next/**",
    ".wrangler/**",
  ]),
  // the offline suites and the fork tooling are plain Node scripts: CommonJS `require` is how they load
  {
    files: ["scripts/**"],
    rules: { "@typescript-eslint/no-require-imports": "off", "@typescript-eslint/no-explicit-any": "off" },
  },
]);

export default eslintConfig;
