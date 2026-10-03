/**
 * The local history index of the omnibar.
 *
 * There is no `chrome.history` for a userscript, so the only history that the
 * omnibar can offer is the history that we recorded ourselves.
 *
 * > [!WARNING]
 * > **This is a privacy surface, and every gate below carries weight.** The
 * > storage of the manager is plain text, and the interface of the manager can
 * > read it and edit it. Everything that is written here is therefore visible
 * > to a person who can open that interface. The rules, which `record` keeps:
 * >
 * > 1. `enableHistoryIndex` is `false` by default. Recording does nothing
 * >    unless the setting is `true`. There is no other route to "on".
 * > 2. The `historyIndexDenylist` globs are read before anything is written.
 * > 3. Private browsing is skipped where it can be seen at all. Read
 * >    `detectPrivateBrowsing` for how weak that is.
 * > 4. A page with `noindex` is skipped. A site that asked the search engines
 * >    not to remember it has asked us as well.
 * > 5. The index holds at most `historyIndexLimit` entries. The oldest entry
 * >    goes first.
 * > 6. `clear` erases the stored index, and it reports a failure to erase.
 * > 7. Nothing here is ever sent anywhere. The one network call of the omnibar
 * >    is in `Suggest.ts`, which sends the *typed query* to the search engine
 * >    of the user, and never reads this index.
 */

import {
  Array,
  Boolean,
  Clock,
  Deferred,
  Duration,
  Effect,
  Option,
  Predicate,
  type Scope,
  pipe,
  String,
} from "effect";
import { constFalse, constTrue, flow } from "effect/Function";
import { Settings } from "~/core/Settings.ts";
import type { HistoryIndex as HistoryIndexData, Visit } from "~/domain/Persisted.ts";
import { Dom } from "~/platform/Dom.ts";
import { Storage, type StorageError } from "~/platform/Storage.ts";

// ---------------------------------------------------------------------------
// Denylist matching
// ---------------------------------------------------------------------------

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/gu;

/**
 * A URL glob, in the shape of `exclusionRules[].pattern`.
 *
 * `*` matches any run of characters, and `?` matches one character. Both ends
 * are anchored, so `https://mail.google.com/*` does not match a URL that only
 * contains it.
 */
export const globToRegExp = (pattern: string): RegExp => {
  const source = pattern
    .replace(REGEXP_SPECIALS, "\\$&")
    .replaceAll("\\*", "[\\s\\S]*")
    .replaceAll("\\?", "[\\s\\S]");
  return new RegExp(`^${source}$`, "u");
};

/**
 * A pattern that does not compile is text from the user. It matches nothing.
 * It is not a reason to stop recording every page.
 */
const compileGlob = Option.liftThrowable(globToRegExp);

