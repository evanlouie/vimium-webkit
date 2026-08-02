// @ts-check
/**
 * Lint rules, carried over from the Deno configuration.
 *
 * The four rules named explicitly in `deno.json` were `no-explicit-any`,
 * `explicit-module-boundary-types`, `no-await-in-loop` and `eqeqeq`. The first,
 * third and fourth have direct equivalents here. `explicit-module-boundary-
 * types` is `explicit-module-boundary-types` in typescript-eslint too.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "test-results/**",
      "playwright-report/**",
      ".coverage/**",
      "coverage/**",
      // Browser fixtures, loaded by a page rather than compiled with the app.
      "test/fixtures/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Config files sit outside both tsconfig projects.
          allowDefaultProject: ["eslint.config.js", "*.js", "*.mjs", "*.cjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "no-await-in-loop": "error",
      eqeqeq: "error",
      // The codebase uses `interface` and `type` deliberately and both are fine.
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests reach into globals and fakes on purpose.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "off",
    },
  },
);
