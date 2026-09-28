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
  Array,
  Boolean,
  Clock,
  Duration,
  Effect,
  FiberHandle,
  Match,
  Option,
  Record,
  Ref,
  type Scope,
  pipe,
  String,
} from "effect";
import { Settings } from "~/core/Settings.ts";
import { buildSearchUrl } from "~/domain/SearchEngine.ts";
import {
  parseSuggestResponse,
  SUGGEST_CACHE_TTL_MS,
  SUGGEST_DEBOUNCE_MS,
  SUGGEST_LIMIT,
  SUGGEST_TIMEOUT_MS,
  suggestEndpointFor,
} from "~/domain/SearchSuggest.ts";
import type { GmError, XhrResponse } from "~/platform/Gm.ts";
import { Gm } from "~/platform/Gm.ts";

/** What a completed request gives back to the caller. */
export type SuggestionSink = (query: string, suggestions: readonly string[]) => Effect.Effect<void>;

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

/** A question that may leave the device, and the engine that it goes to. */
interface Question {
  readonly endpoint: string;
  /** The trimmed query. */
  readonly text: string;
  readonly cacheKey: string;
}

/**
 * The question for a query, if there is one to ask.
 *
 * A small permitted table, and not a guess from the search URL. An unknown
 * engine gets no suggestions.
 */
const questionFor = (searchUrl: string, query: string): Option.Option<Question> =>
  Option.gen(function* () {
    const text = yield* pipe(query.trim(), Option.liftPredicate(String.isNonEmpty));
    const endpoint = yield* suggestEndpointFor(searchUrl);
    return { endpoint, text, cacheKey: `${endpoint}\u0000${text}` };
  });

interface CacheEntry {
  readonly at: number;
  readonly suggestions: readonly string[];
}

type Cache = Record.ReadonlyRecord<string, CacheEntry>;

/** An answer that is young enough to show again without a new request. */
const isFresh =
  (now: number) =>
  ({ at }: CacheEntry): boolean =>
    now - at < SUGGEST_CACHE_TTL_MS;

const NO_SUGGESTIONS = Option.none<readonly string[]>();

/**
 * A complete, successful answer.
 *
 * Anything else is a non-event: the omnibar shows the rows that it already
 * has.
 */
const isAnswer = (response: XhrResponse): boolean => response.status === 200;

const suggestionsIn = (response: XhrResponse): readonly string[] =>
  pipe(response.responseText, parseSuggestResponse, Array.take(SUGGEST_LIMIT));

/**
 * Build the suggester for this frame.
 *
 * The cache lives in a `Ref` inside the service, and it goes away with the
 * enclosing scope. It holds the text that the user typed, so it must not
 * outlive the page.
 */
export const makeSuggester: Effect.Effect<Suggester, never, Gm | Settings | Scope.Scope> =
  Effect.gen(function* () {
    const gm = yield* Gm;
    const settings = yield* Settings;

    const cache = yield* Ref.make<Cache>(Record.empty());
    const available = yield* Ref.make(gm.canRequest);
    const inFlight = yield* FiberHandle.make<void, never>();

    /**
     * Latched, and silent by design. On a manager without `@connect` this is
     * a permanent condition, and not an incident. Every other failure — no
     * network, a timeout, a refusal by CORS — leaves the list as it is.
     */
    const onRequestFailure = (error: GmError) =>
      pipe(
        Match.value(error.reason),
        Match.when("unavailable", () => pipe(Ref.set(available, false), Effect.as(NO_SUGGESTIONS))),
        Match.whenOr("failed", "invalid", () => Effect.succeed(NO_SUGGESTIONS)),
        Match.exhaustive,
      );

    const fetch = Effect.fn("Suggester.fetch")(function* (question: Question) {
      return yield* pipe(
        gm.request({
          url: buildSearchUrl(question.endpoint, question.text),
          method: "GET",
          timeoutMs: SUGGEST_TIMEOUT_MS,
        }),
        // Two deadlines, and both are needed. The manager gets `timeoutMs`,
        // and not every manager honours it. `Effect.timeoutOption` interrupts
        // the fiber, which releases the request handle. That interruption is
        // what the old `AbortController` did.
        Effect.timeoutOption(Duration.millis(SUGGEST_TIMEOUT_MS)),
        Effect.map(Option.filter(isAnswer)),
        Effect.map(Option.map(suggestionsIn)),
        Effect.catch(onRequestFailure),
      );
    });

    const remember = Effect.fnUntraced(function* (
      question: Question,
      suggestions: readonly string[],
      onResults: SuggestionSink,
    ) {
      const at = yield* Clock.currentTimeMillis;
      yield* Ref.update(cache, Record.set(question.cacheKey, { at, suggestions }));
      yield* onResults(question.text, suggestions);
    });

    /** Wait out the debounce, then ask the engine. A newer request interrupts both. */
    const lookUp = (question: Question, onResults: SuggestionSink): Effect.Effect<void> =>
      pipe(
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(SUGGEST_DEBOUNCE_MS));
          const suggestions = yield* fetch(question);
          yield* pipe(
            suggestions,
            Option.match({
              onNone: () => Effect.void,
              onSome: (found) => remember(question, found, onResults),
            }),
          );
        }),
        FiberHandle.run(inFlight),
        Effect.asVoid,
      );

    const ask = Effect.fnUntraced(function* (question: Question, onResults: SuggestionSink) {
      const now = yield* Clock.currentTimeMillis;
      const entries = yield* Ref.get(cache);
      yield* pipe(
        entries,
        Record.get(question.cacheKey),
        Option.filter(isFresh(now)),
        Option.match({
          onSome: ({ suggestions }) => onResults(question.text, suggestions),
          // An expired answer goes, and the engine is asked again.
          onNone: () =>
            pipe(
              Ref.update(cache, Record.remove(question.cacheKey)),
              Effect.andThen(lookUp(question, onResults)),
            ),
        }),
      );
    });

    const request = Effect.fn("Suggester.request")(function* (
      searchUrl: string,
      query: string,
      onResults: SuggestionSink,
    ) {
      // A new question replaces the old one, in flight or not.
      yield* FiberHandle.clear(inFlight);

      // The gate. It is a setting, and it is off by default, because every
      // keystroke here leaves the device to a third party with the cookies of
      // the user.
      const current = yield* settings.current;
      const canRequest = yield* Ref.get(available);
      yield* pipe(
        current.enableSearchSuggestions && canRequest,
        Boolean.match({
          onFalse: () => Option.none<Question>(),
          onTrue: () => questionFor(searchUrl, query),
        }),
        Option.match({
          onNone: () => Effect.void,
          onSome: (question) => ask(question, onResults),
        }),
      );
    });

    return {
      request,
      cancel: FiberHandle.clear(inFlight),
      isAvailable: Ref.get(available),
    };
  });
