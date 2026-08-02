/**
 * Search suggestions: the network half.
 *
 * This is the one place in the omnibar that talks to the network, and it is
 * gated on `enableSearchSuggestions`, which is **off by default**. The gate is
 * a setting, and not a capability test: `GM.xmlHttpRequest` exists on quoid
 * (Userscripts) as well, so "off where the manager cannot do it" would have
 * left the function quietly on everywhere that it matters. A `GmError` with
 * the reason `unavailable` still latches the function off for the session,
 * because a manager that will never grow the capability is not worth a second
 * message. That latch is a fallback, and not the control.
 *
 * The timings are `SUGGEST_DEBOUNCE_MS`, `SUGGEST_TIMEOUT_MS` and
 * `SUGGEST_CACHE_TTL_MS` from `~/domain/SearchSuggest.ts`. The debounce is
 * `Effect.sleep` inside a `FiberHandle`, so a newer request interrupts the
 * older one: cancellation is fiber interruption, and there is no timer and no
 * `AbortController` here.
 *
 * Privacy. What leaves the device is the text that the user typed, sent to the
 * search engine that the user configured. It is the same request that the
 * search box of that engine makes, and it carries the same cookies. The caller
 * must offer only a *search*. A URL that the user typed must never reach this
 * service. The local history index is never read here, and never sent.
 */

import {
  Clock,
  Duration,
  Effect,
  FiberHandle,
  Option,
  Ref,
  type Scope,
} from "effect";
import { Settings } from "~/core/Settings.ts";
import {
  parseSuggestResponse,
  SUGGEST_CACHE_TTL_MS,
  SUGGEST_DEBOUNCE_MS,
  SUGGEST_LIMIT,
  SUGGEST_TIMEOUT_MS,
  suggestEndpointFor,
} from "~/domain/SearchSuggest.ts";
import type { GmXhrResponse } from "~/platform/Gm.ts";
import { Gm } from "~/platform/Gm.ts";

/** What a completed request gives back to the caller. */
export type SuggestionSink = (
  query: string,
  suggestions: readonly string[],
) => Effect.Effect<void>;

export interface Suggester {
  /**
   * Ask the engine of `searchUrl` for completions of `query`.
   *
   * Debounced, and self-cancelling: a second call supersedes the first one,
   * whether or not the first one already left the device. `onResults` runs at
   * most once for each call, and only while the call is the newest one.
   */
  readonly request: (
    searchUrl: string,
    query: string,
    onResults: SuggestionSink,
  ) => Effect.Effect<void>;

  /** Drop the debounce that is waiting, and interrupt the request in flight. */
  readonly cancel: Effect.Effect<void>;

  /** `false` once the manager has told us that it has no request API. */
  readonly isAvailable: Effect.Effect<boolean>;
}

interface CacheEntry {
  readonly at: number;
  readonly suggestions: readonly string[];
}

const NO_SUGGESTIONS = Option.none<readonly string[]>();

/**
 * Read the answer of the engine.
 *
 * `None` for anything that is not a complete, successful answer. A failure
 * here is a non-event: the omnibar shows the rows that it already has.
 */
const readResponse = (
  response: Option.Option<GmXhrResponse>,
): Option.Option<readonly string[]> => {
  if (Option.isNone(response)) return NO_SUGGESTIONS;
  if (response.value.status !== 200) return NO_SUGGESTIONS;
  return Option.some(
    parseSuggestResponse(response.value.responseText ?? "").slice(
      0,
      SUGGEST_LIMIT,
    ),
  );
};

/**
 * Build the suggester for this frame.
 *
 * The cache lives in a `Ref` inside the service, and it goes away with the
 * enclosing scope. It holds the text that the user typed, so it must not
 * outlive the page.
 */
export const makeSuggester: Effect.Effect<
  Suggester,
  never,
  Gm | Settings | Scope.Scope
> = Effect.gen(function*() {
  const gm = yield* Gm;
  const settings = yield* Settings;

  const cache = yield* Ref.make<ReadonlyMap<string, CacheEntry>>(new Map());
  const available = yield* Ref.make(gm.canRequest);
  const inFlight = yield* FiberHandle.make<void, never>();

  const fetch = Effect.fn("Suggester.fetch")(
    function*(endpoint: string, query: string) {
      // A function, so that a query which holds `$&` cannot become a
      // replacement pattern.
      const url = endpoint.replaceAll(
        "%s",
        () => encodeURIComponent(query),
      );

      return yield* Effect.matchEffect(
        // Two deadlines, and both are needed. The manager gets `timeoutMs`,
        // and not every manager honours it. `Effect.timeoutOption` interrupts
        // the fiber, which releases the request handle. That interruption is
        // what the old `AbortController` did.
        Effect.timeoutOption(
          gm.request({
            url,
            method: "GET",
            timeoutMs: SUGGEST_TIMEOUT_MS,
          }),
          Duration.millis(SUGGEST_TIMEOUT_MS),
        ),
        {
          onFailure: (error) =>
            // Latched, and silent by design. On a manager without `@connect`
            // this is a permanent condition, and not an incident. Every other
            // failure — no network, a timeout, a refusal by CORS — leaves the
            // list as it is.
            error.reason === "unavailable"
              ? Effect.as(Ref.set(available, false), NO_SUGGESTIONS)
              : Effect.succeed(NO_SUGGESTIONS),
          onSuccess: (response) => Effect.succeed(readResponse(response)),
        },
      );
    },
  );

  const request = Effect.fn("Suggester.request")(
    function*(searchUrl: string, query: string, onResults: SuggestionSink) {
      // A new question replaces the old one, in flight or not.
      yield* FiberHandle.clear(inFlight);

      // The gate. It is a setting, and it is off by default, because every
      // keystroke here leaves the device to a third party with the cookies of
      // the user.
      const current = yield* settings.current;
      if (!current.enableSearchSuggestions) return;
      if (!(yield* Ref.get(available))) return;

      const trimmed = query.trim();
      if (trimmed.length === 0) return;

      // A small permitted table, and not a guess from the search URL. An
      // unknown engine gets no suggestions.
      const endpoint = suggestEndpointFor(searchUrl);
      if (endpoint === undefined) return;

      const key = `${endpoint}\u0000${trimmed}`;
      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(cache)).get(key);
      if (cached !== undefined) {
        if (now - cached.at < SUGGEST_CACHE_TTL_MS) {
          yield* onResults(trimmed, cached.suggestions);
          return;
        }
        yield* Ref.update(cache, (current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
      }

      yield* Effect.asVoid(FiberHandle.run(
        inFlight,
        Effect.gen(function*() {
          yield* Effect.sleep(Duration.millis(SUGGEST_DEBOUNCE_MS));
          const suggestions = yield* fetch(endpoint, trimmed);
          if (Option.isNone(suggestions)) return;
          const at = yield* Clock.currentTimeMillis;
          yield* Ref.update(cache, (entries) => {
            const next = new Map(entries);
            next.set(key, { at, suggestions: suggestions.value });
            return next;
          });
          yield* onResults(trimmed, suggestions.value);
        }),
      ));
    },
  );

  return {
    request,
    cancel: FiberHandle.clear(inFlight),
    isAvailable: Ref.get(available),
  };
});
