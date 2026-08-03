/**
 * The second line of defence: the budget at the time of use.
 *
 * The static check in `~/domain/RegexSafety.ts` refuses only the shapes that it
 * can prove ambiguous. It does not promise a linear match. `[a-z]*x` is linear
 * at one start position, and a search over every position is quadratic: one
 * `exec` against 40 000 characters costs about 2.3 s.
 *
 * These tests therefore run a slow pattern on purpose, and prove that the work
 * stays bounded. Each one has a hard, deterministic result — a length cap that
 * refuses to match, or a `stopped` report — and a time that is far below the
 * time of the same work with no budget.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { compilePattern, MAX_REGEX_URL_LENGTH } from "~/domain/Exclusion.ts";
import { collectSpans, SEARCH_WINDOW } from "~/features/find/Engine.ts";

/** A URL that no expression can match, and that every loop must walk. */
const hostileUrl = (length: number): string => "a".repeat(length);

const matcherFor = (pattern: string): (url: string) => boolean => {
  const compiled = compilePattern(pattern);
  assert.isTrue(Option.isSome(compiled), `${pattern} did not compile`);
  return Option.isSome(compiled) ? compiled.value : () => false;
};

describe("the exclusion budget", () => {
  it.effect("does not read a URL that is longer than the cap", () =>
    Effect.sync(() => {
      // The cap is the budget, so the test holds its value. A cap that grows
      // in silence is a budget that stopped bounding the work.
      assert.isAtMost(MAX_REGEX_URL_LENGTH, 1024);

      // The rule matches every string of lower-case letters. It still answers
      // `false` above the cap, and that is the whole point: the cost of one
      // raw expression is fixed, whatever URL the page makes.
      const matches = matcherFor("/[a-z]*/");
      assert.isTrue(matches(hostileUrl(MAX_REGEX_URL_LENGTH)));
      assert.isFalse(matches(hostileUrl(MAX_REGEX_URL_LENGTH + 1)));
    }));

  it.effect("answers a hostile URL inside a keystroke", () =>
    Effect.sync(() => {
      // An exclusion pattern is anchored at both ends, so one match starts at
      // one position only. The cap holds the cost of that one match, and it
      // holds it for a shape that the static check accepted by mistake.
      const matches = matcherFor("/[a-z]*x/");
      const started = performance.now();
      for (let round = 0; round < 20; round++) {
        assert.isFalse(matches(hostileUrl(200_000)));
      }
      const elapsed = performance.now() - started;
      assert.isBelow(elapsed, 200, `twenty URLs cost ${elapsed}ms`);
    }));

  it.effect("keeps a glob linear at the full URL length", () =>
    Effect.sync(() => {
      const matches = matcherFor(`https://${"a*".repeat(24)}end`);
      const started = performance.now();
      assert.isFalse(matches(`https://${hostileUrl(4000)}`));
      const elapsed = performance.now() - started;
      assert.isBelow(elapsed, 100, `the glob cost ${elapsed}ms`);
    }));
});

describe("the find budget", () => {
  it.effect("stops at the deadline and says so", () =>
    Effect.sync(() => {
      const haystack = `${"a".repeat(4000)}x`;
      const passed = collectSpans(
        haystack,
        /x/g,
        500,
        performance.now() - 1,
      );
      assert.deepEqual(passed.spans, []);
      assert.isTrue(passed.stopped, "the search did not report the stop");
    }));

  it.effect("bounds a slow pattern over a long page", () =>
    Effect.sync(() => {
      // 200 000 characters and a quadratic pattern. One `exec` over the whole
      // text costs about 57 s. The search reads windows of 1024 characters and
      // looks at the clock between two of them, so it stops at its budget.
      const haystack = "a".repeat(200_000);
      const started = performance.now();
      const passed = collectSpans(haystack, /[a-z]*x/g);
      const elapsed = performance.now() - started;

      assert.isTrue(passed.stopped, "the search read the whole page");
      assert.deepEqual(passed.spans, []);
      assert.isBelow(elapsed, 1000, `the search cost ${elapsed}ms`);
    }));

  it.effect("finds every match that a whole-text search finds", () =>
    Effect.sync(() => {
      // Four windows, and a match at each window edge. A window keeps the text
      // beside it, so a match that crosses an edge belongs to the window that
      // holds its first character, and to that window only.
      const filler = "b".repeat(SEARCH_WINDOW - 6);
      const haystack = `needle${filler}needle${filler}needle${filler}needle`;
      const passed = collectSpans(haystack, /needle/g);

      const wanted: number[] = [];
      for (
        let at = haystack.indexOf("needle");
        at !== -1;
        at = haystack.indexOf("needle", at + 1)
      ) {
        wanted.push(at);
      }

      assert.isFalse(passed.stopped);
      assert.deepEqual(passed.spans.map((span) => span.start), wanted);
    }));

  it.effect("keeps the meaning of `^` and `$` at a window edge", () =>
    Effect.sync(() => {
      const haystack = `head${"a".repeat(3 * SEARCH_WINDOW)}tail`;

      // `^` matches at the start of the text, and nowhere else. A window that
      // begins in the middle must not give it a second start.
      const heads = collectSpans(haystack, /^head|head/g);
      assert.deepEqual(heads.spans, [{ start: 0, end: 4 }]);

      // `$` matches at the end of the text, and not at the end of a window.
      const tails = collectSpans(haystack, /a+tail$/g);
      assert.strictEqual(tails.spans.length, 1);
      assert.strictEqual(
        tails.spans[0]?.end,
        haystack.length,
      );

      const nothing = collectSpans(haystack, /a$/g);
      assert.deepEqual(nothing.spans, []);
    }));

  it.effect("gives the spans of a search with no window", () =>
    Effect.sync(() => {
      // The reference is one `exec` loop over the whole text. The window must
      // not change which matches a search finds, or where they are.
      const naive = (text: string, pattern: RegExp): ReadonlyArray<number> => {
        const regex = new RegExp(pattern.source, pattern.flags);
        const starts: number[] = [];
        for (;;) {
          const match = regex.exec(text);
          if (match === null) break;
          if (match[0].length === 0) {
            regex.lastIndex = match.index + 1;
            if (regex.lastIndex > text.length) break;
            continue;
          }
          starts.push(match.index);
        }
        return starts;
      };

      const filler = "the quick brown fox jumps over the lazy dog. ";
      const text = `${filler.repeat(120)}needle${filler.repeat(120)}needle`;
      const patterns = [
        /needle/g,
        /\bfox\b/g,
        /qu[a-z]+/g,
        /o.e[rn]/g,
        /dog\. the/g,
      ];

      for (const pattern of patterns) {
        const passed = collectSpans(text, pattern, 5000);
        assert.isFalse(passed.stopped, `${pattern.source} stopped`);
        assert.deepEqual(
          passed.spans.map((span) => span.start),
          naive(text, pattern),
          `${pattern.source} gave other spans`,
        );
      }
    }));

  it.effect("still steps over a match of no width", () =>
    Effect.sync(() => {
      const haystack = "a".repeat(3 * SEARCH_WINDOW);
      const passed = collectSpans(haystack, /x*/g);
      assert.deepEqual(passed.spans, []);
      assert.isFalse(passed.stopped);
    }));
});
