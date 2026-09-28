/**
 * The build.
 *
 * A single unminified IIFE, per §9. Unminified is not laziness: Greasy Fork's
 * size ceiling is measured *unminified*, its reviewers read the source, and a
 * userscript that a user cannot audit is one they should not install.
 *
 *   npm run build          production bundle
 *   npm run build:dev      dev bundle, sourcemap inline
 *   npm run watch          rebuild on change
 */

import { watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build as viteBuild, type Rolldown } from "vite";
import { defaultSettings } from "~/domain/Persisted.ts";
import { BANNER_NOTICE, buildMetadata } from "./metadata.ts";
import { bundleConfig, type BundleOptions, ROOT } from "./vite-config.ts";

const DIST = `${ROOT}/dist`;
const REPOSITORY = "https://github.com/evanlouie/vimium-webkit";

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const readVersion = async (): Promise<string> => {
  const raw: unknown = JSON.parse(await readFile(`${ROOT}/package.json`, "utf8"));
  const version = (raw as { readonly version?: unknown }).version;
  if (typeof version !== "string") {
    throw new Error("package.json has no string `version`");
  }
  return version;
};

/** The single entry chunk Vite produced for a library build. */
const entryChunk = (result: Awaited<ReturnType<typeof viteBuild>>): Rolldown.OutputChunk => {
  const outputs = Array.isArray(result)
    ? result.flatMap((output) => output.output)
    : "output" in result
      ? result.output
      : [];
  const chunk = outputs.find(
    (item): item is Rolldown.OutputChunk => item.type === "chunk" && item.isEntry,
  );
  if (!chunk) throw new Error("Vite produced no entry chunk");
  return chunk;
};

const bundle = async (options: BundleOptions): Promise<Rolldown.OutputChunk> =>
  entryChunk(await viteBuild(bundleConfig(options)));

interface ModuleSize {
  readonly module: string;
  readonly bytes: number;
}

/**
 * Per-module contribution, largest first — *indicative, not a decomposition*.
 *
 * Rollup measures each module before Vite re-prints the chunk for `safari16`,
 * and that re-print drops about a third of the bytes. The figures therefore
 * sum to roughly 40% more than the artefact. They are useful for ranking what
 * is large.
 */
const sizeReport = (chunk: Rolldown.OutputChunk): readonly ModuleSize[] =>
  Object.entries(chunk.modules)
    .map(([module, meta]) => ({
      module: module.startsWith(ROOT)
        ? module.slice(ROOT.length + 1)
        : // Rollup prefixes virtual module identifiers with NUL.
          // oxlint-disable-next-line no-control-regex
          module.replace(/^\u0000/, ""),
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

  const build = async (): Promise<void> => {
    const chunk = await bundle({ entry: `${ROOT}/src/main.ts`, dev });
    const output = `${metadata}${BANNER_NOTICE}\n${chunk.code}`;
    const artefact = `${DIST}/vimium-webkit${dev ? ".dev" : ""}.user.js`;

    await writeFile(artefact, output);
    // Production only. `meta.js` is what `@updateURL` points at, so writing a
    // dev block there would tell every installed copy that the current release
    // is called "Vimium-WebKit (dev)".
    if (!dev) await writeFile(`${DIST}/vimium-webkit.meta.js`, metadata);

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
      `${JSON.stringify(
        {
          version,
          totalBytes: byteLength(output),
          modules: sizeReport(chunk),
        },
        null,
        2,
      )}\n`,
    );

    const totalKb = (byteLength(output) / 1024).toFixed(1);
    console.log(`vimium-webkit ${version} — ${totalKb} KB`);
  };

  if (!watching) {
    await build();
    return;
  }

  await build();
  console.log("watching src/ …");
  let pending: NodeJS.Timeout | undefined;
  watch(`${ROOT}/src`, { recursive: true }, () => {
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      build().catch((cause: unknown) => {
        console.error(cause);
      });
    }, 120);
  });
};

await main();
