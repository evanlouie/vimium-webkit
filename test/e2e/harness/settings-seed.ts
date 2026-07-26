/**
 * Pre-seeding the value store.
 *
 * Several specs need non-default settings (filter-mode hints, instant
 * scrolling) *before the first key is pressed*, and there is no runtime API for
 * a test to reach in and set them — deliberately, since the only supported path
 * is the settings overlay. So the settings are written straight into the stubbed
 * GM store, exactly as a manager would hold them.
 *
 * `BASE` is typed as `Settings` on purpose. The import is type-only (erased by
 * both Deno and Playwright's transform, so no Zod ever reaches the browser),
 * and it means that adding a field to `settings/schema.ts` breaks
 * `deno check` here rather than silently producing a seed that fails validation
 * at runtime and falls back to defaults — a failure mode that would make every
 * dependent spec fail for the wrong reason.
 */

import type { Settings } from "~/settings/schema.ts";

/** Mirrors `STORAGE_PREFIX` in `src/platform/storage.ts`. */
const STORAGE_PREFIX = "vimium-webkit:";

/** Mirrors `SETTINGS_SCHEMA_VERSION` in `src/settings/schema.ts`. */
const SETTINGS_SCHEMA_VERSION = 1;

export const SETTINGS_KEY = `${STORAGE_PREFIX}settings`;

/** A verbatim copy of `defaultSettings()`; the type annotation keeps it honest. */
const BASE: Settings = {
  scrollStepSize: 60,
  smoothScroll: true,

  linkHintCharacters: "sadfjklewcmpgh",
  linkHintNumbers: "0123456789",
  filterLinkHints: false,
  waitForEnterForFilteredHints: true,
  userDefinedLinkHintCss: "",

  regexFindMode: false,
  ignoreKeyboardLayout: false,
  shadowNativeFind: false,

  previousPatterns: "prev,previous,back,older,<,‹,←,«,≪,<<",
  nextPatterns: "next,more,newer,>,›,→,»,≫,>>",

  searchUrl: "https://www.google.com/search?q=%s",
  searchEngines: "g: https://www.google.com/search?q=%s Google",
  newTabUrl: "about:blank",

  hideHud: false,
  followPageColorScheme: true,

  grabBackFocus: false,
  enableCssZoom: false,
  enableHistoryIndex: false,
  historyIndexDenylist: [],
  historyIndexLimit: 5000,

  exclusionRules: [],
  keyMappings: "",
};

/**
 * The settings every spec starts from.
 *
 * Two deviations from the shipped defaults, both to remove non-determinism
 * rather than to test something different:
 *
 * - `smoothScroll: false` — the scroller animates over several rAF ticks and
 *   calibrates itself against measured frame throughput, so an assertion on an
 *   exact scroll offset would be a flake generator. The animation itself is
 *   covered by unit tests over `durationFor`.
 * - `filterLinkHints: true` — hint *strings* are an implementation detail, but
 *   a hint's *link text* is the user-facing contract. Typing the link text and
 *   asserting the resulting navigation is both closer to what a user does and
 *   independent of the hint-string algorithm (which has its own unit tests).
 *   `waitForEnterForFilteredHints` is left at its shipped default, so every
 *   activation in the specs is an explicit `Enter`.
 */
export const E2E_SETTINGS: Settings = {
  ...BASE,
  smoothScroll: false,
  filterLinkHints: true,
};

const envelope = (settings: Settings): string =>
  JSON.stringify({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    data: settings,
  });

/** Storage seed for `installPageHarness`, with `patch` applied over the base. */
export const seedWithSettings = (
  patch: Partial<Settings> = {},
): Readonly<Record<string, string>> => ({
  [SETTINGS_KEY]: envelope({ ...E2E_SETTINGS, ...patch }),
});
