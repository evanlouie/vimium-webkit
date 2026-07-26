/**
 * Persisted configuration: schema, defaults, and migrations.
 *
 * Everything here is validated on every read *and* on every write
 * (`platform/storage.ts`), so a bad value is caught where it was produced
 * rather than on the next load, where it would take the whole group down with
 * it.
 *
 * Two rules make that survivable across versions:
 *
 * 1. **Every settings field carries its own fallback.** `z.catch(schema, x)`
 *    turns a bad or missing field into `x` instead of failing the object. This
 *    is what makes adding a field genuinely safe: a payload written by an older
 *    build is missing the new key, and the new key alone is defaulted.
 * 2. **The defaults *are* the schema.** `defaultSettings()` is what an empty
 *    object decodes to, so there is no second list of default values that can
 *    drift away from the first.
 *
 * Changing or removing a field still requires a migration and a bump of the
 * corresponding `*_SCHEMA_VERSION`. The migration list is built in from v0.1
 * deliberately — upstream Vimium's `migratePre2_0`/`migratePre2_4` history is
 * the cautionary tale.
 */

import * as z from "zod/mini";
import type { GroupSpec } from "~/platform/storage.ts";

// ---------------------------------------------------------------------------
// Exclusion rules
// ---------------------------------------------------------------------------

export const exclusionRuleSchema = z.object({
  /** A URL glob, e.g. `https://mail.google.com/*`. */
  pattern: z.string(),
  /**
   * Keys to pass through to the page. Empty string disables Vimium-WebKit
   * entirely on matching URLs; a non-empty string is a partial exclusion.
   */
  passKeys: z.string(),
});

export type ExclusionRule = z.infer<typeof exclusionRuleSchema>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * A field that degrades to `fallback` instead of taking the group with it.
 *
 * Named rather than inlined so the intent reads at every use: one bad field
 * costs the user that field. `#decode` returns the defaults for the *whole*
 * group on a validation failure, which without this would mean a single
 * hand-edited character in the manager's storage viewer erasing every setting.
 */
const field = <T>(schema: z.ZodMiniType<T>, fallback: T): z.ZodMiniType<T> =>
  z.catch(schema, fallback);

/** Characters usable for hint labels must be distinct, or two hints collide. */
const distinctCharacters = (value: string): boolean =>
  new Set(value).size === value.length;

/** A search template without `%s` silently discards whatever the user typed. */
const hasQueryPlaceholder = (value: string): boolean => value.includes("%s");

