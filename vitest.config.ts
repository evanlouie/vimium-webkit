/**
 * Unit tests run in Node, with no DOM.
 *
 * That is a deliberate property, not a default. A userscript is one IIFE
 * evaluated at `document-start` in every frame of every page, so any work a
 * module does at import time is work every page load pays. `environment:
 * "node"` means a module that touches the DOM at import time throws here,
 * where there is no DOM at all — see `test/unit/module-graph_test.ts`.
 *
 * Tests run single-threaded for the same reason the Deno suite did: several
 * modules read ambient globals directly, and `test/unit/support/globals.ts`
 * lends `globalThis` out and takes it back. That isolation is temporal, not
 * structural, so two files must never run at once.
 *
 * `isolate: false` shares one module registry across files, which is what
 * `deno test`'s single isolate did too. It does mean `module-graph_test.ts`
 * may import a module another file has already loaded, so its "does no work at
 * import time" property is strongest when that file runs first — it is a net,
 * not a proof.
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
    maxWorkers: 1,
    isolate: false,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html"],
    },
  },
});
