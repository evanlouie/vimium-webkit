/**
 * The limits on a pattern at the time of use.
 *
 * The static check in `~/domain/RegexSafety.ts` refuses only the shapes that it
 * can prove ambiguous. Two more limits hold when a pattern runs: an exclusion
 * rule reads no URL that is longer than a cap, and find searches the page text
 * in windows and stops at a match that is longer than `MAX_MATCH_LENGTH`.
 */

import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, flow, Iterable, Option, pipe, String as Str } from "effect";
import { compilePattern, MAX_REGEX_URL_LENGTH } from "~/domain/Exclusion.ts";
import {
  collectSpans,
  DEFAULT_MATCH_LIMIT,
  LONGEST_SURE_MATCH,
  MAX_MATCH_LENGTH,
  SEARCH_WINDOW,
} from "~/features/find/Engine.ts";

/** A URL that no expression can match, and that every loop must walk. */
const hostileUrl = (length: number): string => "a".repeat(length);

/** The matcher of a pattern that must compile. */
const matcherFor = (pattern: string) =>
  pipe(
    compilePattern(pattern),
    Effect.fromOption(() => `${pattern} did not compile`),
  );

/** Where the spans of a search start. */
const startsOf: (spans: ReadonlyArray<{ readonly start: number }>) => ReadonlyArray<number> =
  Array.map(({ start }) => start);

describe("the exclusion budget", () => {
  it.effect("does not read a URL that is longer than the cap", () =>
    Effect.gen(function* () {
      // The cap is the budget, so the test holds its value. A cap that grows
      // in silence is a budget that stopped bounding the work.
      assert.isAtMost(MAX_REGEX_URL_LENGTH, 1024);

      // The rule matches every string of lower-case letters. It still answers
      // `false` above the cap, and that is the whole point: the cost of one
      // raw expression is fixed, whatever URL the page makes.
      const matches = yield* matcherFor("/[a-z]*/");
      assert.isTrue(matches(hostileUrl(MAX_REGEX_URL_LENGTH)));
      assert.isFalse(matches(hostileUrl(MAX_REGEX_URL_LENGTH + 1)));
    }),
  );
});

