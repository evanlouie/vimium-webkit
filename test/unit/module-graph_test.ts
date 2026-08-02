/**
 * Every module loads, and loading it does nothing.
 *
 * Two properties in one test, and both were unverified.
 *
 * The first is a smoke test with teeth: a userscript is one IIFE evaluated at
 * `document-start` in every frame of every page, so *any* work a module does at
 * import time is work every page load pays. A module that touches the DOM,
 * reads a global, or builds a data structure at the top level will throw here,
 * under Vitest's `node` environment, where there is no DOM at all.
 *
 * The second is about the coverage report. Coverage is reported only for
 * modules the run actually imported, so the headline figure was computed over
 * the third of `src/` that the unit tests happen to reach — which made an
 * untested file indistinguishable from one that does not exist. Importing every
 * module puts all of them in the denominator.
 */

import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import { assert } from "./support/assert.ts";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SRC = `${ROOT}/src`;

const sourceFiles = async (): Promise<readonly string[]> => {
  const entries = await readdir(SRC, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `${entry.parentPath}/${entry.name}`)
    .toSorted();
};

test("every module in src/ imports cleanly with no DOM", async () => {
  const files = await sourceFiles();
  assert(files.length > 30, `only found ${files.length} modules`);

  const failures: string[] = [];
  await Promise.all(files.map(async (path) => {
    try {
      await import(pathToFileURL(path).href);
    } catch (cause) {
      failures.push(
        `${relative(ROOT, path)}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }));

  assert(
    failures.length === 0,
    `these modules do work at import time:\n  ${failures.join("\n  ")}`,
  );
});
