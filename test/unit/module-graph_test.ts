/**
 * Every module loads, and loading it does nothing.
 *
 * Two properties in one test, and both were unverified.
 *
 * The first is a smoke test with teeth: a userscript is one IIFE evaluated at
 * `document-start` in every frame of every page, so *any* work a module does at
 * import time is work every page load pays. A module that touches the DOM,
 * reads a global, or builds a data structure at the top level will throw here,
 * under Deno, where there is no DOM at all.
 *
 * The second is about the coverage report. Deno reports coverage only for
 * modules the run actually imported, so the headline figure was computed over
 * the third of `src/` that the unit tests happen to reach — which made an
 * untested file indistinguishable from one that does not exist. Importing every
 * module puts all of them in the denominator.
 */

import { assert } from "@std/assert";
import { walk } from "@std/fs";
import { fromFileUrl, relative, resolve } from "@std/path";

const ROOT = resolve(fromFileUrl(import.meta.url), "../../..");
const SRC = `${ROOT}/src`;

const sourceFiles = async (): Promise<readonly string[]> => {
  const out: string[] = [];
  for await (
    const entry of walk(SRC, { exts: [".ts"], includeDirs: false })
  ) {
    out.push(entry.path);
  }
  return out.toSorted();
};

Deno.test("every module in src/ imports cleanly with no DOM", async () => {
  const files = await sourceFiles();
  assert(files.length > 30, `only found ${files.length} modules`);

  const failures: string[] = [];
  await Promise.all(files.map(async (path) => {
    try {
      await import(`file://${path}`);
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
