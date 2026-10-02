// Lint configuration for town. Run by `hack/verify.sh`.
//
// Thresholds are copied from scarab's config deliberately rather than chosen
// again: two agents working in adjacent repositories should not have different
// definitions of "too complex". Complexity limits are HARD ERRORS, not warnings --
// for an agent a threshold is a forcing function that makes code get restructured
// rather than annotated, which is the only reason to set one.
//
// Unlike scarab this is a TypeScript codebase, so the type-aware rules are on.
// `no-floating-promises` in particular earns its keep in a server: an unawaited
// promise in a request handler loses the error completely.

import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import sonarjs from "eslint-plugin-sonarjs";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// The server runs in node, the client in a browser. Both are listed rather than
// split, which is what scarab does too.
const globals = {
  process: "readonly",
  console: "readonly",
  fetch: "readonly",
  Response: "readonly",
  Request: "readonly",
  Headers: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  AbortSignal: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  document: "readonly",
  window: "readonly",
  location: "readonly",
  history: "readonly",
  HTMLElement: "readonly",
};

// `defineConfig` rather than `tseslint.config`: the latter is deprecated, and the
// former is now the standard way to assemble a flat config from presets that are
// themselves arrays.
export default defineConfig([
  { ignores: ["node_modules/**", "dist/**", "image/dist/**"] },
  js.configs.recommended,
  sonarjs.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  // The rules of hooks catch the one class of React bug that is invisible in review
  // and silent at runtime: a dependency list that is wrong.
  reactHooks.configs.flat.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals,
      parserOptions: {
        // Type information comes from the tsconfigs: the root one for the client and
        // shared code, and src/server/tsconfig.json for the server. The eslint config
        // itself belongs to neither project, so it is named explicitly -- without
        // this it is simply unlinted, which looks exactly like passing.
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      complexity: ["error", 12],
      "max-depth": ["error", 4],
      "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
      "sonarjs/cognitive-complexity": ["error", 20],
    },
  },
  {
    // Tests exist to be explicit and repetitive.
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "max-lines-per-function": "off",
      "sonarjs/no-duplicate-string": "off",
      // node:test collects the promise a test callback returns, so not awaiting
      // `test(...)` is the framework's idiom rather than a dropped error. A rejection
      // still fails the run.
      "@typescript-eslint/no-floating-promises": "off",
      // Fixtures point at a plain-HTTP control plane deliberately: pestilence is
      // cluster-internal and has no TLS, which the production default also documents.
      "sonarjs/no-clear-text-protocols": "off",
    },
  },
]);