describe("the find budget", () => {
  it.effect("finds every match that a whole-text search finds", () =>
    Effect.sync(() => {
      // Four windows, and a match at each window edge. A window keeps the text
      // beside it, so a match that crosses an edge belongs to the window that
      // holds its first character, and to that window only.
      const filler = "b".repeat(SEARCH_WINDOW - 6);
      const haystack = `needle${filler}needle${filler}needle${filler}needle`;
      const passed = collectSpans(haystack, /needle/g);

      const wanted = pipe(
        Iterable.unfold(
          haystack.indexOf("needle"),
          flow(
            Option.liftPredicate((at: number) => at !== -1),
            Option.map((at) => [at, haystack.indexOf("needle", at + 1)] as const),
          ),
        ),
        Array.fromIterable,
      );

      assert.isFalse(passed.stopped);
      assert.deepEqual(startsOf(passed.spans), wanted);
    }),
  );

  it.effect("keeps the meaning of `^` and `$` at a window edge", () =>
    Effect.sync(() => {
      const haystack = `head${"a".repeat(3 * SEARCH_WINDOW)}tail`;

      // `/a+tail$/` costs the square of each window. On a loaded machine the
      // search can outlast `MATCH_BUDGET_MS`, and it then stops before the
      // window that holds the end of the text. That stop is the budget at
      // work, and not a broken `$`, so these searches have no deadline.
      const search = (pattern: RegExp) =>
        collectSpans(haystack, pattern, DEFAULT_MATCH_LIMIT, Number.POSITIVE_INFINITY);

      // `^` matches at the start of the text, and nowhere else. A window that
      // begins in the middle must not give it a second start.
      const heads = search(/^head|head/g);
      assert.deepEqual(heads.spans, [{ start: 0, end: 4 }]);

      // `$` matches at the end of the text, and not at the end of a window.
      const tails = search(/a+tail$/g);
      const ends = pipe(
        tails.spans,
        Array.map(({ end }) => end),
      );
      assert.deepStrictEqual(ends, [haystack.length]);

      const nothing = search(/a$/g);
      assert.deepEqual(nothing.spans, []);
    }),
  );

  describe("gives the spans of a search with no window", () => {
    // The reference is one `matchAll` over the whole text. It steps over a
    // match of no width, as a search does. The window must not change which
    // matches a search finds, or where they are.
    const naive = (text: string, pattern: RegExp): ReadonlyArray<number> =>
      pipe(
        text.matchAll(pattern),
        Array.fromIterable,
        Array.filter(flow(Array.head, Option.exists(Str.isNonEmpty))),
        Array.map(({ index }) => index),
      );

    const filler = "the quick brown fox jumps over the lazy dog. ";
    const text = `${filler.repeat(120)}needle${filler.repeat(120)}needle`;

    it.effect.each([/needle/g, /\bfox\b/g, /qu[a-z]+/g, /o.e[rn]/g, /dog\. the/g])(
      "%s",
      (pattern) =>
        Effect.sync(() => {
          const passed = collectSpans(text, pattern, 5000);
          assert.isFalse(passed.stopped, `${pattern.source} stopped`);
          assert.deepEqual(
            startsOf(passed.spans),
            naive(text, pattern),
            `${pattern.source} gave other spans`,
          );
        }),
    );
  });

  it.effect("still steps over a match of no width", () =>
    Effect.sync(() => {
      const haystack = "a".repeat(3 * SEARCH_WINDOW);
      const passed = collectSpans(haystack, /x*/g);
      assert.deepEqual(passed.spans, []);
      assert.isFalse(passed.stopped);
    }),
  );

  it.effect("keeps the trailing context when the first window is small", () =>
    Effect.sync(() => {
      // The first window is 32 characters. This assertion needs text after
      // that window. A short trailing context lost this match and reported no
      // stop, although a whole-text search found it.
      const haystack = `Fox${"a".repeat(100)}epsilon`;
      const passed = collectSpans(haystack, /Fox(?=.*epsilon)/g);
      assert.deepEqual(passed.spans, [{ start: 0, end: 3 }]);
      assert.isFalse(passed.stopped);
    }),
  );

  describe("gives the whole span of a long match, whatever the windows", () => {
    // Each window read 256 characters past its end. A match that started late
    // in a window and needed more text did not match in that window, and the
    // next window began after its start, so the match was lost and nothing
    // said so. The size of a window follows the clock, so the loss came and
    // went with the load of the machine. A window budget of -1 keeps every
    // window at its smallest, and no budget lets each window double up to
    // `SEARCH_WINDOW`. Either way the guarantee must hold, up to its bound.
    const WINDOWS = [
      { windows: "the smallest windows", windowBudget: -1 },
      { windows: "the largest windows", windowBudget: Number.POSITIVE_INFINITY },
    ];
    const cases = pipe(
      Array.cartesian(WINDOWS, [400, LONGEST_SURE_MATCH]),
      Array.cartesian([800, 1000, 1023, 1024, 1900, 2000, 2015]),
      Array.map(([[{ windows, windowBudget }, length], at]) => ({
        windows,
        windowBudget,
        length,
        at,
      })),
    );

    it.effect.each(cases)(
      "$length characters at $at, with $windows",
      ({ windowBudget, length, at }) =>
        Effect.sync(() => {
          const haystack = `${"a".repeat(at)}${"b".repeat(length)}${"a".repeat(4096)}`;
          const passed = collectSpans(
            haystack,
            new RegExp(`b{${length}}`, "g"),
            DEFAULT_MATCH_LIMIT,
            Number.POSITIVE_INFINITY,
            windowBudget,
          );
          assert.isFalse(passed.stopped, "the search stopped");
          assert.deepEqual(
            passed.spans,
            [{ start: at, end: at + length }],
            "the match was lost or moved",
          );
        }),
    );
  });

  it.effect("gives the whole span of a match of 4500 characters", () =>
    Effect.sync(() => {
      // `/.+/` over a long paragraph. `collectSpans` gave 4096 to 4500 here,
      // and one search over the whole text gives 0 to 4500.
      const haystack = "the quick brown fox jumps over the lazy dog. ".repeat(200).slice(0, 4500);
      // The slice grows only while its window stays inside the window budget.
      // On a loaded machine the window can overrun it, and the search then
      // stops, which is the budget at work. This search has no time budget.
      const passed = collectSpans(
        haystack,
        /.+/g,
        DEFAULT_MATCH_LIMIT,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      );
      assert.isFalse(passed.stopped);
      assert.deepEqual(passed.spans, [{ start: 0, end: 4500 }]);
    }),
  );

  it.effect("reports a stop for a match that is longer than the limit", () =>
    Effect.sync(() => {
      // The slice grows until the match ends, and it stops growing at
      // `MAX_MATCH_LENGTH`. A match that is still not complete there is not
      // reported at all, and the search says that it stopped.
      const haystack = "z".repeat(MAX_MATCH_LENGTH * 2);
      const passed = collectSpans(haystack, /.+/g);
      assert.isTrue(passed.stopped, "the search reported no stop");
      assert.deepEqual(passed.spans, []);
    }),
  );
});
