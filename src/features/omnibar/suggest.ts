/**
 * Search suggestions over `GM_xmlHttpRequest` (IMPLEMENTATION_PLAN.md §6.7).
 *
 * This is the one place in the omnibar that talks to the network, and it is
 * gated on `enableSearchSuggestions`, which is **off by default**. The gate has
 * to be a setting rather than a capability: `GM.xmlHttpRequest` exists on quoid
 * (Userscripts) too, so "off wherever the manager cannot do it" would have left
 * the feature silently on everywhere it mattered. A `kind: "unavailable"`
 * result still latches the feature off for the session — a manager that will
 * never grow the capability is not worth nagging the user about — but that is a
 * fallback, not the control.
 *
 * The timings are the plan's: 100 ms debounce, 2.5 s abort, 2 h cache.
 *
 * Privacy note: what leaves the device here is the text the user has typed,
 * sent to the search engine they configured — the same request the engine's own
 * search box would make, and with the same cookies. The caller is responsible
 * for only offering *searches*: a typed URL must never reach this module. The
 * frecency index in `history.ts` is never consulted and never transmitted.
 */

import type { GmSurface } from "~/platform/gm.ts";
import { xmlHttpRequest } from "~/platform/gm.ts";

export const SUGGEST_DEBOUNCE_MS = 100;
export const SUGGEST_TIMEOUT_MS = 2500;
export const SUGGEST_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

/** Enough to fill the list without pushing better-sourced rows off the screen. */
export const SUGGEST_LIMIT = 5;

/**
 * Suggest endpoints, keyed by the host suffix of the engine's search URL.
 *
 * All of these speak the OpenSearch JSON array (`[query, [suggestions]]`).
 * Deliberately a small allowlist rather than a guess derived from the search
 * URL: an unknown engine gets no suggestions, which is a missing feature, while
 * a guessed endpoint gets the user's keystrokes sent to an arbitrary path on a
 * third-party host, which is a bug with consequences.
 *
 * `SUGGEST_HOSTS` below is what the `@connect` metadata grants. The two must
 * agree: a host here and not there produces a silent refusal, and a host there
 * and not here is network access we do not use.
 */
const SUGGEST_ENDPOINTS: ReadonlyArray<readonly [string, string]> = [
  [
    "google.com",
    "https://suggestqueries.google.com/complete/search?client=firefox&q=%s",
  ],
  [
    "youtube.com",
    "https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=%s",
  ],
  ["duckduckgo.com", "https://duckduckgo.com/ac/?type=list&q=%s"],
  ["bing.com", "https://api.bing.com/osjson.aspx?query=%s"],
  [
    "wikipedia.org",
    "https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=8&search=%s",
  ],
];

/**
 * Every host `SUGGEST_ENDPOINTS` can reach, for the `@connect` metadata.
 *
 * Derived from the table rather than written out again, so the grant cannot
 * drift away from the code that uses it.
 */
export const SUGGEST_HOSTS: readonly string[] = [
  ...new Set(SUGGEST_ENDPOINTS.map((entry) => new URL(entry[1]).hostname)),
].sort();

export const suggestEndpointFor = (searchUrl: string): string | null => {
  let host: string;
  try {
    host = new URL(searchUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const entry of SUGGEST_ENDPOINTS) {
    const suffix = entry[0];
    if (host === suffix || host.endsWith(`.${suffix}`)) return entry[1];
  }
  return null;
};

/**
 * Parse an OpenSearch suggestion response.
 *
 * The body is a third party's JSON, so every level is narrowed rather than
 * asserted; anything unexpected yields no suggestions rather than a throw on
 * the keystroke path.
 */
export const parseSuggestResponse = (body: string): readonly string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const second: unknown = parsed[1];
  if (!Array.isArray(second)) return [];

  const out: string[] = [];
  for (const item of second) {
    // Some engines return `[label, description]` pairs in this slot.
    if (typeof item === "string") out.push(item);
    else if (Array.isArray(item) && typeof item[0] === "string") {
      out.push(item[0]);
    }
  }
  return out;
};

