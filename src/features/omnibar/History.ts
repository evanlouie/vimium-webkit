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
 * > 2. The `historyIndexDenylist` patterns are read before anything is
 * >    written.
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
  Duration,
  Effect,
  Option,
  Predicate,
  Ref,
  pipe,
  String,
} from "effect";
import { constFalse, constTrue, flow } from "effect/Function";
import { Settings } from "~/core/Settings.ts";
import { compilePattern, MAX_REGEX_URL_LENGTH } from "~/domain/Exclusion.ts";
import type { HistoryIndex as HistoryIndexData, Visit } from "~/domain/Persisted.ts";
import { parseUrl } from "~/domain/Url.ts";
import { Dom } from "~/platform/Dom.ts";
import { Storage, type StorageError } from "~/platform/Storage.ts";

// ---------------------------------------------------------------------------
// Denylist matching
// ---------------------------------------------------------------------------

/**
 * Does a pattern of `historyIndexDenylist` match the URL?
 *
 * A pattern reads as the pattern of an exclusion rule does. `*` matches any
 * run of characters, both ends are anchored, and a pattern between two `/` is
 * a regular expression that the safety check accepted. The glob is matched
 * without a regular expression, so a long URL cannot make it backtrack.
 *
 * A pattern that gives no matcher is text from the user. It matches nothing,
 * and it is not a reason to stop recording every page.
 *
 * A matcher does not read a URL longer than its limit, and a raw expression
 * reads only `MAX_REGEX_URL_LENGTH` characters. A longer URL could therefore
 * pass a pattern that names it. It counts as matched instead: the safe answer
 * to "we could not tell" is "do not record".
 */
const matchesDenylist = (url: string, patterns: readonly string[]): boolean =>
  pipe(
    patterns,
    Array.some(
      flow(
        compilePattern,
        Option.exists((matches) => url.length > MAX_REGEX_URL_LENGTH || matches(url)),
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

/**
 * Can this document reach `localStorage`?
 *
 * The read of the property throws where storage is blocked, for example with
 * every cookie blocked, or in a sandboxed frame. Only the property is read.
 * Nothing is written, so no other tab of the site sees a `storage` event.
 */
const storageReachable = (window: Window & typeof globalThis) => (): boolean =>
  Predicate.isNotNullish(window.localStorage);

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
 * Two probes, both weak, and both reads with no effect that the page can see:
 *
 * - A read of `localStorage` that throws, where storage is blocked. Private
 *   browsing allows storage in every browser that this script runs on, so
 *   `clear` here means "not obviously private", and never "certainly not
 *   private". The write that once caught the private mode of Safari before
 *   version 11 is gone: it fired a `storage` event in every other tab of the
 *   site, and the build targets Safari 16.
 * - A small quota from `navigator.storage.estimate()`. The quota is also small
 *   on a disk that is nearly full, so this gives false positives.
 *
 * The two directions of failure are not equal, and that is the design. A false
 * positive only stops us from recording, and to record nothing is always safe.
 * There is no reliable API for this question. That is exactly why the whole
 * function is opt-in, and does not ask this probe to protect anybody.
 *
 * The estimate is the one promise in this feature. The rules of
 * `ARCHITECTURE.md` ask for the wrap to happen once, at the edge. This is that
 * edge.
 */
export const detectPrivateBrowsing: Effect.Effect<PrivacyProbe, never, Dom> = Effect.gen(
  function* () {
    const dom = yield* Dom;
    const reachable = yield* dom.probeOrElse(storageReachable(dom.window), constFalse);
    // Without an estimate API we have no opinion, which is `clear`.
    const byQuota = pipe(
      dom.probeOrElse(() => storageEstimator(dom.window), Option.none),
      Effect.flatMap(
        Option.match({ onNone: () => Effect.succeed<PrivacyProbe>("clear"), onSome: quotaPrivacy }),
      ),
    );
    return yield* pipe(
      reachable,
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

export interface HistoryIndex {
  /** Record this document, subject to every gate above. */
  readonly record: Effect.Effect<void>;
  /** Newest first. This is the copy in memory, which may be the defaults. */
  readonly visits: Effect.Effect<readonly Visit[]>;
  /** Erase the stored index. The failure is for the caller to report. */
  readonly clear: Effect.Effect<void, StorageError>;
}

/** `<meta name="robots" content="noindex">`, and the same for `googlebot`. */
const hasNoIndexDirective = (document: Document): boolean =>
  pipe(
    document.querySelectorAll<HTMLMetaElement>('meta[name="robots" i], meta[name="googlebot" i]'),
    Array.fromIterable,
    Array.some((meta) => meta.content.toLowerCase().includes("noindex")),
  );

/**
 * Build the index for this frame.
 *
 * The private-browsing probe runs only when a recording reaches its gate, so
 * only in the top frame, which is the only frame that records, and only while
 * the index is on. A recording waits for the answer, and an answer that does
 * not come in time counts as private, so the very first page of a session
 * cannot pass through before we know. A page does not enter or leave private
 * browsing, so the first answer is kept for the life of the page.
 */
export const makeHistoryIndex: Effect.Effect<HistoryIndex, never, Dom | Settings | Storage> =
  Effect.gen(function* () {
    const dom = yield* Dom;
    const settings = yield* Settings;
    const storage = yield* Storage;

    const privacy = yield* Ref.make(Option.none<PrivacyProbe>());

    /** The answer of the probe: the kept one, or a new one that is then kept. */
    const probePrivacy: Effect.Effect<PrivacyProbe> = pipe(
      Ref.get(privacy),
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            pipe(
              detectPrivateBrowsing,
              Effect.provideService(Dom, dom),
              Effect.tap((answer) => Ref.set(privacy, Option.some(answer))),
            ),
        }),
      ),
    );

    /** The page and the limit. It fails at the first gate that stops the recording. */
    const recordable = Effect.fnUntraced(function* () {
      // Gate 1. Read on every call, and not captured once, so that the setting
      // takes effect on the very next navigation after the user turns it off.
      const current = yield* pipe(
        settings.current,
        Effect.filterOrFail(
          ({ enableHistoryIndex, historyIndexLimit }) =>
            enableHistoryIndex && historyIndexLimit > 0,
        ),
      );
      yield* pipe(
        probePrivacy,
        Effect.timeoutOption(PRIVACY_PROBE_TIMEOUT),
        Effect.filterOrFail(Option.contains<PrivacyProbe>("clear")),
      );
      const url = yield* pipe(
        dom.href,
        Effect.map(canonicaliseUrl),
        Effect.flatMap(Effect.fromOption),
        Effect.filterOrFail(
          (canonical) => !matchesDenylist(canonical, current.historyIndexDenylist),
        ),
      );
      yield* pipe(
        // A document that refuses the read is not recorded. The safe answer to
        // "we could not tell" is "do not record".
        dom.probeOrElse(() => hasNoIndexDirective(dom.document), constTrue),
        Effect.filterOrFail((noindex) => !noindex),
      );
      return { url, limit: current.historyIndexLimit };
    });

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
    };
  });