export const settingsSchema = z.object({
  // --- Scrolling ---
  scrollStepSize: field(
    z.number().check(z.minimum(1), z.maximum(10_000)),
    60,
  ),
  smoothScroll: field(z.boolean(), true),

  // --- Link hints ---
  linkHintCharacters: field(
    z.string().check(
      z.minLength(2),
      z.refine(distinctCharacters, {
        message: "hint characters must all be different",
      }),
    ),
    "sadfjklewcmpgh",
  ),
  linkHintNumbers: field(
    z.string().check(
      z.minLength(2),
      z.refine(distinctCharacters, {
        message: "hint number characters must all be different",
      }),
    ),
    "0123456789",
  ),
  filterLinkHints: field(z.boolean(), false),
  waitForEnterForFilteredHints: field(z.boolean(), true),
  /** Extra CSS applied inside our shadow root; never injected into the page. */
  userDefinedLinkHintCss: field(z.string(), ""),

  // --- Find ---
  regexFindMode: field(z.boolean(), false),
  ignoreKeyboardLayout: field(z.boolean(), false),
  /**
   * Shadow the browser's own ⌘F/Ctrl+F. Off by default: preventable on macOS
   * Safari, but possibly not on iOS (WebKit bug 191768), and stealing the
   * native binding when we cannot reliably deliver a replacement is worse than
   * not offering it.
   */
  shadowNativeFind: field(z.boolean(), false),

  // --- Navigation heuristics ---
  previousPatterns: field(
    z.string(),
    "prev,previous,back,older,<,‹,←,«,≪,<<",
  ),
  nextPatterns: field(z.string(), "next,more,newer,>,›,→,»,≫,>>"),

  // --- Search ---
  searchUrl: field(
    z.string().check(
      z.refine(hasQueryPlaceholder, {
        message: "the search URL must contain %s",
      }),
    ),
    "https://www.google.com/search?q=%s",
  ),
  /** One `keyword: url %s Description` per line, Vimium-compatible. */
  searchEngines: field(
    z.string(),
    [
      "w: https://www.wikipedia.org/w/index.php?title=Special:Search&search=%s Wikipedia",
      "g: https://www.google.com/search?q=%s Google",
      "d: https://duckduckgo.com/?q=%s DuckDuckGo",
      "gh: https://github.com/search?q=%s GitHub",
      "mdn: https://developer.mozilla.org/en-US/search?q=%s MDN",
    ].join("\n"),
  ),
  newTabUrl: field(z.string(), "about:blank"),
  /**
   * Ask the configured search engine for completions as the user types.
   *
   * Opt-in for the same reason `enableHistoryIndex` is: every keystroke in the
   * omnibar leaves the device, with the user's cookies attached, to a third
   * party they did not choose in that moment. "Off unless a manager cannot do
   * it" is not a privacy control — it is the absence of one.
   */
  enableSearchSuggestions: field(z.boolean(), false),

  // --- UI ---
  hideHud: field(z.boolean(), false),
  /** Blend the overlay with the page's own colour scheme where detectable. */
  followPageColorScheme: field(z.boolean(), true),

  // --- Behaviour ---
  grabBackFocus: field(z.boolean(), false),
  /**
   * Leave the arrow keys and space to a focused video or audio player.
   *
   * On by default. Those five keys seek, change the volume and toggle playback
   * on every player there is — including the browser's own `<video controls>` —
   * and we bind all five, in the capture phase, so without this a watch page
   * loses them the moment Vimium-WebKit is installed. Turn it off to scroll
   * with them everywhere, player or no player.
   */
  passMediaKeys: field(z.boolean(), true),
  /** Per-origin CSS zoom. Not real browser zoom; see §4.2. Off by default. */
  enableCssZoom: field(z.boolean(), false),
  /**
   * Record visited pages locally to power Omnibar-lite. Opt-in, and it must
   * stay that way: a userscript building a browsing-history index is a real
   * privacy surface and GM storage is readable from the manager's own UI.
   */
  enableHistoryIndex: field(z.boolean(), false),
  historyIndexDenylist: field(z.array(z.string()), []),
  historyIndexLimit: field(
    z.number().check(z.minimum(0), z.maximum(50_000)),
    5000,
  ),

  // --- Rules ---
  exclusionRules: field(z.array(exclusionRuleSchema), []),
  /** Raw `map`/`unmap`/`unmapAll`/`mapkey` source, parsed by `core/mappings.ts`. */
  keyMappings: field(z.string(), ""),
});

export type Settings = z.infer<typeof settingsSchema>;

/**
 * The settings a fresh install starts from.
 *
 * Derived rather than declared: every field's fallback *is* its default, so
 * decoding an empty object yields exactly the shipped configuration. A second
 * hand-written literal would be a second source of truth, and the one in the
 * e2e harness had already drifted to a single search engine against the five
 * here.
 */
export const defaultSettings = (): Settings => settingsSchema.parse({});

export const SETTINGS_SCHEMA_VERSION = 1;

export const settingsGroup: GroupSpec<Settings> = {
  name: "settings",
  schema: settingsSchema,
  defaults: defaultSettings,
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  migrations: [],
  writeDebounceMs: 250,
};

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

export const localMarkSchema = z.object({
  scrollX: z.number(),
  scrollY: z.number(),
  savedAt: z.number(),
});

export const globalMarkSchema = z.object({
  url: z.string(),
  scrollX: z.number(),
  scrollY: z.number(),
  savedAt: z.number(),
});

export const marksSchema = z.object({
  /** `url -> mark letter -> position`. */
  local: z.record(z.string(), z.record(z.string(), localMarkSchema)),
  /** `mark letter -> {url, position}`. */
  global: z.record(z.string(), globalMarkSchema),
});

export type Marks = z.infer<typeof marksSchema>;
export type LocalMark = z.infer<typeof localMarkSchema>;
export type GlobalMark = z.infer<typeof globalMarkSchema>;

/**
 * How many distinct URLs may hold local marks.
 *
 * Local marks are keyed by URL and nothing ever removed one, so a user who
 * pressed `ma` on a thousand pages had a thousand entries — rewritten in full
 * on every subsequent mark. `savedAt` was written on every mark and read by
 * nothing; it is what `pruneMarks` sorts on.
 */
export const LOCAL_MARK_URL_LIMIT = 200;

