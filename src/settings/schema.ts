/**
 * Persisted configuration: schema, defaults, and migrations.
 *
 * Everything here is validated on every read (`platform/storage.ts`). Adding a
 * field is safe; changing or removing one requires a migration and a bump of
 * the corresponding `*_SCHEMA_VERSION`. The migration list is built in from
 * v0.1 deliberately — upstream Vimium's `migratePre2_0`/`migratePre2_4` history
 * is the cautionary tale.
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

export const settingsSchema = z.object({
  // --- Scrolling ---
  scrollStepSize: z.number().check(z.minimum(1), z.maximum(10_000)),
  smoothScroll: z.boolean(),

  // --- Link hints ---
  linkHintCharacters: z.string().check(z.minLength(2)),
  linkHintNumbers: z.string().check(z.minLength(2)),
  filterLinkHints: z.boolean(),
  waitForEnterForFilteredHints: z.boolean(),
  /** Extra CSS applied inside our shadow root; never injected into the page. */
  userDefinedLinkHintCss: z.string(),

  // --- Find ---
  regexFindMode: z.boolean(),
  ignoreKeyboardLayout: z.boolean(),
  /**
   * Shadow the browser's own ⌘F/Ctrl+F. Off by default: preventable on macOS
   * Safari, but possibly not on iOS (WebKit bug 191768), and stealing the
   * native binding when we cannot reliably deliver a replacement is worse than
   * not offering it.
   */
  shadowNativeFind: z.boolean(),

  // --- Navigation heuristics ---
  previousPatterns: z.string(),
  nextPatterns: z.string(),

  // --- Search ---
  searchUrl: z.string(),
  /** One `keyword: url %s Description` per line, Vimium-compatible. */
  searchEngines: z.string(),
  newTabUrl: z.string(),

  // --- UI ---
  hideHud: z.boolean(),
  /** Blend the overlay with the page's own colour scheme where detectable. */
  followPageColorScheme: z.boolean(),

  // --- Behaviour ---
  grabBackFocus: z.boolean(),
  /** Per-origin CSS zoom. Not real browser zoom; see §4.2. Off by default. */
  enableCssZoom: z.boolean(),
  /**
   * Record visited pages locally to power Omnibar-lite. Opt-in, and it must
   * stay that way: a userscript building a browsing-history index is a real
   * privacy surface and GM storage is readable from the manager's own UI.
   */
  enableHistoryIndex: z.boolean(),
  historyIndexDenylist: z.array(z.string()),
  historyIndexLimit: z.number().check(z.minimum(0), z.maximum(50_000)),

  // --- Rules ---
  exclusionRules: z.array(exclusionRuleSchema),
  /** Raw `map`/`unmap`/`unmapAll`/`mapkey` source, parsed by `core/mappings.ts`. */
  keyMappings: z.string(),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Mirrors upstream Vimium's defaults wherever a difference would be gratuitous. */
export const defaultSettings = (): Settings => ({
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
  searchEngines: [
    "w: https://www.wikipedia.org/w/index.php?title=Special:Search&search=%s Wikipedia",
    "g: https://www.google.com/search?q=%s Google",
    "d: https://duckduckgo.com/?q=%s DuckDuckGo",
    "gh: https://github.com/search?q=%s GitHub",
    "mdn: https://developer.mozilla.org/en-US/search?q=%s MDN",
  ].join("\n"),
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
});

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
