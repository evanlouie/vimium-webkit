/**
 * Everything that this application keeps between page loads.
 *
 * Storage is shared across script versions and across frames, and the user can
 * edit it in the manager's own interface. It is therefore untrusted input.
 * Every read is checked against its schema, and every failure has a defined
 * fallback. Nothing here may throw during the start of the application.
 *
 * Values are grouped, and not kept as one object. A corrupt group can be reset
 * on its own, and a mark write does not rewrite the settings.
 *
 * Two rules make this survive a version change:
 *
 * 1. **Each settings field carries its own fallback.** `field(schema, x)` turns
 *    a bad or absent field into `x`, instead of failing the whole object. This
 *    is what makes a new field safe. Data from an older build has no such key,
 *    and only that key gets the default.
 * 2. **The defaults are the schema.** `defaultSettings()` is what an empty
 *    object decodes to. There is no second list that can move away from the
 *    first.
 *
 * To change or remove a field, write a migration and increase the
 * `*_SCHEMA_VERSION` of its group.
 */

import { Effect, Option, Schema } from "effect";

// ---------------------------------------------------------------------------
// Group specifications
// ---------------------------------------------------------------------------

/** One ordered transformation of persisted data. It must be idempotent. */
export interface Migration {
  /** The `schemaVersion` that this step produces. */
  readonly to: number;
  readonly describe: string;
  readonly migrate: (data: unknown) => unknown;
}

/** Everything that `platform/Storage.ts` needs to hold one group. */
export interface GroupSpec<A> {
  readonly name: string;
  readonly schema: Schema.Codec<A, unknown>;
  readonly defaults: () => A;
  readonly schemaVersion: number;
  readonly migrations?: readonly Migration[];
  /** Join rapid writes. `0` writes at once. */
  readonly writeDebounceMs?: number;
}

// ---------------------------------------------------------------------------
// Exclusion rules
// ---------------------------------------------------------------------------

export const exclusionRuleSchema = Schema.Struct({
  /** A URL glob, e.g. `https://mail.google.com/*`. */
  pattern: Schema.String,
  /**
   * Keys to pass through to the page. Empty string disables Vimium-WebKit
   * entirely on matching URLs; a non-empty string is a partial exclusion.
   */
  passKeys: Schema.String,
});

export type ExclusionRule = typeof exclusionRuleSchema.Type;

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
 *
 * Two Effect combinators are needed, because a key that is *absent* and a key
 * that is *present but invalid* fail in different places. `catchDecoding`
 * recovers the second; the struct never reaches the field decoder for the
 * first, so `withDecodingDefaultTypeKey` makes the key optional on the wire and
 * supplies the same fallback there. Both take the already-decoded `Type`, so
 * the fallback is never re-validated against its own checks.
 */
const field = <S extends Schema.Top>(schema: S, fallback: S["Type"]) => {
  const recovered = Schema.catchDecoding<S>(() =>
    Effect.succeed(Option.some(fallback))
  )(schema);
  return Schema.withDecodingDefaultTypeKey<typeof recovered>(
    Effect.succeed(fallback),
  )(recovered);
};

/** Characters usable for hint labels must be distinct, or two hints collide. */
const distinctCharacters = (value: string): boolean =>
  new Set(value).size === value.length;

/** A search template without `%s` silently discards whatever the user typed. */
const hasQueryPlaceholder = (value: string): boolean => value.includes("%s");