/** Local marks older than this are dropped. Global marks are never expired. */
export const LOCAL_MARK_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Bound the local-mark table: expire, then keep the most recent URLs.
 *
 * Pure, so the eviction policy is inspectable rather than implied by whatever
 * the write path happens to do.
 */
export const pruneMarks = (marks: Marks, now: number): Marks => {
  const entries: Array<[string, Record<string, LocalMark>]> = [];

  for (const [url, letters] of Object.entries(marks.local)) {
    const live: Record<string, LocalMark> = {};
    let newest = 0;
    for (const [letter, mark] of Object.entries(letters)) {
      if (now - mark.savedAt > LOCAL_MARK_TTL_MS) continue;
      live[letter] = mark;
      newest = Math.max(newest, mark.savedAt);
    }
    if (newest > 0) entries.push([url, live]);
  }

  entries.sort((a, b) => newestSavedAt(b[1]) - newestSavedAt(a[1]));

  const local: Record<string, Record<string, LocalMark>> = {};
  for (const [url, letters] of entries.slice(0, LOCAL_MARK_URL_LIMIT)) {
    local[url] = letters;
  }
  return { local, global: marks.global };
};

const newestSavedAt = (letters: Record<string, LocalMark>): number => {
  let newest = 0;
  for (const mark of Object.values(letters)) {
    newest = Math.max(newest, mark.savedAt);
  }
  return newest;
};

export const MARKS_SCHEMA_VERSION = 1;

export const marksGroup: GroupSpec<Marks> = {
  name: "marks",
  schema: marksSchema,
  defaults: (): Marks => ({ local: {}, global: {} }),
  schemaVersion: MARKS_SCHEMA_VERSION,
  writeDebounceMs: 100,
};

// ---------------------------------------------------------------------------
// Find history
// ---------------------------------------------------------------------------

export const findHistorySchema = z.object({
  queries: z.array(z.string()),
});

export type FindHistory = z.infer<typeof findHistorySchema>;

/** Upstream uses `chrome.storage.session`; we have no session tier, so it is capped. */
export const FIND_HISTORY_LIMIT = 50;
export const FIND_HISTORY_SCHEMA_VERSION = 1;

export const findHistoryGroup: GroupSpec<FindHistory> = {
  name: "find-history",
  schema: findHistorySchema,
  defaults: (): FindHistory => ({ queries: [] }),
  schemaVersion: FIND_HISTORY_SCHEMA_VERSION,
  writeDebounceMs: 500,
};

// ---------------------------------------------------------------------------
// Frecency index (opt-in)
// ---------------------------------------------------------------------------

export const visitSchema = z.object({
  url: z.string(),
  title: z.string(),
  visitCount: z.number(),
  lastVisit: z.number(),
});

export const historyIndexSchema = z.object({
  visits: z.array(visitSchema),
});

export type Visit = z.infer<typeof visitSchema>;
export type HistoryIndex = z.infer<typeof historyIndexSchema>;

export const HISTORY_SCHEMA_VERSION = 1;

export const historyGroup: GroupSpec<HistoryIndex> = {
  name: "history",
  schema: historyIndexSchema,
  defaults: (): HistoryIndex => ({ visits: [] }),
  schemaVersion: HISTORY_SCHEMA_VERSION,
  writeDebounceMs: 2000,
};

// ---------------------------------------------------------------------------
// Session state (small, frequently written)
// ---------------------------------------------------------------------------

export const sessionSchema = z.object({
  /** Tabs we opened via `GM_openInTab`, heartbeated so Omnibar-lite can list them. */
  knownTabs: z.array(
    z.object({ url: z.string(), title: z.string(), heartbeat: z.number() }),
  ),
  /** One-time warnings already shown, keyed by id. */
  acknowledged: z.array(z.string()),
  /**
   * CSS zoom factor per origin.
   *
   * Not real browser zoom — see §4.2. Kept out of `settings` because it is
   * written far more often and a corrupt entry should not cost the user their
   * key mappings.
   */
  zoomByOrigin: z.record(z.string(), z.number()),
});

export type SessionState = z.infer<typeof sessionSchema>;

export const SESSION_SCHEMA_VERSION = 1;

export const sessionGroup: GroupSpec<SessionState> = {
  name: "session",
  schema: sessionSchema,
  defaults: (): SessionState => ({
    knownTabs: [],
    acknowledged: [],
    zoomByOrigin: {},
  }),
  schemaVersion: SESSION_SCHEMA_VERSION,
  writeDebounceMs: 1000,
};