export const matchesDenylist = (url: string, patterns: readonly string[]): boolean =>
  pipe(
    patterns,
    Array.some(
      flow(
        String.trim,
        Option.liftPredicate(String.isNonEmpty),
        Option.flatMap(compileGlob),
        Option.exists((pattern) => pattern.test(url)),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// The index itself
// ---------------------------------------------------------------------------

export interface VisitEntry {
  readonly url: string;
  readonly title: string;
  readonly at: number;
}

/**
 * Put one visit into the index, newest first, with the limit applied.
 *
 * Pure, so that the eviction rule can be read. The list is its own queue: the
 * entry that was touched moves to the front, and the limit cuts the tail. That
 * keeps the whole index as one array and one `slice`.
 */
export const mergeVisit = (
  visits: readonly Visit[],
  entry: VisitEntry,
  limit: number,
): readonly Visit[] => {
  const existing = pipe(
    visits,
    Array.findFirst((visit) => visit.url === entry.url),
  );
  const merged: Visit = {
    url: entry.url,
    // An empty title on a second visit keeps the title that we already have.
    // A navigation inside a single-page application often happens before the
    // page sets the title.
    title: pipe(
      entry.title,
      Option.liftPredicate(String.isNonEmpty),
      Option.orElse(() =>
        pipe(
          existing,
          Option.map(({ title }) => title),
        ),
      ),
      Option.getOrElse(() => ""),
    ),
    visitCount: pipe(
      existing,
      Option.match({ onNone: () => 1, onSome: ({ visitCount }) => visitCount + 1 }),
    ),
    lastVisit: entry.at,
  };
  // A limit of zero or less keeps nothing.
  return pipe(
    visits,
    Array.filter((visit) => visit.url !== entry.url),
    Array.prepend(merged),
    Array.take(limit),
  );
};

/**
 * The query keys that are worth keeping.
 *
 * The whole query string was kept before, because `?id=` is often the only
 * part of a URL that identifies the page. That is true, and it is also true of
 * `?token=`, `?access_token=`, `?sig=`, the single-use links in a password
 * message, and every session identifier that a site puts in the address bar. A
 * local index that keeps those is a worse privacy surface than an index that
 * sometimes joins two pages into one row.
 *
 * The query is therefore dropped, and only the few keys that identify a *page*
 * and not a *session* stay.
 */
const PRESERVED_QUERY_KEYS: ReadonlyArray<string> = [
  "id",
  "p",
  "page",
  "q",
  "query",
  "search",
  "v",
];

/** The longest value that a kept key may have. A token is never this short. */
const MAX_QUERY_VALUE_LENGTH = 64;

/** A title longer than this says nothing more, and it costs storage. */
const MAX_TITLE_LENGTH = 300;

const WEB_PROTOCOLS: ReadonlyArray<string> = ["https:", "http:"];

const parseUrl = Option.liftThrowable((raw: string) => new URL(raw));

/** A key that identifies a page, with a value too short to be a token. */
const isPageParameter = ([key, value]: readonly [string, string]): boolean =>
  pipe(PRESERVED_QUERY_KEYS, Array.contains(key.toLowerCase())) &&
  value.length <= MAX_QUERY_VALUE_LENGTH;

/** The query with only the keys that identify a page, with its `?`, or nothing. */
const keptQuery = (url: URL): string =>
  pipe(
    url.searchParams,
    Array.fromIterable,
    Array.filter(isPageParameter),
    (kept) => new URLSearchParams(kept).toString(),
    Option.liftPredicate(String.isNonEmpty),
    Option.match({ onNone: () => "", onSome: (query) => `?${query}` }),
  );

/**
 * The canonical form of a URL, for the index.
 *
 * The fragment goes, because it is state in the page and not a page. The
 * embedded credentials go, because they must never be persisted. Every query
 * key that is not in `PRESERVED_QUERY_KEYS` goes as well.
 *
 * `None` means "do not record this URL".
 */
export const canonicaliseUrl: (raw: string) => Option.Option<string> = flow(
  parseUrl,
  // Only a true web page. A `data:`, `blob:` or `javascript:` URL is either
  // very long or written by an attacker, and neither belongs in storage.
  Option.filter((url) => pipe(WEB_PROTOCOLS, Array.contains(url.protocol))),
  // The origin carries no credentials, and the path carries no query and no
  // fragment.
  Option.map((url) => `${url.origin}${url.pathname}${keptQuery(url)}`),
);

// ---------------------------------------------------------------------------
// Private browsing
// ---------------------------------------------------------------------------

export type PrivacyProbe = "clear" | "storage-blocked" | "tiny-quota";

/**
 * Below this quota the partition of the origin looks private or temporary.
 *
 * Safari gives a small fixed quota to a private window, and a quota that
 * follows the size of the disk to a normal window. This is an indication, and
 * not a detector.
 */
const PRIVATE_QUOTA_CEILING_BYTES = 128 * 1024 * 1024;

/**
 * How long a recording waits for the probe. The probe answers in a few
 * milliseconds, and a probe that has not answered by then counts as private.
 */
const PRIVACY_PROBE_TIMEOUT = Duration.seconds(1);

/** `navigator.storage.estimate`, already bound to its owner. */
type StorageEstimator = () => Promise<StorageEstimate>;

/**
 * Read `navigator.storage.estimate`.
 *
 * A userscript does not own its globals, so call this inside `Dom.probeOrElse`.
 */
const storageEstimator = (window: Window & typeof globalThis): Option.Option<StorageEstimator> =>
  pipe(
    // The DOM types promise both. An older WebKit, or a sandboxed frame, can
    // give neither.
    Option.fromNullishOr(window.navigator.storage),
    // `typeof`, so that the method is not read away from its owner before it
    // is bound to it.
    Option.filter((manager) => typeof manager.estimate === "function"),
    Option.map((manager) => manager.estimate.bind(manager)),
  );

const PROBE_KEY = "__vimium_webkit_private_probe__";

/** A write to `localStorage` that goes through. It throws where storage is blocked. */
const writeProbe = (window: Window & typeof globalThis) => (): boolean => {
  window.localStorage.setItem(PROBE_KEY, "1");
  window.localStorage.removeItem(PROBE_KEY);
  return true;
};

/** A quota that is small enough to look like a private window. */
const privacyOfEstimate = (estimate: StorageEstimate): PrivacyProbe =>
  pipe(
    estimate.quota,
    Option.liftPredicate(Predicate.isNumber),
    Option.filter((quota) => quota > 0 && quota < PRIVATE_QUOTA_CEILING_BYTES),
    Option.match({ onNone: (): PrivacyProbe => "clear", onSome: (): PrivacyProbe => "tiny-quota" }),
  );

/**
 * Ask for the estimate.
 *
 * `estimate()` is refused in some sandboxed frames. We then have no opinion,
 * which is `clear`.
 */
const quotaPrivacy = (estimator: StorageEstimator): Effect.Effect<PrivacyProbe> =>
  pipe(
    Effect.tryPromise(estimator),
    Effect.map(privacyOfEstimate),
    Effect.orElseSucceed((): PrivacyProbe => "clear"),
  );

/**
 * Look for private browsing, as well as it can be done.
 *
 * Two probes, and both are weak on purpose:
 *
 * - A `localStorage.setItem` that throws. This caught the private mode of
 *   Safari before version 11. A modern Safari allows the write, so `clear`
 *   here means "not obviously private", and never "certainly not private".
 * - A small quota from `navigator.storage.estimate()`. The quota is also small
 *   on a disk that is nearly full, so this gives false positives.
 *
 * The two directions of failure are not equal, and that is the design. A false
 * positive only stops us from recording, and to record nothing is always safe.
 * There is no reliable API for this question. That is exactly why the whole
 * function is opt-in, and does not ask this probe to protect anybody.
 *
 * The estimate is the one promise in this feature. ARCHITECTURE.md section 1
 * rule 5 asks for the wrap to happen once, at the edge. This is that edge.
 */
export const detectPrivateBrowsing: Effect.Effect<PrivacyProbe, never, Dom> = Effect.gen(
  function* () {
    const dom = yield* Dom;
    const writable = yield* dom.probeOrElse(writeProbe(dom.window), constFalse);
    // Without an estimate API we have no opinion, which is `clear`.
    const byQuota = pipe(
      dom.probeOrElse(() => storageEstimator(dom.window), Option.none),
      Effect.flatMap(
        Option.match({ onNone: () => Effect.succeed<PrivacyProbe>("clear"), onSome: quotaPrivacy }),
      ),
    );
    return yield* pipe(
      writable,
      Boolean.match({
        onFalse: () => Effect.succeed<PrivacyProbe>("storage-blocked"),
        onTrue: () => byQuota,
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/** Why recording is off now. */
export type RecordingBlock =
  | "disabled"
  | "private"
  | "denylisted"
  | "noindex"
  | "unsupported-url"
  | "limit-zero";

export interface HistoryIndex {
  /** Record this document, subject to every gate above. */
  readonly record: Effect.Effect<void>;
  /** Newest first. This is the copy in memory, which may be the defaults. */
  readonly visits: Effect.Effect<readonly Visit[]>;
  /** Erase the stored index. The failure is for the caller to report. */
  readonly clear: Effect.Effect<void, StorageError>;
  /** `None` when recording proceeds. Otherwise why it does not. */
  readonly blockedBy: Effect.Effect<Option.Option<RecordingBlock>>;
}

/** `<meta name="robots" content="noindex">`, and the same for `googlebot`. */
const hasNoIndexDirective = (document: Document): boolean =>
  pipe(
    document.querySelectorAll<HTMLMetaElement>('meta[name="robots" i], meta[name="googlebot" i]'),
    Array.fromIterable,
    Array.some((meta) => meta.content.toLowerCase().includes("noindex")),
  );

/** What a recording writes, once every gate has let it through. */
interface Recordable {
  readonly url: string;
  readonly limit: number;
}

/**
 * Build the index for this frame.
 *
 * The private-browsing probe runs in a fiber of the enclosing scope, and a
 * recording waits for its answer. The wait matters: on a manager with a
 * synchronous store, the first recording comes before the probe has had a
 * turn. An answer that does not come in time counts as private, so the very
 * first page of a session cannot pass through before we know.
 */
export const makeHistoryIndex: Effect.Effect<
  HistoryIndex,
  never,
  Dom | Settings | Storage | Scope.Scope
> = Effect.gen(function* () {
  const dom = yield* Dom;
  const settings = yield* Settings;
  const storage = yield* Storage;

  const privacy = yield* Deferred.make<PrivacyProbe>();
  yield* pipe(detectPrivateBrowsing, Deferred.into(privacy), Effect.forkScoped);

  /** The page and the limit, or the first gate that stops the recording. */
  const recordable = Effect.fnUntraced(function* (): Effect.fn.Return<Recordable, RecordingBlock> {
    // Gate 1. Read on every call, and not captured once, so that the setting
    // takes effect on the very next navigation after the user turns it off.
    const current = yield* pipe(
      settings.current,
      Effect.filterOrFail(
        ({ enableHistoryIndex }) => enableHistoryIndex,
        (): RecordingBlock => "disabled",
      ),
      Effect.filterOrFail(
        ({ historyIndexLimit }) => historyIndexLimit > 0,
        (): RecordingBlock => "limit-zero",
      ),
    );
    yield* pipe(
      Deferred.await(privacy),
      Effect.timeoutOption(PRIVACY_PROBE_TIMEOUT),
      Effect.filterOrFail(Option.contains<PrivacyProbe>("clear"), (): RecordingBlock => "private"),
    );
    const url = yield* pipe(
      dom.href,
      Effect.map(canonicaliseUrl),
      Effect.flatMap(Effect.fromOption((): RecordingBlock => "unsupported-url")),
      Effect.filterOrFail(
        (canonical) => !matchesDenylist(canonical, current.historyIndexDenylist),
        (): RecordingBlock => "denylisted",
      ),
    );
    yield* pipe(
      // A document that refuses the read is not recorded. The safe answer to
      // "we could not tell" is "do not record".
      dom.probeOrElse(() => hasNoIndexDirective(dom.document), constTrue),
      Effect.filterOrFail(
        (noindex) => !noindex,
        (): RecordingBlock => "noindex",
      ),
    );
    return { url, limit: current.historyIndexLimit };
  });

  const blockedBy = pipe(
    recordable(),
    Effect.match({
      onFailure: Option.some,
      onSuccess: () => Option.none<RecordingBlock>(),
    }),
    Effect.withSpan("HistoryIndex.blockedBy"),
  );

  const record = Effect.fn("HistoryIndex.record")(
    function* () {
      const { url, limit } = yield* recordable();
      const title = yield* dom.probeOrElse(
        () => dom.document.title.trim().slice(0, MAX_TITLE_LENGTH),
        () => "",
      );
      const at = yield* Clock.currentTimeMillis;
      // The limit is applied here, on the write, and never on a timer.
      yield* storage.history.update((index): HistoryIndexData => ({
        visits: mergeVisit(index.visits, { url, title, at }, limit),
      }));
    },
    // A gate that stops the recording records nothing, and says nothing. A
    // failed write is ignored too: the store already reports it on its issue
    // stream, and one page visit is not worth a message to the user.
    Effect.ignore,
  );

  return {
    record: record(),
    visits: pipe(
      storage.history.current,
      Effect.map(({ visits }) => visits),
    ),
    // `reset`, and not a write of an empty array: "erase my history" must not
    // leave a hole in the shape of this script in the storage list of the
    // manager either.
    clear: pipe(storage.history.reset, Effect.asVoid),
    blockedBy,
  };
});
