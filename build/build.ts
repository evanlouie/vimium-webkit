/**
 * The build.
 *
 * A single unminified IIFE, per §9. Unminified is not laziness: Greasy Fork's
 * size ceiling is measured *unminified*, its reviewers read the source, and a
 * userscript that a user cannot audit is one they should not install.
 *
 *   deno task build          production bundle + invariant checks
 *   deno task build:dev      dev bundle, sourcemap inline, invariants relaxed
 *   deno task watch          rebuild on change
 */

import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";
import { ensureDir } from "@std/fs";
import { fromFileUrl, resolve } from "@std/path";
import { BANNER_NOTICE, buildMetadata } from "./metadata.ts";
import { checkInvariants, formatViolations } from "./invariants.ts";
import { defaultSettings } from "~/settings/schema.ts";

const ROOT = resolve(fromFileUrl(import.meta.url), "../..");
const DIST = `${ROOT}/dist`;
const REPOSITORY = "https://github.com/evanlouie/vimium-webkit";

/**
 * Bridge the loader's vendored esbuild types onto the pinned esbuild release.
 *
 * `@luca/esbuild-deno-loader` ships its own copy of esbuild's declarations, and
 * they lag the version we depend on (`entryPoints` gained an object form). The
 * plugin objects are structurally identical at runtime; only the `.d.ts` files
 * disagree. The cast goes through `unknown` rather than `any` so it stays
 * local, explicit, and greppable.
 */
const loaderPlugins = (): esbuild.Plugin[] =>
  denoPlugins({
    configPath: `${ROOT}/deno.json`,
  }) as unknown as esbuild.Plugin[];

interface DenoConfig {
  readonly version?: unknown;
}

const readVersion = async (): Promise<string> => {
  const raw: unknown = JSON.parse(await Deno.readTextFile(`${ROOT}/deno.json`));
  const version = (raw as DenoConfig).version;
  if (typeof version !== "string") {
    throw new Error("deno.json has no string `version`");
  }
  return version;
};

interface BundleOptions {
  readonly entry: string;
  readonly dev: boolean;
  /** Only for measurement; the shipped artefact is never minified. */
  readonly minify?: boolean;
}

const bundle = async (options: BundleOptions): Promise<string> => {
  const result = await esbuild.build({
    plugins: loaderPlugins(),
    entryPoints: [options.entry],
    bundle: true,
    write: false,
    format: "iife",
    // Safari 16.4 is the floor (`adoptedStyleSheets` on `ShadowRoot`), so
    // esbuild must not emit anything newer. `safari16` also keeps private class
    // fields and `??=` intact rather than down-levelling them into helpers.
    target: ["safari16", "chrome111", "firefox101"],
    platform: "browser",
    charset: "utf8",
    legalComments: "inline",
    minify: options.minify === true,
    sourcemap: options.dev ? "inline" : false,
    treeShaking: true,
    define: {
      // Neither bundled dependency should ever take a Node branch.
      "process.env.NODE_ENV": JSON.stringify(
        options.dev ? "development" : "production",
      ),
    },
  });

  const file = result.outputFiles?.[0];
  if (!file) throw new Error(`esbuild produced no output for ${options.entry}`);
  return file.text;
};

/**
 * Stage 0's cost, measured on its own.
 *
 * The shipping artefact is a single IIFE, so "the Stage 0 chunk" is not a real
 * file. Bundling `boot/stage0.ts` in isolation is the honest proxy for what an
 * engine has to parse and execute before the user presses a key.
 *
 * Minified, deliberately. esbuild preserves JSDoc in an unminified bundle, so
 * measuring the readable output made the budget a tax on comments — a rule that
 * fires when someone explains a subtlety is a rule that gets the comment
 * deleted instead.
 */
const measureStage0 = async (): Promise<number> => {
  const text = await bundle({
    entry: `${ROOT}/src/boot/stage0.ts`,
    dev: false,
    minify: true,
  });
  return new TextEncoder().encode(text).length;
};

interface ModuleSize {
  readonly module: string;
  readonly bytes: number;
}

const sizeReport = async (): Promise<readonly ModuleSize[]> => {
  const result = await esbuild.build({
    plugins: loaderPlugins(),
    entryPoints: [`${ROOT}/src/main.ts`],
    bundle: true,
    write: false,
    format: "iife",
    target: ["safari16"],
    platform: "browser",
    minify: false,
    metafile: true,
  });

  const inputs = result.metafile?.outputs;
  if (!inputs) return [];

  const entries: ModuleSize[] = [];
  for (const output of Object.values(inputs)) {
    for (const [module, meta] of Object.entries(output.inputs)) {
      entries.push({
        module: module.replace(`${ROOT}/`, ""),
        bytes: meta.bytesInOutput,
      });
    }
  }
  return entries.sort((a, b) => b.bytes - a.bytes);
};

const main = async (): Promise<void> => {
  const dev = Deno.args.includes("--dev");
  const watch = Deno.args.includes("--watch");
  const version = await readVersion();

  await ensureDir(DIST);

  const metadata = buildMetadata({
    version,
    repository: REPOSITORY,
    downloadUrl: `${REPOSITORY}/releases/latest/download/vimium-webkit.user.js`,
    updateUrl: `${REPOSITORY}/releases/latest/download/vimium-webkit.meta.js`,
    dev,
  });

  const build = async (): Promise<boolean> => {
    const code = await bundle({ entry: `${ROOT}/src/main.ts`, dev });
    const output = `${metadata}${BANNER_NOTICE}\n${code}`;

    await Deno.writeTextFile(
      `${DIST}/vimium-webkit${dev ? ".dev" : ""}.user.js`,
      output,
    );
    await Deno.writeTextFile(`${DIST}/vimium-webkit.meta.js`, metadata);

    // The shipped defaults, as data.
    //
    // The e2e harness needs them, and it runs under Playwright's own module
    // loader, which resolves neither the `~/` alias nor `npm:zod/mini`. A
    // hand-copied literal was the alternative, and the one that used to live
    // there had already drifted to a single search engine against the five
    // here — so the harness seeded settings that no user has.
    await Deno.writeTextFile(
      `${DIST}/default-settings.json`,
      `${JSON.stringify(defaultSettings(), null, 2)}\n`,
    );

    const report = await sizeReport();
    await Deno.writeTextFile(
      `${DIST}/report.json`,
      `${
        JSON.stringify(
          {
            version,
            totalBytes: new TextEncoder().encode(output).length,
            modules: report,
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

    const totalKb = (new TextEncoder().encode(output).length / 1024).toFixed(1);
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
    console.log("all invariants hold");
    return true;
  };

  if (!watch) {
    const ok = await build();
    await esbuild.stop();
    if (!ok) Deno.exit(1);
    return;
  }

  await build();
  console.log("watching src/ …");
  const watcher = Deno.watchFs(`${ROOT}/src`);
  let pending: number | undefined;
  for await (const _event of watcher) {
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      void build();
    }, 120);
  }
};

if (import.meta.main) await main();
