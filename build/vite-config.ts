/**
 * The one Vite configuration, shared by the CLI and by `build/build.ts`.
 *
 * Vite is here for a single measured reason. esbuild tree-shakes Effect's
 * barrel export badly: `import { Effect } from "effect"` costs 1212 KB under
 * esbuild and 497 KB under Vite, and Vite's output is byte-identical whether
 * the import is a barrel or a deep path. That is what lets this codebase use
 * the import style the Effect documentation uses, instead of a house rule
 * nobody would remember.
 *
 * The shipped artefact stays a single unminified IIFE. Unminified is not
 * laziness: Greasy Fork measures its size ceiling unminified, its reviewers
 * read the source, and a userscript a user cannot audit is one they should not
 * install.
 */

import { fileURLToPath } from "node:url";
import type { InlineConfig, Plugin } from "vite";

export const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(
  /\/$/,
  "",
);

/**
 * Safari 16.4 is the floor (`adoptedStyleSheets` on `ShadowRoot`), so the
 * bundler must not emit anything newer. `safari16` also keeps private class
 * fields and `??=` intact rather than down-levelling them into helpers.
 */
export const BUILD_TARGET = ["safari16", "chrome111", "firefox101"];

export interface BundleOptions {
  readonly entry: string;
  readonly dev: boolean;
  /** Only for measurement; the shipped artefact is never minified. */
  readonly minify?: boolean;
}

/**
 * Remove every read of `process` from the output.
 *
 * Effect probes `typeof process === "object"` for `hrtime`, for a TTY and for
 * Bun. That is harmless in Node and not harmless here: a page or a sandboxing
 * manager can make `process` an accessor that *throws*, and this artefact is
 * one IIFE evaluated at `document-start`, so a throw there takes the whole
 * extension with it — Stage 0 included, before a single key is pressed.
 *
 * `build/invariants.ts` already bans exactly this pattern for `navigator` and
 * `unsafeWindow`, with exactly this reasoning; it scans `src/` only, so a
 * dependency walked in underneath the rule.
 *
 * A `define` cannot express this: its keys must be identifiers or dotted
 * paths, and rewriting bare `process` would corrupt the `process.env.NODE_ENV`
 * substitution. Rewriting the `typeof` test is narrower and leaves nothing to
 * evaluate.
 */
const stripProcessProbes = (): Plugin => ({
  name: "vimium:strip-process-probes",
  renderChunk(code) {
    const stripped = code.replaceAll(
      /typeof process === "object"/g,
      "false",
    );
    return stripped === code ? null : { code: stripped, map: null };
  },
});

export const bundleConfig = (options: BundleOptions): InlineConfig => ({
  root: ROOT,
  logLevel: "warn",
  plugins: [stripProcessProbes()],
  configFile: false,
  resolve: {
    alias: [{ find: /^~\//, replacement: `${ROOT}/src/` }],
  },
  define: {
    // Nothing bundled here should ever take a Node branch.
    "process.env.NODE_ENV": JSON.stringify(
      options.dev ? "development" : "production",
    ),
    // The property reads the `typeof` rewrite below leaves behind in dead
    // branches. Substituting them means the name `process` does not survive
    // into the artefact at all, so the invariant can ban it outright rather
    // than having to reason about which occurrences are reachable.
    "process.hrtime": "undefined",
    "process.stdout": "undefined",
    "process.isBun": "undefined",
  },
  build: {
    write: false,
    target: BUILD_TARGET,
    minify: options.minify === true ? "esbuild" : false,
    sourcemap: options.dev ? "inline" : false,
    reportCompressedSize: false,
    modulePreload: false,
    cssCodeSplit: false,
    lib: {
      entry: options.entry,
      formats: ["iife"],
      name: "VimiumWebKit",
      fileName: () => "vimium-webkit.js",
    },
    rollupOptions: {
      // A userscript is one file. Nothing may be external, and nothing may be
      // split out into a chunk the manager would never fetch.
      external: [],
      output: {
        // Vite 8 disables code splitting for IIFE library builds. Its
        // `inlineDynamicImports` option is redundant and produces a warning.
        // Effect relies on module-level initialisation, so `moduleSideEffects`
        // must stay at its default. Forcing it to `false` produced a bundle 60%
        // smaller that threw on load. See `build/verify-bundle.ts`.
        generatedCode: { preset: "es2015", symbols: false },
      },
    },
  },
});
