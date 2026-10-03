/**
 * The Vite configuration of `build/build.ts`, and the facts of each build mode.
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

import type { Record } from "effect";
import { fileURLToPath } from "node:url";
import type { InlineConfig } from "vite";

export const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/**
 * Safari 16.4 is the floor (`adoptedStyleSheets` on `ShadowRoot`), so the
 * bundler must not emit anything newer. `safari16` also keeps private class
 * fields and `??=` intact rather than down-levelling them into helpers.
 */
export const BUILD_TARGET = ["safari16", "chrome111", "firefox101"];

/** What a bundle is for, and everything that follows from it. */
export interface BuildMode {
  /** The `NODE_ENV` that the bundle sees. */
  readonly nodeEnv: string;
  readonly sourcemap: "inline" | false;
  /**
   * oxc and not esbuild: oxc gives the smaller artefact (397 KB against 426 KB
   * when measured). Treating property reads as pure saves 3 KB, and it can
   * delete a DOM read that is there to force layout, so it stays off.
   */
  readonly minify: "oxc" | false;
  /** The artefact, under `dist/`. */
  readonly file: string;
  /** The name that the manager shows. A dev bundle says that it is one. */
  readonly name: string;
  /**
   * Whether the build writes `meta.js`, the update manifest.
   *
   * `@updateURL` points at it, so a dev block there would tell every
   * installed copy that the current release is called "Vimium-WebKit (dev)".
   */
  readonly manifest: boolean;
}

/**
 * Every build mode, with all of its facts in one place.
 *
 * `production` is the artefact that ships, and the only one that `@updateURL`
 * may name. `development` is the dev bundle, unminified, with its sourcemap
 * inline.
 */
export const MODES: Record.ReadonlyRecord<"production" | "development", BuildMode> = {
  production: {
    nodeEnv: "production",
    sourcemap: false,
    minify: "oxc",
    file: "vimium-webkit.user.js",
    name: "Vimium-WebKit",
    manifest: true,
  },
  development: {
    nodeEnv: "development",
    sourcemap: "inline",
    minify: false,
    file: "vimium-webkit.dev.user.js",
    name: "Vimium-WebKit (dev)",
    manifest: false,
  },
};

export interface BundleOptions {
  readonly entry: string;
  readonly mode: BuildMode;
}

export const bundleConfig = (options: BundleOptions): InlineConfig => ({
  root: ROOT,
  logLevel: "warn",
  configFile: false,
  resolve: {
    alias: [{ find: /^~\//, replacement: `${ROOT}/src/` }],
  },
  define: {
    // Nothing bundled here should ever take a Node branch.
    "process.env.NODE_ENV": JSON.stringify(options.mode.nodeEnv),
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
    minify: options.mode.minify,
    sourcemap: options.mode.sourcemap,
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