export interface Suggester {
  /**
   * Ask for suggestions for `query` against `searchUrl`'s engine.
   *
   * Debounced and self-cancelling: calling this again supersedes the previous
   * request, in flight or not. `onResults` fires at most once per call and only
   * if the call was not superseded.
   */
  request(
    searchUrl: string,
    query: string,
    onResults: (query: string, suggestions: readonly string[]) => void,
  ): void;
  /** Drop any pending debounce and abort anything in flight. */
  cancel(): void;
  dispose(): void;
  /** `false` once the manager has told us `GM_xmlhttpRequest` does not exist. */
  isAvailable(): boolean;
}

interface CacheEntry {
  readonly at: number;
  readonly suggestions: readonly string[];
}

export const createSuggester = (surface: GmSurface): Suggester => {
  const cache = new Map<string, CacheEntry>();
  let available = true;

  let debounceTimer: number | null = null;
  let abortTimer: number | null = null;
  let abortInFlight: (() => void) | null = null;
  /** Bumped on every `request`; a late response with a stale token is dropped. */
  let generation = 0;

  const clearTimers = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    if (abortTimer !== null) clearTimeout(abortTimer);
    debounceTimer = null;
    abortTimer = null;
  };

  const cancel = (): void => {
    generation++;
    clearTimers();
    abortInFlight?.();
    abortInFlight = null;
  };

  const send = (
    endpoint: string,
    key: string,
    query: string,
    token: number,
    onResults: (query: string, suggestions: readonly string[]) => void,
  ): void => {
    const url = endpoint.replaceAll("%s", () => encodeURIComponent(query));
    const started = xmlHttpRequest(surface, {
      url,
      method: "GET",
      timeoutMs: SUGGEST_TIMEOUT_MS,
    });

    if (started.isErr()) {
      // Latched, and silent by design: on a manager without `@connect` support
      // this is a permanent condition, not an incident.
      if (started.error.kind === "unavailable") available = false;
      return;
    }

    const handle = started.value;
    abortInFlight = () => handle.abort();

    // A belt-and-braces abort alongside the manager's own `timeout`: not every
    // manager honours it, and a hung request must not pin the handle forever.
    abortTimer = setTimeout(() => {
      abortTimer = null;
      if (generation === token) handle.abort();
    }, SUGGEST_TIMEOUT_MS);

    void handle.response.match(
      (response) => {
        if (abortTimer !== null) {
          clearTimeout(abortTimer);
          abortTimer = null;
        }
        if (generation !== token) return;
        abortInFlight = null;

        if (response.status !== 200) return;
        const suggestions = parseSuggestResponse(response.responseText ?? "")
          .slice(0, SUGGEST_LIMIT);
        cache.set(key, { at: Date.now(), suggestions });
        onResults(query, suggestions);
      },
      (error) => {
        if (generation !== token) return;
        abortInFlight = null;
        if (error.kind === "unavailable") available = false;
        // Every other failure — offline, timeout, CORS refusal — is a
        // non-event: the omnibar simply shows the rows it already has.
      },
    );
  };

  return {
    isAvailable: (): boolean => available,

    request: (searchUrl, query, onResults): void => {
      cancel();
      if (!available) return;

      const trimmed = query.trim();
      if (trimmed.length === 0) return;

      const endpoint = suggestEndpointFor(searchUrl);
      if (endpoint === null) return;

      const key = `${endpoint}\u0000${trimmed}`;
      const cached = cache.get(key);
      if (cached !== undefined) {
        if (Date.now() - cached.at < SUGGEST_CACHE_TTL_MS) {
          onResults(trimmed, cached.suggestions);
          return;
        }
        cache.delete(key);
      }

      const token = generation;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (generation !== token) return;
        send(endpoint, key, trimmed, token, onResults);
      }, SUGGEST_DEBOUNCE_MS);
    },

    cancel,

    dispose: (): void => {
      cancel();
      cache.clear();
    },
  };
};
