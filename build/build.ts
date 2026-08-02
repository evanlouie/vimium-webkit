/**
 * The build.
 *
 * A single unminified IIFE, per §9. Unminified is not laziness: Greasy Fork's
 * size ceiling is measured *unminified*, its reviewers read the source, and a
 * userscript that a user cannot audit is one they should not install.
 *
 *   npm run build          production bundle + invariant checks
 *   npm run build:dev      dev bundle, sourcemap inline, invariants relaxed
 *   npm run watch          rebuild on change
 */

import { watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { OutputChunk, RollupOutput } from "rollup";
import { build as viteBuild } from "vite";
import { defaultSettings } from "~/settings/schema.ts";
import { checkInvariants, formatViolations } from "./invariants.ts";
import { BANNER_NOTICE, buildMetadata } from "./metadata.ts";
import { verifyBundleBoots } from "./verify-bundle.ts";
import { bundleConfig, type BundleOptions, ROOT } from "./vite-config.ts";

const DIST = `${ROOT}/dist`;
const REPOSITORY = "https://github.com/evanlouie/vimium-webkit";

const byteLength = (text: string): number =>
  new TextEncoder().encode(text).length;

const readVersion = async (): Promise<string> => {
  const raw: unknown = JSON.parse(
    await readFile(`${ROOT}/package.json`, "utf8"),
  );
  const version = (raw as { readonly version?: unknown }).version;
  if (typeof version !== "string") {
    throw new Error("package.json has no string `version`");
  }
  return version;
};

/** The single entry chunk Vite produced for a library build. */
const entryChunk = (result: unknown): OutputChunk => {
  const outputs = (Array.isArray(result)
    ? (result[0] as RollupOutput).output
    : (result as RollupOutput).output) ?? [];
  const chunk = outputs.find(
    (item): item is OutputChunk => item.type === "chunk" && item.isEntry,
  );
  if (!chunk) throw new Error("Vite produced no entry chunk");
  return chunk;
};

const bundle = async (options: BundleOptions): Promise<OutputChunk> =>
  entryChunk(await viteBuild(bundleConfig(options)));

/**
 * Stage 0's cost, measured on its own.
 *
 * The shipping artefact is a single IIFE, so "the Stage 0 chunk" is not a real
 * file. Bundling `boot/stage0.ts` in isolation is the honest proxy for what an
 * engine has to parse and execute before the user presses a key.
 *
 * Minified, deliberately. A bundler preserves JSDoc in an unminified bundle, so
 * measuring the readable output made the budget a tax on comments — a rule that
 * fires when someone explains a subtlety is a rule that gets the comment
 * deleted instead.
 */
const measureStage0 = async (): Promise<number> => {
  const chunk = await bundle({
    entry: `${ROOT}/src/boot/stage0.ts`,
    dev: false,
    minify: true,
  });
  return byteLength(chunk.code);
};

interface ModuleSize {
  readonly module: string;
  readonly bytes: number;
}

/** Per-module contribution to the bundle, largest first. */
const sizeReport = (chunk: OutputChunk): readonly ModuleSize[] =>
  Object.entries(chunk.modules)
    .map(([module, meta]) => ({
      module: module.startsWith(ROOT)
        ? module.slice(ROOT.length + 1)
        : module.replace(/^\0/, ""),
      bytes: meta.renderedLength,
    }))
    .filter((entry) => entry.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);

const main = async (): Promise<void> => {
  const dev = process.argv.includes("--dev");
  const watching = process.argv.includes("--watch");
  const version = await readVersion();

  await mkdir(DIST, { recursive: true });

  const metadata = buildMetadata({
    version,
    repository: REPOSITORY,
    downloadUrl: `${REPOSITORY}/releases/latest/download/vimium-webkit.user.js`,
    updateUrl: `${REPOSITORY}/releases/latest/download/vimium-webkit.meta.js`,
    dev,
  });

  const build = async (): Promise<boolean> => {
    const chunk = await bundle({ entry: `${ROOT}/src/main.ts`, dev });
    const output = `${metadata}${BANNER_NOTICE}\n${chunk.code}`;
    const artefact = `${DIST}/vimium-webkit${dev ? ".dev" : ""}.user.js`;

    await writeFile(artefact, output);
    await writeFile(`${DIST}/vimium-webkit.meta.js`, metadata);

    // The shipped defaults, as data.
    //
    // The e2e harness needs them, and it runs under Playwright's own module
    // loader, which resolves neither the `~/` alias nor the bundler's aliases.
    // A hand-copied literal was the alternative, and the one that used to live
    // there had already drifted to a single search engine against the five
    // here — so the harness seeded settings that no user has.
    await writeFile(
      `${DIST}/default-settings.json`,
      `${JSON.stringify(defaultSettings(), null, 2)}\n`,
    );

    await writeFile(
      `${DIST}/report.json`,
      `${
        JSON.stringify(
          {
            version,
            totalBytes: byteLength(output),
            modules: sizeReport(chunk),
          },
          null,
          2,
        )
      }\n`,
    );

    const stage0Bytes = await measureStage0();
    const violations = await checkInvariants({
      root: ROOT,
      bundle: output,
      stage0Bytes,
      declaredVersion: version,
      metadataBlock: metadata,
    });

    const totalKb = (byteLength(output) / 1024).toFixed(1);
    console.log(
      `vimium-webkit ${version} — ${totalKb} KB, Stage 0 ${
        (stage0Bytes / 1024).toFixed(1)
      } KB`,
    );

    if (violations.length > 0) {
      console.error(`\n${violations.length} invariant violation(s):`);
      console.error(formatViolations(violations));
      return false;
    }

    // Size is not correctness. A bundle that tree-shakes away a module Effect
    // needs at load time is smaller *and* dead, and only running it says so.
    const boot = await verifyBundleBoots(artefact);
    if (!boot.ok) {
      console.error(`\nthe bundle does not boot: ${boot.error}`);
      return false;
    }

    console.log("all invariants hold; bundle boots");
    return true;
  };

  if (!watching) {
    if (!(await build())) process.exit(1);
    return;
  }

  await build();
  console.log("watching src/ …");
  let pending: NodeJS.Timeout | undefined;
  watch(`${ROOT}/src`, { recursive: true }, () => {
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      void build();
    }, 120);
  });
};

await main();