export const settingsSchema = Schema.Struct({
  // --- Scrolling ---
  scrollStepSize: field(
    Schema.Finite.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(10_000),
    ),
    60,
  ),
  smoothScroll: field(Schema.Boolean, true),

  // --- Link hints ---
  linkHintCharacters: field(
    Schema.String.check(
      Schema.isMinLength(2),
      Schema.makeFilter(distinctCharacters, {
        message: "hint characters must all be different",
      }),
    ),
    "sadfjklewcmpgh",
  ),
  linkHintNumbers: field(
    Schema.String.check(
      Schema.isMinLength(2),
      Schema.makeFilter(distinctCharacters, {
        message: "hint number characters must all be different",
      }),
    ),
    "0123456789",
  ),
  filterLinkHints: field(Schema.Boolean, false),
  waitForEnterForFilteredHints: field(Schema.Boolean, true),
  /** Extra CSS applied inside our shadow root; never injected into the page. */
  userDefinedLinkHintCss: field(Schema.String, ""),

  // --- Find ---
  regexFindMode: field(Schema.Boolean, false),
  ignoreKeyboardLayout: field(Schema.Boolean, false),
  /**
   * Shadow the browser's own ⌘F/Ctrl+F. Off by default: preventable on macOS
   * Safari, but possibly not on iOS (WebKit bug 191768), and stealing the
   * native binding when we cannot reliably deliver a replacement is worse than
   * not offering it.
   */
  shadowNativeFind: field(Schema.Boolean, false),

  // --- Navigation heuristics ---
  previousPatterns: field(
    Schema.String,
    "prev,previous,back,older,<,‹,←,«,≪,<<",
  ),
  nextPatterns: field(Schema.String, "next,more,newer,>,›,→,»,≫,>>"),

  // --- Search ---
  searchUrl: field(
    Schema.String.check(
      Schema.makeFilter(hasQueryPlaceholder, {
        message: "the search URL must contain %s",
      }),
    ),
    "https://www.google.com/search?q=%s",
  ),
  /** One `keyword: url %s Description` per line, Vimium-compatible. */
  searchEngines: field(
    Schema.String,
    [
      "w: https://www.wikipedia.org/w/index.php?title=Special:Search&search=%s Wikipedia",
      "g: https://www.google.com/search?q=%s Google",
      "d: https://duckduckgo.com/?q=%s DuckDuckGo",
      "gh: https://github.com/search?q=%s GitHub",
      "mdn: https://developer.mozilla.org/en-US/search?q=%s MDN",
    ].join("\n"),
  ),
  newTabUrl: field(Schema.String, "about:blank"),
  /**
   * Ask the configured search engine for completions as the user types.
   *
   * Opt-in for the same reason `enableHistoryIndex` is: every keystroke in the
   * omnibar leaves the device, with the user's cookies attached, to a third
   * party they did not choose in that moment. "Off unless a manager cannot do
   * it" is not a privacy control — it is the absence of one.
   */
  enableSearchSuggestions: field(Schema.Boolean, false),

  // --- UI ---
  hideHud: field(Schema.Boolean, false),
  /** Blend the overlay with the page's own colour scheme where detectable. */
  followPageColorScheme: field(Schema.Boolean, true),

  // --- Behaviour ---
  grabBackFocus: field(Schema.Boolean, false),
  /**
   * Leave the arrow keys and space to a focused video or audio player.
   *
   * On by default. Those five keys seek, change the volume and toggle playback
   * on every player there is — including the browser's own `<video controls>` —
   * and we bind all five, in the capture phase, so without this a watch page
   * loses them the moment Vimium-WebKit is installed. Turn it off to scroll
   * with them everywhere, player or no player.
   */
  passMediaKeys: field(Schema.Boolean, true),
  /** Per-origin CSS zoom. Not real browser zoom; see §4.2. Off by default. */
  enableCssZoom: field(Schema.Boolean, false),
  /**
   * Record visited pages locally to power Omnibar-lite. Opt-in, and it must
   * stay that way: a userscript building a browsing-history index is a real
   * privacy surface and GM storage is readable from the manager's own UI.
   */
  enableHistoryIndex: field(Schema.Boolean, false),
  historyIndexDenylist: field(Schema.mutable(Schema.Array(Schema.String)), []),
  historyIndexLimit: field(
    Schema.Finite.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(50_000),
    ),
    5000,
  ),

  // --- Rules ---
  exclusionRules: field(Schema.mutable(Schema.Array(exclusionRuleSchema)), []),
  /** Raw `map`/`unmap`/`unmapAll`/`mapkey` source, parsed by `core/mappings.ts`. */
  keyMappings: field(Schema.String, ""),
});

export type Settings = typeof settingsSchema.Type;

