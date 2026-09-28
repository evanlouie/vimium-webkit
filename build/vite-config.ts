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
 * The shipped artefact is a single IIFE, minified by oxc: compressed, with
 * mangled names and no comments. Every frame of every page parses it at
 * `document-start`, so its size is paid on each page load. The dev bundle stays
 * unminified, with an inline sourcemap, for debugging.
 */

import { Data, type Record, pipe } from "effect";
import { fileURLToPath } from "node:url";
import type { InlineConfig } from "vite";

export const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/**
 * Safari 16.4 is the floor (`adoptedStyleSheets` on `ShadowRoot`), so the
 * bundler must not emit anything newer. `safari16` also keeps private class
 * fields and `??=` intact rather than down-levelling them into helpers.
 */
export const BUILD_TARGET = ["safari16", "chrome111", "firefox101"];

/**
 * What a bundle is for.
 *
 * `Development` is the dev bundle, with its sourcemap inline. `Production` is
 * the artefact that ships, and the only one that `@updateURL` may name.
 */
export type BuildMode = Data.TaggedEnum<{
  Development: Record.ReadonlyRecord<never, never>;
  Production: Record.ReadonlyRecord<never, never>;
}>;

export const BuildMode = Data.taggedEnum<BuildMode>();

export interface BundleOptions {
  readonly entry: string;
  readonly mode: BuildMode;
}

/** The `NODE_ENV` that the bundle sees. */
const nodeEnv: (mode: BuildMode) => string = BuildMode.$match({
  Development: () => "development",
  Production: () => "production",
});

const sourcemap: (mode: BuildMode) => "inline" | false = BuildMode.$match({
  Development: () => "inline" as const,
  Production: () => false as const,
});

/**
 * oxc and not esbuild: oxc gives the smaller artefact (397 KB against 426 KB
 * when measured). Treating property reads as pure saves 3 KB, and it can
 * delete a DOM read that is there to force layout, so it stays off.
 */
const minifier: (mode: BuildMode) => "oxc" | false = BuildMode.$match({
  Development: () => false as const,
  Production: () => "oxc" as const,
});

export const bundleConfig = (options: BundleOptions): InlineConfig => ({
  root: ROOT,
  logLevel: "warn",
  configFile: false,
  resolve: {
    alias: [{ find: /^~\//, replacement: `${ROOT}/src/` }],
  },
  define: {
    // Nothing bundled here should ever take a Node branch.
    "process.env.NODE_ENV": pipe(options.mode, nodeEnv, JSON.stringify),
    // Effect reads `globalThis.process` for `hrtime`. That is harmless in
    // Node and not harmless here: a page or a sandboxing manager can make
    // `process` an accessor that *throws*, and this artefact is one IIFE
    // evaluated at `document-start`, so a throw there takes the whole
    // extension with it, before a single key is pressed. The substitution
    // leaves nothing to evaluate.
    "globalThis.process": "undefined",
  },
  build: {
    write: false,
    target: BUILD_TARGET,
    minify: pipe(options.mode, minifier),
    sourcemap: pipe(options.mode, sourcemap),
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
        // stays at its default. With the minifier on, forcing it to `false`
        // no longer makes the artefact any smaller.
        generatedCode: { preset: "es2015", symbols: false },
      },
    },
  },
});
