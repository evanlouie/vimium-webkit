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

import { Clock, Effect, Option, Predicate, Ref, type Scope } from "effect";
import { Settings } from "~/core/Settings.ts";
import type {
  HistoryIndex as HistoryIndexData,
  Visit,
} from "~/domain/Persisted.ts";
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

export const matchesDenylist = (
  url: string,
  patterns: readonly string[],
): boolean =>
  patterns.some((pattern) => {
    const trimmed = pattern.trim();
    if (trimmed.length === 0) return false;
    try {
      return globToRegExp(trimmed).test(url);
    } catch {
      // A pattern that does not compile is text from the user. It matches
      // nothing. It is not a reason to stop recording every page.
      return false;
    }
  });

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
  if (limit <= 0) return [];

  const existing = visits.find((visit) => visit.url === entry.url);
  const rest = visits.filter((visit) => visit.url !== entry.url);

  const merged: Visit = {
    url: entry.url,
    // An empty title on a second visit keeps the title that we already have.
    // A navigation inside a single-page application often happens before the
    // page sets the title.
    title: entry.title.length > 0 ? entry.title : existing?.title ?? "",
    visitCount: (existing?.visitCount ?? 0) + 1,
    lastVisit: entry.at,
  };

  return [merged, ...rest].slice(0, limit);
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
const PRESERVED_QUERY_KEYS: ReadonlySet<string> = new Set([
  "id",
  "p",
  "page",
  "q",
  "query",
  "search",
  "v",
]);

/** The longest value that a kept key may have. A token is never this short. */
const MAX_QUERY_VALUE_LENGTH = 64;

/** A title longer than this says nothing more, and it costs storage. */
const MAX_TITLE_LENGTH = 300;

/**
 * The canonical form of a URL, for the index.
 *
 * The fragment goes, because it is state in the page and not a page. The
 * embedded credentials go, because they must never be persisted. Every query
 * key that is not in `PRESERVED_QUERY_KEYS` goes as well.
 *
 * `None` means "do not record this URL".
 */
export const canonicaliseUrl = (raw: string): Option.Option<string> => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return Option.none();
  }
  // Only a true web page. A `data:`, `blob:` or `javascript:` URL is either
  // very long or written by an attacker, and neither belongs in storage.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return Option.none();
  }

  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";

  const kept = new URLSearchParams();
  for (const [key, value] of parsed.searchParams) {
    if (!PRESERVED_QUERY_KEYS.has(key.toLowerCase())) continue;
    if (value.length > MAX_QUERY_VALUE_LENGTH) continue;
    kept.append(key, value);
  }
  parsed.search = kept.toString();

  return Option.some(parsed.href);
};

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

/** `navigator.storage.estimate`, already bound to its owner. */
type StorageEstimator = () => Promise<StorageEstimate>;

/**
 * Read `navigator.storage.estimate`.
 *
 * A userscript does not own its globals, so call this inside `Dom.probeOr`.
 */
const storageEstimator = (
  window: Window & typeof globalThis,
): Option.Option<StorageEstimator> => {
  const manager: unknown = window.navigator.storage;
  if (!Predicate.hasProperty(manager, "estimate")) return Option.none();
  const estimate: unknown = Reflect.get(manager, "estimate");
  if (!Predicate.isFunction(estimate)) return Option.none();
  const call = estimate as (this: unknown) => Promise<StorageEstimate>;
  return Option.some(() => Reflect.apply(call, manager, []));
};

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
export const detectPrivateBrowsing: Effect.Effect<PrivacyProbe, never, Dom> =
  Effect.gen(function*() {
    const dom = yield* Dom;

    const wrote = yield* dom.probeOr(() => {
      const key = "__vimium_webkit_private_probe__";
      dom.window.localStorage.setItem(key, "1");
      dom.window.localStorage.removeItem(key);
      return true;
    }, false);
    if (!wrote) return "storage-blocked";

    const estimator = yield* dom.probeOr(
      () => storageEstimator(dom.window),
      Option.none<StorageEstimator>(),
    );
    if (Option.isNone(estimator)) return "clear";

    // `estimate()` is refused in some sandboxed frames. We then have no
    // opinion, which is `clear`.
    const estimate = yield* Effect.orElseSucceed(
      Effect.tryPromise({
        try: estimator.value,
        catch: () => undefined,
      }),
      (): StorageEstimate => ({}),
    );
    const quota = estimate.quota;
    if (
      typeof quota === "number" && quota > 0 &&
      quota < PRIVATE_QUOTA_CEILING_BYTES
    ) {
      return "tiny-quota";
    }
    return "clear";
  });

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
const hasNoIndexDirective = (document: Document): boolean => {
  const metas = document.querySelectorAll<HTMLMetaElement>(
    'meta[name="robots" i], meta[name="googlebot" i]',
  );
  for (const meta of metas) {
    if (meta.content.toLowerCase().includes("noindex")) return true;
  }
  return false;
};

