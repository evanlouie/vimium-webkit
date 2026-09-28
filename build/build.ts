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

import {
  Array,
  Boolean,
  Cause,
  Console,
  Effect,
  Match,
  Option,
  Order,
  Queue,
  Record,
  Result,
  Schema,
  Stream,
  String as Str,
  flow,
  pipe,
} from "effect";
import { watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build as viteBuild, type Rolldown } from "vite";
import { BANNER_NOTICE, buildMetadata } from "./metadata.ts";
import { BuildMode, bundleConfig, type BundleOptions, ROOT } from "./vite-config.ts";

const DIST = `${ROOT}/dist`;
const REPOSITORY = "https://github.com/evanlouie/vimium-webkit";

/** A step of the build that failed. */
class BuildError extends Schema.TaggedError<BuildError>()("BuildError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Run one call of Node or Vite, and name the step when it fails. */
const attempt = <A>(step: string, run: () => Promise<A>): Effect.Effect<A, BuildError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BuildError({ message: `${step} failed`, cause }),
  });

const writeText = (path: string, text: string): Effect.Effect<void, BuildError> =>
  attempt(`writing ${path}`, () => writeFile(path, text));

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** The one field of `package.json` that the build reads. */
const PackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

const readVersion = Effect.gen(function* () {
  const text = yield* attempt("reading package.json", () =>
    readFile(`${ROOT}/package.json`, "utf8"),
  );
  const { version } = yield* pipe(
    text,
    Schema.decodeUnknownEffect(PackageJson),
    Effect.mapError(
      (cause) => new BuildError({ message: "package.json has no string `version`", cause }),
    ),
  );
  return version;
});

type ViteResult = Awaited<ReturnType<typeof viteBuild>>;

/** The results of one Vite build. A library build gives one, or one for each format. */
const resultsOf = (
  result: ViteResult,
): ReadonlyArray<Rolldown.RolldownOutput | Rolldown.RolldownWatcher> => Array.ensure(result);

/** A watcher is a result that holds no output. */
const hasOutput = (
  result: Rolldown.RolldownOutput | Rolldown.RolldownWatcher,
): result is Rolldown.RolldownOutput => "output" in result;

const isEntryChunk = (
  item: Rolldown.OutputChunk | Rolldown.OutputAsset,
): item is Rolldown.OutputChunk => item.type === "chunk" && item.isEntry;

/** The single entry chunk Vite produced for a library build. */
const entryChunk: (result: ViteResult) => Option.Option<Rolldown.OutputChunk> = flow(
  resultsOf,
  Array.filter(hasOutput),
  Array.flatMap(({ output }) => output),
  Array.findFirst(isEntryChunk),
);

const bundle = (options: BundleOptions): Effect.Effect<Rolldown.OutputChunk, BuildError> =>
  pipe(
    attempt("the Vite build", () => viteBuild(bundleConfig(options))),
    Effect.flatMap(
      flow(
        entryChunk,
        Result.fromOption(() => new BuildError({ message: "Vite produced no entry chunk" })),
        Effect.fromResult,
      ),
    ),
  );

interface ModuleSize {
  readonly module: string;
  readonly bytes: number;
}

/** Rollup prefixes virtual module identifiers with NUL. */
const VIRTUAL_PREFIX = "\u0000";

/** The name of a module in the report: relative to the root, and never with the NUL. */
const moduleName = (module: string): string =>
  pipe(
    Match.value(module),
    Match.when(Str.startsWith(ROOT), (path) => path.slice(ROOT.length + 1)),
    Match.when(Str.startsWith(VIRTUAL_PREFIX), (id) => id.slice(VIRTUAL_PREFIX.length)),
    Match.orElse((id) => id),
  );

const largestFirst: Order.Order<ModuleSize> = pipe(
  Order.Number,
  Order.mapInput((entry: ModuleSize) => entry.bytes),
  Order.flip,
);

/**
 * Per-module contribution, largest first — *indicative, not a decomposition*.
 *
 * Rollup measures each module before Vite re-prints the chunk for `safari16`,
 * and that re-print drops about a third of the bytes. The figures therefore
 * sum to roughly 40% more than the artefact. They are useful for ranking what
 * is large.
 */
