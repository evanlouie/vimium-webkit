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

import { Array, Option, Order, Schema, SchemaTransformation, pipe } from "effect";
import { flow } from "effect/Function";

export const SUGGEST_DEBOUNCE_MS = 100;
export const SUGGEST_TIMEOUT_MS = 2500;
export const SUGGEST_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

/** Enough to fill the list, and not enough to push better rows off the screen. */
export const SUGGEST_LIMIT = 5;

interface SuggestEndpoint {
  /** The host suffix of the engine's search URL. */
  readonly suffix: string;
  /** The endpoint, with `%s` where the query goes. */
  readonly url: string;
}

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
const SUGGEST_ENDPOINTS: ReadonlyArray<SuggestEndpoint> = [
  {
    suffix: "google.com",
    url: "https://suggestqueries.google.com/complete/search?client=firefox&q=%s",
  },
  {
    suffix: "youtube.com",
    url: "https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=%s",
  },
  { suffix: "duckduckgo.com", url: "https://duckduckgo.com/ac/?type=list&q=%s" },
  { suffix: "bing.com", url: "https://api.bing.com/osjson.aspx?query=%s" },
  {
    suffix: "wikipedia.org",
    url: "https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=8&search=%s",
  },
];

/**
 * Every host that the table can reach, for the `@connect` metadata.
 *
 * It is derived from the table, and not written out again, so the grant cannot
 * move away from the code that uses it.
 */
export const SUGGEST_HOSTS: readonly string[] = pipe(
  SUGGEST_ENDPOINTS,
  Array.map(({ url }) => new URL(url).hostname),
  Array.dedupe,
  Array.sort(Order.String),
);

const hostOf = Option.liftThrowable((url: string) => new URL(url).hostname.toLowerCase());

/** The entry covers the host itself and every subdomain of it. */
const servesHost =
  (host: string) =>
  ({ suffix }: SuggestEndpoint): boolean =>
    host === suffix || host.endsWith(`.${suffix}`);

/** The endpoint for a search URL, if the table has one. */
export const suggestEndpointFor: (searchUrl: string) => Option.Option<string> = flow(
  hostOf,
  Option.flatMap((host) => pipe(SUGGEST_ENDPOINTS, Array.findFirst(servesHost(host)))),
  Option.map(({ url }) => url),
);

/**
 * An OpenSearch answer, `[query, [suggestions], ...]`.
 *
 * The entries of the list stay `unknown` here. An entry of a shape that we do
 * not know costs that entry, and not the whole list.
 */
const SuggestAnswer = Schema.fromJsonString(
  Schema.TupleWithRest(Schema.Tuple([Schema.Unknown, Schema.Array(Schema.Unknown)]), [
    Schema.Unknown,
  ]),
);

/** Some engines put a `[label, description]` pair in the place of a suggestion. */
const LabelledSuggestion = pipe(
  Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Unknown]),
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: ([label]) => label,
      encode: (label): readonly [string] => [label],
    }),
  ),
);

const decodeSuggestion = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, LabelledSuggestion]),
);

/**
 * Read an OpenSearch suggestion answer.
 *
 * The body is a third party's JSON, so it is decoded, and nothing is asserted.
 * Anything unexpected gives no suggestions.
 */
export const parseSuggestResponse: (body: string) => readonly string[] = flow(
  Schema.decodeOption(SuggestAnswer),
  Option.map(([, entries]) => entries),
  Option.getOrElse(() => Array.empty<unknown>()),
  Array.map((entry) => decodeSuggestion(entry)),
  Array.getSomes,
);
