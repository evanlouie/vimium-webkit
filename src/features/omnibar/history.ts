/**
 * The opt-in frecency index (IMPLEMENTATION_PLAN.md §6.7).
 *
 * There is no `chrome.history` for a userscript, so the only history the
 * omnibar can offer is history we recorded ourselves.
 *
 * > [!WARNING]
 * > **This is a privacy surface, and every gate below is load-bearing.** GM
 * > storage is plain text and is readable — and editable — from the userscript
 * > manager's own UI, which means anything written here is visible to anyone
 * > who can open that UI. The rules, enforced in `record()`:
 * >
 * > 1. `enableHistoryIndex` defaults to `false`; recording is a no-op unless it
 * >    is explicitly `true`. There is no implicit enable path.
 * > 2. `historyIndexDenylist` globs are honoured before anything is written.
 * > 3. Private browsing is skipped where it is detectable at all (see
 * >    `detectPrivateBrowsing` for exactly how weak that guarantee is).
 * > 4. Pages marked `noindex` are skipped: a site that has asked search engines
 * >    not to remember it has asked us too.
 * > 5. The index is capped at `historyIndexLimit` with LRU eviction.
 * > 6. `clear()` exists and is wired to `:clear-history`.
 * > 7. Nothing is ever transmitted. The only network call in this subsystem is
 * >    `suggest.ts`, which sends the *typed query* to the user's chosen search
 * >    engine and never touches this index.
 */

import type { AppContext } from "~/core/context.ts";
import type { HistoryIndex, Visit } from "~/settings/schema.ts";

// ---------------------------------------------------------------------------
// Denylist matching
// ---------------------------------------------------------------------------

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/gu;

/**
 * A URL glob, in the same shape as `exclusionRules[].pattern`: `*` matches any
 * run of characters, `?` matches one. Anchored at both ends, so
 * `https://mail.google.com/*` does not accidentally match a URL that merely
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
      // A pattern that will not compile is user text; treat it as matching
      // nothing rather than as a reason to stop recording everything.
      return false;
    }
  });

// ---------------------------------------------------------------------------
// The index itself
// ---------------------------------------------------------------------------

/**
 * Fold a visit into the index, newest first, capped.
 *
 * Pure so the eviction policy is inspectable. The list doubles as its own LRU
 * queue: the entry just touched moves to the front and the cap chops the tail,
 * which keeps the whole thing one array and one `slice`.
 */
export const mergeVisit = (
  visits: readonly Visit[],
  entry: { readonly url: string; readonly title: string; readonly at: number },
  limit: number,
): readonly Visit[] => {
  if (limit <= 0) return [];

  const existing = visits.find((visit) => visit.url === entry.url);
  const rest = visits.filter((visit) => visit.url !== entry.url);

  const merged: Visit = {
    url: entry.url,
    // An empty title on a re-visit keeps the one we already had: SPA
    // navigations frequently fire before the title is set.
    title: entry.title.length > 0 ? entry.title : existing?.title ?? "",
    visitCount: (existing?.visitCount ?? 0) + 1,
    lastVisit: entry.at,
  };

  return [merged, ...rest].slice(0, limit);
};

/**
 * Canonical form for indexing.
 *
 * The fragment is dropped (it is client-side state, not a page) along with any
 * embedded credentials, which have no business being persisted anywhere.
 * The query string is *kept*: `?id=` URLs are often the only distinguishing
 * part, and dropping it would collapse every page of a site into one row.
 */
export const canonicaliseUrl = (raw: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // Only real, navigable web pages. `data:`/`blob:`/`javascript:` URLs are
  // either enormous or attacker-supplied, and neither belongs in storage.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
};

// ---------------------------------------------------------------------------
// Private browsing
// ---------------------------------------------------------------------------

export type PrivacyProbe = "clear" | "storage-blocked" | "tiny-quota";

/**
 * Below this, the origin's quota looks like a private/ephemeral partition.
 *
 * Safari reports a small, fixed quota to private windows while normal browsing
 * gets a disk-proportional allowance. This is a heuristic, not a detector.
 */
const PRIVATE_QUOTA_CEILING_BYTES = 128 * 1024 * 1024;