const sizeReport = (chunk: Rolldown.OutputChunk): ReadonlyArray<ModuleSize> =>
  pipe(
    chunk.modules,
    Record.toEntries,
    Array.map(([module, meta]) => ({ module: moduleName(module), bytes: meta.renderedLength })),
    Array.filter((entry) => entry.bytes > 0),
    Array.sort(largestFirst),
  );

/** The mode that `--dev` on the command line asks for. */
const modeOf: (dev: boolean) => BuildMode = Boolean.match({
  onTrue: () => BuildMode.Development(),
  onFalse: () => BuildMode.Production(),
});

const artefactPath: (mode: BuildMode) => string = BuildMode.$match({
  Development: () => `${DIST}/vimium-webkit.dev.user.js`,
  Production: () => `${DIST}/vimium-webkit.user.js`,
});

/**
 * Write the update manifest, in production only.
 *
 * `meta.js` is what `@updateURL` points at, so writing a dev block there would
 * tell every installed copy that the current release is called "Vimium-WebKit
 * (dev)".
 */
const writeUpdateManifest = (mode: BuildMode, metadata: string): Effect.Effect<void, BuildError> =>
  pipe(
    mode,
    BuildMode.$match({
      Development: () => Effect.void,
      Production: () => writeText(`${DIST}/vimium-webkit.meta.js`, metadata),
    }),
  );

/** What every build of one run shares. */
interface Release {
  readonly mode: BuildMode;
  readonly version: string;
  readonly metadata: string;
}

const buildOnce = Effect.fnUntraced(function* ({ mode, version, metadata }: Release) {
  const chunk = yield* bundle({ entry: `${ROOT}/src/main.ts`, mode });
  const output = `${metadata}${BANNER_NOTICE}\n${chunk.code}`;
  const totalBytes = byteLength(output);

  yield* writeText(artefactPath(mode), output);
  yield* writeUpdateManifest(mode, metadata);
  yield* writeText(
    `${DIST}/report.json`,
    `${JSON.stringify({ version, totalBytes, modules: sizeReport(chunk) }, null, 2)}\n`,
  );

  const totalKb = (totalBytes / 1024).toFixed(1);
  yield* Console.log(`vimium-webkit ${version} — ${totalKb} KB`);
});

/** One element for each change that `fs.watch` sees under `src/`. */
const sourceChanges: Stream.Stream<void> = Stream.callback<void>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      watch(`${ROOT}/src`, { recursive: true }, () => {
        Queue.offerUnsafe(queue, undefined);
      }),
    ),
    (watcher) =>
      Effect.sync(() => {
        watcher.close();
      }),
  ),
);

/**
 * Build again after each burst of changes.
 *
 * A failed build is reported, and the watch goes on. A change during a build
 * starts the next build once this one is done.
 */
const rebuildOnChange = (build: Effect.Effect<void, BuildError>): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Console.log("watching src/ …");
    yield* pipe(
      sourceChanges,
      Stream.debounce("120 millis"),
      Stream.runForEach(() =>
        pipe(
          build,
          Effect.catchCause((cause) => Console.error(Cause.squash(cause))),
        ),
      ),
    );
  });

const main = Effect.gen(function* () {
  const mode = pipe(process.argv, Array.contains("--dev"), modeOf);
  const watching = pipe(process.argv, Array.contains("--watch"));
  const version = yield* readVersion;

  yield* attempt("creating dist/", () => mkdir(DIST, { recursive: true }));

  const metadata = buildMetadata({
    version,
    repository: REPOSITORY,
    downloadUrl: `${REPOSITORY}/releases/latest/download/vimium-webkit.user.js`,
    updateUrl: `${REPOSITORY}/releases/latest/download/vimium-webkit.meta.js`,
    mode,
  });

  const build = buildOnce({ mode, version, metadata });
  yield* build;
  yield* pipe(
    watching,
    Boolean.match({
      onTrue: () => rebuildOnChange(build),
      onFalse: () => Effect.void,
    }),
  );
});

await Effect.runPromise(main);
