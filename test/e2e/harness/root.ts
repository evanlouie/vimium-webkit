/**
 * Repo-root discovery.
 *
 * Deliberately not `import.meta.url`: this module is loaded by Playwright's own
 * transform (which rewrites ESM to CJS and therefore rewrites `import.meta`)
 * as well as by Deno directly. Walking up from the working directory looking
 * for `deno.json` behaves identically under both and fails loudly rather than
 * silently resolving to the wrong tree.
 */

import { isFile, joinPath, parentPath } from "./paths.ts";

const CONFIG_FILE = "deno.json";

let cached: string | null = null;

export const repoRoot = (): string => {
  if (cached !== null) return cached;
  if (typeof Deno === "undefined") {
    throw new Error(
      "The Vimium-WebKit e2e harness must run under Deno. Use `deno task test:e2e`.",
    );
  }

  let current = Deno.cwd();
  for (let depth = 0; depth < 12; depth++) {
    if (isFile(joinPath(current, CONFIG_FILE))) {
      cached = current;
      return current;
    }
    const parent = parentPath(current);
    if (parent === "" || parent === current) break;
    current = parent;
  }

  throw new Error(
    `Could not find ${CONFIG_FILE} above ${Deno.cwd()}; run the e2e suite from the repository.`,
  );
};
