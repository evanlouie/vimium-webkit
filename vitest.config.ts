/**
 * Unit tests run in Node, with no DOM.
 *
 * That is a deliberate property, and not a default. The artefact is one file
 * that is evaluated at `document-start` in every frame of every page, so any
 * work that a module does when it is imported is work that every page load
 * pays. `environment: "node"` means that a module which touches the DOM at
 * import time throws here, where there is no DOM at all. See
 * `test/unit/module-graph_test.ts`.
 *
 * A test provides a layer instead of a global. No test writes to `globalThis`,
 * so nothing is shared between two files and the run needs no serialisation.
 * Vitest may therefore use its own defaults for workers, isolation and file
 * parallelism.
 *
 * `pool: "threads"` stays, because `module-graph_test.ts` imports every module
 * of `src/`, and a thread pool starts faster than a forked process for that.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^~\//, replacement: `${root}src/` }],
  },
  test: {
    environment: "node",
    include: ["test/unit/**/*_test.ts"],
    pool: "threads",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html"],
    },
  },
});
