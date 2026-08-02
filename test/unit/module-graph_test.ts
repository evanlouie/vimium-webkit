/**
 * Every module loads, and loading it does nothing.
 *
 * This is a smoke test with teeth. The artefact is one file that is evaluated
 * at `document-start` in every frame of every page, so any work that a module
 * does when it is imported is work that every page load pays. A module that
 * touches the DOM, reads a global, or builds a data structure at the top level
 * throws here, where there is no DOM at all.
 *
 * It also fixes the coverage report. Coverage counts only the modules that a
 * run imported, so a file that no test reaches was indistinguishable from a
 * file that does not exist.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SRC = `${ROOT}/src`;

/**
 * `main.ts` starts the application when it is imported.
 *
 * That is deliberate. It is the entry point, so the injection guard and the
 * runtime must run there. Every other module must stay inert.
 */
const ENTRY_POINT = "src/main.ts";

const sourceFiles = Effect.promise(async (): Promise<readonly string[]> => {
  const entries = await readdir(SRC, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `${entry.parentPath}/${entry.name}`)
    .toSorted();
});

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

describe("module graph", () => {
  it.effect(
    "imports every module in src/ with no DOM",
    () =>
      Effect.gen(function*() {
        const files = (yield* sourceFiles).filter(
          (path) => relative(ROOT, path).replaceAll("\\", "/") !== ENTRY_POINT,
        );
        assert.isAbove(files.length, 30, `only ${files.length} modules found`);

        const outcomes = yield* Effect.forEach(
          files,
          (path) =>
            Effect.map(
              Effect.exit(
                Effect.tryPromise({
                  try: () => import(pathToFileURL(path).href),
                  catch: describeCause,
                }),
              ),
              (exit) => ({ path, exit }),
            ),
          { concurrency: "unbounded" },
        );

        const failures = outcomes
          .filter((outcome) => Exit.isFailure(outcome.exit))
          .map((outcome) => relative(ROOT, outcome.path));

        assert.deepEqual(
          failures,
          [],
          `these modules do work when they are imported:\n  ${
            failures.join("\n  ")
          }`,
        );
      }),
    30_000,
  );

  it.effect("keeps the entry point out of that list on purpose", () =>
    Effect.gen(function*() {
      const files = (yield* sourceFiles).map(
        (path) => relative(ROOT, path).replaceAll("\\", "/"),
      );
      assert.include(
        files,
        ENTRY_POINT,
        "main.ts must exist, so the exclusion above still means something",
      );
    }));
});
