/**
 * The static safety check for a regular expression.
 *
 * The check reads the text of a pattern and never runs it. That is the whole
 * point: a measurement of a bad pattern *is* the hang that we must prevent.
 * Every test here is therefore fast by construction, and no test runs a
 * pattern that backtracks.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { isLinearRegex, regexSafetyError } from "~/domain/RegexSafety.ts";

/** The patterns that a user writes, and that must keep working. */
const LINEAR: readonly string[] = [
  "a+",
  "\\d{2,4}",
  "(?:foo|bar)+",
  "[a-z]*x",
  "colou?r",
  "^https://(mail|inbox)\\.google\\.com/.*$",
  "^.*$",
  "sign +in",
  "\\bfind\\b",
  "[^/]*\\.pdf",
  "a.*b.*c",
  "(?<year>\\d{4})-\\d{2}",
  "foo(?=bar)",
  "(?<!x)y",
  "[\\u0041-\\u005a]+",
  "\\p{L}",
];

/** The patterns that can freeze a tab, and their reasons. */
const SUPER_LINEAR: readonly string[] = [
  "(a+)+$",
  "(a*)*b",
  "(\\d+)+$",
  "(a|a)*$",
  "(a|a|a|a)*$",
  "(?:a|ab)*$",
  "(a?){10}a{10}$",
  "([a-zA-Z]+)*$",
  "(x+x+)+y",
  "(.*)*$",
  "a*a*b",
  ".*.*x",
  "\\s*\\s*\\s*\\s*\\s*\\s*$",
  "(a)\\1",
  "^(?=(a+)+$)",
];

describe("RegexSafety", () => {
  it.effect("accepts the shapes that match in linear time", () =>
    Effect.sync(() => {
      for (const source of LINEAR) {
        const problem = regexSafetyError(source, "");
        assert.isTrue(
          Option.isNone(problem),
          `${source} was refused: ${Option.getOrElse(problem, () => "")}`,
        );
      }
    }));

  it.effect("refuses every shape that can backtrack", () =>
    Effect.sync(() => {
      for (const source of SUPER_LINEAR) {
        assert.isFalse(
          isLinearRegex(source, ""),
          `${source} passed the check`,
        );
      }
    }));

  it.effect("gives a reason that a user can read", () =>
    Effect.sync(() => {
      const nested = regexSafetyError("(a+)+$", "");
      assert.deepEqual(
        nested,
        Option.some(
          "a quantifier inside another quantifier can hang the page",
        ),
      );
      assert.deepEqual(
        regexSafetyError("(a)\\1", ""),
        Option.some("a backreference can hang the page"),
      );
    }));

  it.effect("refuses syntax that it cannot read", () =>
    Effect.sync(() => {
      // A limit of the check, and not a fault of the user. The pattern is
      // refused, because an unread pattern cannot be called safe.
      for (const source of ["[unclosed", "(unclosed", "a)b"]) {
        assert.isFalse(isLinearRegex(source, ""), `${source} passed`);
      }
    }));

  it.effect("uses the flags", () =>
    Effect.sync(() => {
      // Without `i` the two alternatives cannot start with the same
      // character, and with `i` they can.
      assert.isTrue(isLinearRegex("(?:ab|Ab)+", ""));
      assert.isFalse(isLinearRegex("(?:ab|Ab)+", "i"));

      // `.` excludes the line terminators, so `.*\n*` competes for nothing.
      assert.isTrue(isLinearRegex(".*\\n*", ""));
      // With `s` the dot holds the line terminators too.
      assert.isFalse(isLinearRegex(".*\\n*", "s"));
    }));

  it.effect("decides in a time that a keystroke can pay", () =>
    Effect.sync(() => {
      const pattern = `${"(?:foo|bar)+[a-z]{2,4}".repeat(20)}x`;
      const started = performance.now();
      for (let round = 0; round < 20; round++) regexSafetyError(pattern, "i");
      const elapsed = performance.now() - started;
      assert.isBelow(elapsed, 200, `the check took ${elapsed}ms`);
    }));
});
