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
    // Claude Code worktrees are separate checkouts with their own build
    // output. Flat config doesn't read .gitignore, and ".next/**" only
    // matches the top level, so their .next/ would be linted as source.
    ".claude/**",
  ]),
]);

export default eslintConfig;
