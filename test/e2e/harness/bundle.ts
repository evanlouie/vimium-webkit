/**
 * Getting `dist/vimium-webkit.user.js` in front of the tests.
 *
 * The e2e suite tests the *shipped artefact*, not the module graph: a bundling
 * mistake (an esbuild target that down-levels something Safari needs, a missing
 * `define`, a tree-shaken side effect) is exactly the class of bug this layer
 * exists to catch, and it is invisible if the specs import from `src/`.
 */

import { joinPath, mtimeOf, newestMtime } from "./paths.ts";
import { repoRoot } from "./root.ts";

const BUNDLE_RELATIVE = "dist/vimium-webkit.user.js";

/** Sources whose mtime decides whether the bundle on disk is stale. */
const SOURCE_DIRS: readonly string[] = ["src", "build"];
const SOURCE_FILES: readonly string[] = ["deno.json"];

const newestSourceMtime = (root: string): number => {
  let newest = 0;
  for (const file of SOURCE_FILES) {
    newest = Math.max(newest, mtimeOf(joinPath(root, file)));
  }
  for (const dir of SOURCE_DIRS) {
    newest = Math.max(newest, newestMtime(joinPath(root, dir), [".ts"]));
  }
  return newest;
};

export const bundlePath = (): string => joinPath(repoRoot(), BUNDLE_RELATIVE);

const runBuild = async (root: string): Promise<void> => {
  console.log(
    "[e2e] dist/vimium-webkit.user.js is missing or stale; building…",
  );
  const command = new Deno.Command(Deno.execPath(), {
    args: ["task", "build"],
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await command.output();
  if (code !== 0) {
    throw new Error(`\`deno task build\` failed with exit code ${code}`);
  }
};

/** Build the bundle if it is missing or older than any source file. */
export const ensureBundle = async (): Promise<void> => {
  const root = repoRoot();
  const path = bundlePath();
  if (mtimeOf(path) >= newestSourceMtime(root)) return;
  await runBuild(root);
};

let cached: string | null = null;

/**
 * The bundle text, cached per process.
 *
 * Each Playwright worker is its own process, so this is read once per worker
 * rather than once per test. Building is *not* attempted here: that is
 * `globalSetup`'s job, and racing several workers on one esbuild output would
 * be a way to observe a half-written file.
 */
export const readBundle = (): string => {
  if (cached !== null) return cached;
  const path = bundlePath();
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (cause) {
    throw new Error(
      `Missing ${path}. Run \`deno task build\` (globalSetup normally does this).`,
      { cause },
    );
  }
  if (!text.startsWith("// ==UserScript==")) {
    throw new Error(
      `${path} does not start with a userscript metadata block; the build is wrong.`,
    );
  }
  cached = text;
  return text;
};
