/**
 * Path and filesystem helpers.
 *
 * Deliberately hand-rolled rather than leaning on a path library: this module
 * is reachable from spec files, which Playwright loads through its own
 * transform, and keeping the surface small keeps it portable.
 */

import { type Dirent, readdirSync, statSync } from "node:fs";

/** Join an absolute base with a relative path. POSIX only; so is the CI. */
export const joinPath = (base: string, relative: string): string => {
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const trimmedRelative = relative.startsWith("/")
    ? relative.slice(1)
    : relative;
  return trimmedRelative.length === 0
    ? trimmedBase
    : `${trimmedBase}/${trimmedRelative}`;
};

export const parentPath = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
};

/** `"/a/b.html"` → `".html"`; `""` when the last segment has no dot. */
export const extensionOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? path.slice(dot) : "";
};

/**
 * Collapse `.` and `..` segments, discarding any that would escape the root.
 *
 * Used to keep the fixture server inside its document root. A traversal here
 * would only expose this repository to this repository's own tests, but a
 * fixture server that serves `../../` is a footgun waiting for the day someone
 * points it at a real directory.
 */
export const normaliseSegments = (path: string): readonly string[] => {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
};

export const mtimeOf = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

export const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Newest mtime among files under `dir` whose name ends with any of `suffixes`. */
export const newestMtime = (
  dir: string,
  suffixes: readonly string[],
): number => {
  let newest = 0;
  let entries: readonly Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const path = joinPath(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(path, suffixes));
      continue;
    }
    if (!suffixes.some((suffix) => entry.name.endsWith(suffix))) continue;
    newest = Math.max(newest, mtimeOf(path));
  }
  return newest;
};
