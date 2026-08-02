/**
 * Repo-root discovery.
 *
 * Deliberately not `import.meta.url`: this module is loaded by Playwright's own
 * transform, which may rewrite ESM to CJS and therefore rewrite `import.meta`.
 * Walking up from the working directory looking for `package.json` behaves
 * identically however the module is loaded, and fails loudly rather than
 * silently resolving to the wrong tree.
 */

import { isFile, joinPath, parentPath } from "./paths.ts";

const CONFIG_FILE = "package.json";

let cached: string | null = null;

export const repoRoot = (): string => {
  if (cached !== null) return cached;

  let current = process.cwd();
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
    `Could not find ${CONFIG_FILE} above ${process.cwd()}; run the e2e suite from the repository.`,
  );
};
