/**
 * The second limit on a pattern: the budget at the time of use.
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
import {
  collectSpans,
  MAX_MATCH_LENGTH,
  SEARCH_WINDOW,
} from "~/features/find/Engine.ts";

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

  it.effect("keeps the trailing context when the first window is small", () =>
    Effect.sync(() => {
      // The first window is 32 characters. This assertion needs text after
      // that window. A short trailing context lost this match and reported no
      // stop, although a whole-text search found it.
      const haystack = `Fox${"a".repeat(100)}epsilon`;
      const passed = collectSpans(haystack, /Fox(?=.*epsilon)/g);
      assert.deepEqual(passed.spans, [{ start: 0, end: 3 }]);
      assert.isFalse(passed.stopped);
    }));

  it.effect("halves the window after an overrun", () =>
    Effect.sync(() => {
      // The prefix is cheap, so the window grows to 1024 characters. The next
      // text is costly at that size. Halving the window keeps the full walk
      // below the limit, while the same large windows take more than 800 ms.
      const unit = "a".repeat(8);
      const repeated = `(?:${unit})+`.repeat(4);
      const pattern = new RegExp(`(?=${repeated}x)`, "y");
      const haystack = `${"b".repeat(2016)}${"a".repeat(8000)}`;
      const started = performance.now();
      const passed = collectSpans(
        haystack,
        pattern,
        500,
        Number.POSITIVE_INFINITY,
      );
      const elapsed = performance.now() - started;

      assert.deepEqual(passed.spans, []);
      assert.isFalse(passed.stopped, "the search did not read the full text");
      assert.isBelow(elapsed, 600, `the search cost ${elapsed}ms`);
    }));

  it.effect("stops slice growth when one window passes its budget", () =>
    Effect.sync(() => {
      // The first match reaches each slice end. The failed alternative becomes
      // costly after the slice grows. The growth guard must stop before the
      // next growth step makes one `exec` cost seconds.
      const unit = "a".repeat(12);
      const repeated = `(?:${unit})+`.repeat(4);
      const pattern = new RegExp(`(?:(?=${repeated}x)|a+)`, "y");
      const started = performance.now();
      const passed = collectSpans(
        "a".repeat(20_000),
        pattern,
        500,
        started + 500,
      );
      const elapsed = performance.now() - started;

      assert.deepEqual(passed.spans, []);
      assert.isTrue(passed.stopped, "the growth did not report the stop");
      assert.isBelow(elapsed, 500, `the growth cost ${elapsed}ms`);
    }));

  it.effect("gives the whole span of a match of 400 characters", () =>
    Effect.sync(() => {
      // The window kept 256 characters of text on each side, and a match that
      // reached the end of that text was dropped. The next window began after
      // it, so the match was lost or moved, and nothing said so. A wrong span
      // is worse than a stop.
      const length = 400;
      for (const at of [800, 1000, 1023, 1024]) {
        const haystack = `${"a".repeat(at)}${"b".repeat(length)}${
          "a".repeat(4096)
        }`;
        const passed = collectSpans(haystack, new RegExp(`b{${length}}`, "g"));
        assert.isFalse(passed.stopped, `the search at ${at} stopped`);
        assert.deepEqual(
          passed.spans,
          [{ start: at, end: at + length }],
          `the match at ${at} moved`,
        );
      }
    }));

  it.effect("gives the whole span of a match of 4500 characters", () =>
    Effect.sync(() => {
      // `/.+/` over a long paragraph. `collectSpans` gave 4096 to 4500 here,
      // and one search over the whole text gives 0 to 4500.
      const haystack = "the quick brown fox jumps over the lazy dog. "
        .repeat(200)
        .slice(0, 4500);
      const passed = collectSpans(haystack, /.+/g);
      assert.isFalse(passed.stopped);
      assert.deepEqual(passed.spans, [{ start: 0, end: 4500 }]);
    }));

  it.effect("reports a stop for a match that is longer than the limit", () =>
    Effect.sync(() => {
      // The slice grows until the match ends, and it stops growing at
      // `MAX_MATCH_LENGTH`. A match that is still not complete there is not
      // reported at all, and the search says that it stopped.
      const haystack = "z".repeat(MAX_MATCH_LENGTH * 2);
      const passed = collectSpans(haystack, /.+/g);
      assert.isTrue(passed.stopped, "the search reported no stop");
      assert.deepEqual(passed.spans, []);
    }));

  it.effect("bounds one window, and not only the whole walk", () =>
    Effect.sync(() => {
      // The deadline is read between two windows, so one window is the time
      // that a keystroke cannot give back. The window starts at 32 characters
      // and grows only while each window stays cheap, so a slow pattern never
      // reaches a window that costs seconds.
      //
      // This pattern is the blocker of the second review of pull request 55.
      // The check refuses it now, and this test proves the second limit: one
      // 1024-character window of it costs 545 ms, and the whole walk over
      // 200 000 characters costs less than that.
      const haystack = "a".repeat(200_000);
      const started = performance.now();
      const passed = collectSpans(haystack, /.*(?=.*x)/g);
      const elapsed = performance.now() - started;

      assert.isTrue(passed.stopped, "the search read the whole page");
      assert.isBelow(elapsed, 300, `the search cost ${elapsed}ms`);
    }));
});