/**
 * Best-effort private-browsing detection, and the emphasis is on *best-effort*.
 *
 * Two probes, both deliberately weak:
 *
 * - `localStorage.setItem` throwing. This caught Safari's pre-11 private mode
 *   outright; modern Safari allows the write, so a `clear` result here means
 *   "not obviously private", never "definitely not private".
 * - `navigator.storage.estimate()` reporting a small quota. Also reports small
 *   quotas on a nearly-full disk, so it false-positives.
 *
 * Both failure directions are asymmetric on purpose: a false positive only
 * means we decline to record, and declining to record is always safe. There is
 * no reliable API for this, which is precisely why the whole feature is opt-in
 * rather than relying on this function to protect anyone.
 */
export const detectPrivateBrowsing = async (): Promise<PrivacyProbe> => {
  try {
    const key = "__vimium_webkit_private_probe__";
    globalThis.localStorage.setItem(key, "1");
    globalThis.localStorage.removeItem(key);
  } catch {
    return "storage-blocked";
  }

  const storage: StorageManager | undefined = navigator.storage;
  if (typeof storage?.estimate === "function") {
    try {
      const estimate = await storage.estimate();
      const quota = estimate.quota;
      if (
        typeof quota === "number" && quota > 0 &&
        quota < PRIVATE_QUOTA_CEILING_BYTES
      ) {
        return "tiny-quota";
      }
    } catch {
      // `estimate()` rejects in some sandboxed frames. No opinion.
    }
  }

  return "clear";
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** Why recording is currently off, or `null` when it is on. */
export type RecordingBlock =
  | "disabled"
  | "private"
  | "denylisted"
  | "noindex"
  | "unsupported-url"
  | "limit-zero";

export interface HistoryIndexApi {
  /** Record the current document, subject to every gate above. */
  record(): void;
  /** Newest first. Safe to call before hydration; returns what is cached. */
  visits(): readonly Visit[];
  /** Backs `:clear-history`. Wipes the persisted index, not just the cache. */
  clear(): Promise<void>;
  /** `null` when recording would proceed; otherwise why it would not. */
  blockedBy(): RecordingBlock | null;
}

/** `<meta name="robots" content="noindex">` and friends. */
const hasNoIndexDirective = (): boolean => {
  const metas = document.querySelectorAll<HTMLMetaElement>(
    'meta[name="robots" i], meta[name="googlebot" i]',
  );
  for (const meta of metas) {
    if (meta.content.toLowerCase().includes("noindex")) return true;
  }
  return false;
};

export const createHistoryIndex = (app: AppContext): HistoryIndexApi => {
  /**
   * `null` until the async probe settles. Treated as "assume private" so the
   * very first page load of a session cannot slip through before we know.
   */
  let privacy: PrivacyProbe | null = null;
  void detectPrivateBrowsing().then((result) => {
    privacy = result;
  });

  const blockedBy = (): RecordingBlock | null => {
    const settings = app.settings();
    // Gate 1. Read per call rather than captured at construction, so toggling
    // the setting off takes effect on the very next navigation.
    if (!settings.enableHistoryIndex) return "disabled";
    if (settings.historyIndexLimit <= 0) return "limit-zero";
    if (privacy !== "clear") return "private";

    const url = canonicaliseUrl(location.href);
    if (url === null) return "unsupported-url";
    if (matchesDenylist(url, settings.historyIndexDenylist)) {
      return "denylisted";
    }
    if (hasNoIndexDirective()) return "noindex";
    return null;
  };

  return {
    blockedBy,

    record: (): void => {
      if (blockedBy() !== null) return;
      const url = canonicaliseUrl(location.href);
      if (url === null) return;

      const limit = app.settings().historyIndexLimit;
      const at = Date.now();
      const title = document.title.trim().slice(0, 300);

      void app.groups.history.update((current): HistoryIndex => ({
        visits: [...mergeVisit(current.visits, { url, title, at }, limit)],
      }));
    },

    visits: (): readonly Visit[] => app.groups.history.current().visits,

    clear: async (): Promise<void> => {
      // `reset()` removes the stored key outright rather than writing an empty
      // array over it: "clear my history" should not leave a
      // vimium-webkit-shaped hole in the manager's storage list either.
      await app.groups.history.reset();
    },
  };
};
