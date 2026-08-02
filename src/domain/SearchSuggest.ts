/**
 * Search suggestions: the pure half.
 *
 * The endpoint table, the hosts that it can reach, and the parser for the
 * answer. The network half is a service in `~/features/omnibar/Suggest.ts`.
 *
 * This file is also what `build/metadata.ts` reads to write the `@connect`
 * lines. The grant therefore cannot move away from the code that uses it.
 *
 * What leaves the device is the text that the user typed, sent to the search
 * engine that the user configured. It is the same request that the engine's own
 * search box makes, and it carries the same cookies. The caller must offer only
 * a *search*. A URL that the user typed must never reach this table. The
 * history index is never read here, and never sent.
 */

export const SUGGEST_DEBOUNCE_MS = 100;
export const SUGGEST_TIMEOUT_MS = 2500;
export const SUGGEST_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

/** Enough to fill the list, and not enough to push better rows off the screen. */
export const SUGGEST_LIMIT = 5;

/**
 * The suggest endpoints, keyed by the host suffix of the engine's search URL.
 *
 * All of them speak the OpenSearch JSON array, `[query, [suggestions]]`.
 *
 * This is a small permitted list, and not a guess made from the search URL. An
 * unknown engine gets no suggestions, which is an absent function. A guessed
 * endpoint sends the user's keystrokes to an arbitrary path on a third-party
 * host, which is a fault with consequences.
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
 * Every host that the table can reach, for the `@connect` metadata.
 *
 * It is derived from the table, and not written out again, so the grant cannot
 * move away from the code that uses it.
 */
export const SUGGEST_HOSTS: readonly string[] = [
  ...new Set(SUGGEST_ENDPOINTS.map((entry) => new URL(entry[1]).hostname)),
].sort();

/** The endpoint for a search URL, if the table has one. */
export const suggestEndpointFor = (
  searchUrl: string,
): string | undefined => {
  let host: string;
  try {
    host = new URL(searchUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const entry of SUGGEST_ENDPOINTS) {
    const suffix = entry[0];
    if (host === suffix || host.endsWith(`.${suffix}`)) return entry[1];
  }
  return undefined;
};

/**
 * Read an OpenSearch suggestion answer.
 *
 * The body is a third party's JSON, so every level is narrowed and nothing is
 * asserted. Anything unexpected gives no suggestions.
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
    // Some engines put a `[label, description]` pair in this position.
    if (typeof item === "string") out.push(item);
    else if (Array.isArray(item) && typeof item[0] === "string") {
      out.push(item[0]);
    }
  }
  return out;
};
