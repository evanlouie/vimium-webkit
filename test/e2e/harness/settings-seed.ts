/**
 * Pre-seeding the value store.
 *
 * Some specs need non-default settings *before the first key is pressed*, and
 * there is no runtime API for a test to reach in and set them — deliberately,
 * since the only supported path is the settings overlay. So the settings are
 * written straight into the stubbed GM store, exactly as a manager would hold
 * them.
 *
 * The baseline is the shipped `defaultSettings()`, read from the build output
 * rather than copied. It cannot be *imported*: this module runs under
 * Playwright's own loader, which resolves neither the `~/` alias nor the
 * bundler's. The copy that used to live here had drifted (one search
 * engine against five) and, worse, forced `filterLinkHints: true` and
 * `smoothScroll: false` on every spec — so the *default* hint pipeline and the
 * *default* scroll path had no integration coverage at all, which is how
 * several defects survived a green suite.
 */

import { readFileSync } from "node:fs";
import type { Settings } from "~/domain/Persisted.ts";
import { joinPath } from "./paths.ts";
import { repoRoot } from "./root.ts";

/** Mirrors `STORAGE_PREFIX` in `src/platform/storage.ts`. */
const STORAGE_PREFIX = "vimium-webkit:";

/** Mirrors `SETTINGS_SCHEMA_VERSION` in `src/domain/Persisted.ts`. */
const SETTINGS_SCHEMA_VERSION = 1;

export const SETTINGS_KEY = `${STORAGE_PREFIX}settings`;
const SESSION_KEY = `${STORAGE_PREFIX}session`;
const FRAME_SECRET = "e2e-manager-private-frame-credential";

/**
 * Overrides for specs that trade realism for determinism.
 *
 * - `smoothScroll: false` — the scroller animates over several rAF ticks and
 *   calibrates itself against measured frame throughput, so an assertion on an
 *   exact scroll offset would be a flake generator.
 * - `filterLinkHints: true` — matching a hint by its link text is independent
 *   of the hint-string algorithm, which has its own unit tests.
 *
 * Opt-in per spec, never the baseline: whatever a spec proves under these, it
 * proves about a configuration no user has.
 */
export const DETERMINISTIC: Partial<Settings> = {
  smoothScroll: false,
  filterLinkHints: true,
};

/**
 * The shipped defaults, written by `npm run build`.
 *
 * `globalSetup` guarantees the bundle is current before any worker starts, and
 * this file is emitted by the same build, so it cannot be stale relative to the
 * code under test.
 */
let cached: Settings | null = null;

const shippedDefaults = (): Settings => {
  if (cached !== null) return cached;
  const path = joinPath(repoRoot(), "dist/default-settings.json");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path} is not an object; run \`npm run build\``);
  }
  // Our own build output, validated by `settingsSchema` on the way in — the
  // cast asserts a shape the producer already guarantees.
  cached = parsed as Settings;
  return cached;
};

const envelope = (settings: Settings): string =>
  JSON.stringify({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    data: settings,
  });

/** Storage seed for `installPageHarness`, with `patch` applied over the defaults. */
export const seedWithSettings = (
  patch: Partial<Settings> = {},
): Readonly<Record<string, string>> => ({
  [SETTINGS_KEY]: envelope({ ...shippedDefaults(), ...patch }),
  // A real manager shares private storage across frames. Each harness frame
  // has its own in-page Map, so seed the same credential into every one.
  [SESSION_KEY]: JSON.stringify({
    schemaVersion: 1,
    data: {
      frameSecret: FRAME_SECRET,
      knownTabs: [],
      acknowledged: [],
      zoomByOrigin: {},
    },
  }),
});

/** The effective settings a spec will run under. */
export const effectiveSettings = (patch: Partial<Settings> = {}): Settings => ({
  ...shippedDefaults(),
  ...patch,
});