/**
 * Build the index for this frame.
 *
 * The private-browsing probe runs in a fiber of the enclosing scope. Until it
 * answers, the state is "unknown", which counts as private. The very first
 * page of a session therefore cannot pass through before we know.
 */
export const makeHistoryIndex: Effect.Effect<
  HistoryIndex,
  never,
  Dom | Settings | Storage | Scope.Scope
> = Effect.gen(function*() {
  const dom = yield* Dom;
  const settings = yield* Settings;
  const storage = yield* Storage;

  const privacy = yield* Ref.make(Option.none<PrivacyProbe>());
  yield* Effect.forkScoped(
    Effect.flatMap(
      detectPrivateBrowsing,
      (result) => Ref.set(privacy, Option.some(result)),
    ),
  );

  const blockedBy = Effect.fn("HistoryIndex.blockedBy")(function*() {
    const block = (reason: RecordingBlock): Option.Option<RecordingBlock> =>
      Option.some(reason);
    const current = yield* settings.current;

    // Gate 1. Read on every call, and not captured once, so that the setting
    // takes effect on the very next navigation after the user turns it off.
    if (!current.enableHistoryIndex) return block("disabled");
    if (current.historyIndexLimit <= 0) return block("limit-zero");

    const probe = yield* Ref.get(privacy);
    if (Option.isNone(probe) || probe.value !== "clear") {
      return block("private");
    }

    const url = canonicaliseUrl(yield* dom.href);
    if (Option.isNone(url)) return block("unsupported-url");
    if (matchesDenylist(url.value, current.historyIndexDenylist)) {
      return block("denylisted");
    }

    const noindex = yield* dom.probeOr(
      () => hasNoIndexDirective(dom.document),
      // A document that refuses the read is not recorded. The safe answer to
      // "we could not tell" is "do not record".
      true,
    );
    if (noindex) return block("noindex");

    return Option.none<RecordingBlock>();
  });

  const record = Effect.fn("HistoryIndex.record")(function*() {
    if (Option.isSome(yield* blockedBy())) return;

    const url = canonicaliseUrl(yield* dom.href);
    if (Option.isNone(url)) return;

    const current = yield* settings.current;
    const title = yield* dom.probeOr(
      () => dom.document.title.trim().slice(0, MAX_TITLE_LENGTH),
      "",
    );
    const at = yield* Clock.currentTimeMillis;

    // The limit is applied here, on the write, and never on a timer. The
    // failure is ignored: the store already reports it on its issue stream,
    // and one page visit is not worth a message to the user.
    yield* Effect.ignore(
      storage.history.update((index): HistoryIndexData => ({
        visits: [
          ...mergeVisit(
            index.visits,
            { url: url.value, title, at },
            current.historyIndexLimit,
          ),
        ],
      })),
    );
  });

  return {
    record: record(),
    visits: Effect.map(storage.history.current, (index) => index.visits),
    // `reset`, and not a write of an empty array: "erase my history" must not
    // leave a hole in the shape of this script in the storage list of the
    // manager either.
    clear: Effect.asVoid(storage.history.reset),
    blockedBy: blockedBy(),
  };
});