/**
 * The settings a fresh install starts from.
 *
 * Derived rather than declared: every field's fallback *is* its default, so
 * decoding an empty object yields exactly the shipped configuration. A second
 * hand-written literal would be a second source of truth, and the one in the
 * e2e harness had already drifted to a single search engine against the five
 * here.
 *
 * `decodeSync` throws, which is correct here and only here: the input is the
 * literal `{}`, so the sole way to fail is a field added without a fallback.
 * That is a build-time mistake, and this line is where the test suite catches
 * it — rather than a user's `document-start`.
 */
export const defaultSettings = (): Settings =>
  Schema.decodeSync(settingsSchema)({});

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

export /**
 * Use `Schema.Finite` for every persisted number.
 *
 * `Schema.Number` accepts `NaN` and infinities. A `NaN` becomes `null` during
 * JSON encoding. The next read then rejects the group and restores defaults.
 * `Schema.Finite` rejects these values before storage receives them.
 */
const localMarkSchema = Schema.Struct({
  scrollX: Schema.Finite,
  scrollY: Schema.Finite,
  savedAt: Schema.Finite,
});

export const globalMarkSchema = Schema.Struct({
  url: Schema.String,
  scrollX: Schema.Finite,
  scrollY: Schema.Finite,
  savedAt: Schema.Finite,
});

export const marksSchema = Schema.Struct({
  /** `url -> mark letter -> position`. */
  local: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, localMarkSchema),
  ),
  /** `mark letter -> {url, position}`. */
  global: Schema.Record(Schema.String, globalMarkSchema),
});

export type Marks = typeof marksSchema.Type;
export type LocalMark = typeof localMarkSchema.Type;
export type GlobalMark = typeof globalMarkSchema.Type;

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

export const findHistorySchema = Schema.Struct({
  queries: Schema.mutable(Schema.Array(Schema.String)),
});

export type FindHistory = typeof findHistorySchema.Type;

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

export const visitSchema = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  visitCount: Schema.Finite,
  lastVisit: Schema.Finite,
});

export const historyIndexSchema = Schema.Struct({
  visits: Schema.mutable(Schema.Array(visitSchema)),
});

export type Visit = typeof visitSchema.Type;
export type HistoryIndex = typeof historyIndexSchema.Type;

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

export const sessionSchema = Schema.Struct({
  /** Tabs we opened via `GM_openInTab`, heartbeated so Omnibar-lite can list them. */
  knownTabs: Schema.mutable(Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.String,
      heartbeat: Schema.Finite,
    }),
  )),
  /** One-time warnings already shown, keyed by id. */
  acknowledged: Schema.mutable(Schema.Array(Schema.String)),
  /**
   * CSS zoom factor per origin.
   *
   * Not real browser zoom — see §4.2. Kept out of `settings` because it is
   * written far more often and a corrupt entry should not cost the user their
   * key mappings.
   */
  zoomByOrigin: Schema.Record(
    Schema.String,
    Schema.Finite,
  ),
});

export type SessionState = typeof sessionSchema.Type;

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
  // A heartbeat and a zoom factor are small, and another tab reads them. A
  // write that waits would show the user a stale list of tabs.
  writeDebounceMs: 0,
};

// ---------------------------------------------------------------------------
// The credential of the cross-frame session
// ---------------------------------------------------------------------------

/**
 * The credential that admits a frame to the cross-frame session.
 *
 * It has a group of its own, and `Storage` does not expose that group. A
 * feature that reads `Storage.session` therefore has no field that can hold
 * the credential, and it cannot name the group either.
 *
 * `frames/Auth.ts` builds this group over the value store of the manager, and
 * no other module imports this specification. The credential stays inside the
 * one module that needs it. Read issue #3.
 */
export const frameCredentialSchema = Schema.Struct({
  /** HMAC key shared by userscript frames through manager-private storage. */
  secret: field(Schema.String, ""),
});

export type FrameCredential = typeof frameCredentialSchema.Type;

export const FRAME_CREDENTIAL_SCHEMA_VERSION = 1;

export const frameCredentialGroup: GroupSpec<FrameCredential> = {
  name: "frame-credential",
  schema: frameCredentialSchema,
  defaults: (): FrameCredential => ({ secret: "" }),
  schemaVersion: FRAME_CREDENTIAL_SCHEMA_VERSION,
  // The credential must reach a sibling frame before the first handshake. The
  // write is one small value, and it happens once for each installation.
  writeDebounceMs: 0,
};
