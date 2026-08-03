/**
 * The static safety check for a regular expression.
 *
 * The check reads the text of a pattern and never runs it. That is the whole
 * point: a measurement of a bad pattern *is* the wait that we must prevent.
 * Every test here is therefore fast by construction, and no test in this file
 * runs a pattern that backtracks. `regex-budget_test.ts` holds the tests that
 * do run one, inside a budget.
 *
 * The two tables below are the contract of the module. The first table holds
 * the patterns that a user writes, and the check must accept every one of
 * them. The second table holds the patterns whose cost grows with a power of
 * the input, and the check must refuse every one of them.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { isLinearRegex, regexSafetyError } from "~/domain/RegexSafety.ts";

/**
 * The ceiling for the two timing tests.
 *
 * These tests guard one property: the cost of the check follows the pattern,
 * and never the length of the input. A defect there costs seconds, and not
 * milliseconds, because it makes the check run the expression.
 *
 * The number is therefore high on purpose. A tight ceiling measures the load
 * of the machine, and not the code: a run beside other work gave 249 ms for
 * work that takes 12 ms on an idle machine. That failure says nothing about
 * the check, and it stops a build for no reason.
 */
const SLOW_CHECK_MS = 2_000;

/**
 * The patterns that a user writes, and that must keep working.
 *
 * The first sixteen rows are the list of the review of pull request 55. Each
 * one is safe for the same reason: the two parts that could compete accept
 * different characters. `([a-z0-9-]+\.)*` cannot take the dot that ends each
 * of its own iterations, so the division into iterations is fixed.
 *
 * The rows with a lookaround are safe for a second reason. Nothing before the
 * lookaround can vary, so the body of the lookaround runs once for each start
 * position, and its cost is added and not multiplied.
 */
const LINEAR: readonly string[] = [
  "^https?://([a-z0-9-]+\\.)*example\\.com/.*$",
  "[a-z]+(-[a-z]+)*",
  "(?:\\d{1,3}\\.){3}\\d{1,3}",
  "\\d{1,3}(,\\d{3})*",
  "(?:\\w+\\.)+\\w+",
  "(\\.\\w+)+",
  "(\\d+)(?:,(\\d+))*",
  "([A-Z][a-z]+)+",
  "(a{2})+",
  "(cat|car)+",
  "(?:ab|ac)+",
  "(?:\\r?\\n)+",
  '"(?:[^"\\\\]|\\\\.)*"',
  "^(?=.*foo)(?=.*bar)",
  "(?!.*foo)bar",
  "(?=a{2})",
  // The rows below were already in this list.
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
  "(?<year>\\d{4})-\\d{2}",
  "foo(?=bar)",
  "(?<!x)y",
  "[\\u0041-\\u005a]+",
  // The two shapes that the second table calls quadratic. They are linear at
  // one start position, and the budget of the caller holds the search.
  "a*b",
  ".*x",
  // `a` and `ab` are two lengths, so one text has one division only.
  // `/(?:a|ab)*$/` against 4000 characters costs 13 ms.
  "(?:a|ab)*$",
  // A lookaround whose body runs once for each start position. The cost of the
  // two bodies is added, and not multiplied, so both stay linear.
  "(?=[a-z]*x)y",
  "(?:(?=[a-z]*a)a){3}",
  "(?<=[a-z]{0,8})x",
  // Two lookaheads that both hold a loop, after a part of one fixed length.
  // The two bodies each run once for each start position, so the cost is the
  // cost of `[a-z]*x` twice: 1.66 ms against 1024 characters.
  "a(?=[a-z]*x)(?=[a-z]*y)b*",
];

const NESTED_FIXED_ASSERTIONS =
  "(?:(?=(?:(?=(?:(?=(?:(?=(?:(?=(?:(?=(?:(?=(?:(?=[a-z]*x)a){8})a){8})a){8})a){8})a){8})a){8})a){8})a){8}";

/**
 * The patterns that grow with a power of the input.
 *
 * Each row was measured with Node 26. The pattern is refused, so no test needs
 * to run it. The measurement stands in the reply on pull request 55.
 */
const SUPER_LINEAR: readonly string[] = [
  // Two neighbouring `+` quantifiers. This is the blocker of the review:
  // `\s+\s+\s+\s+\s+\s+$` costs 2.3 s against 50 characters.
  "\\s+\\s+\\s+\\s+\\s+\\s+$",
  "a+a+a+a+a+a+$",
  ".+.+.+.+.+.+$",
  "\\d+\\d+\\d+\\d+\\d+\\d+$",
  "[a-z]+[a-z]+[a-z]+[a-z]+[a-z]+[a-z]+$",
  "x+x+y",
  "x+x+x+y",
  "a{1,}a{1,}a{1,}a{1,}a{1,}$",
  // A quantifier inside a quantifier, where the body can grow past its end.
  "(a+)+$",
  "(a*)*b",
  "(\\d+)+$",
  "([a-zA-Z]+)*$",
  "(x+x+)+y",
  "(.*)*$",
  "(?:.*a)*b",
  // Two alternatives that match one text.
  "(a|a)*$",
  "(a|a|a|a)*$",
  "(a|aa)*b",
  // A body that matches nothing.
  "(a?){10}a{10}$",
  // Two neighbouring `*` quantifiers.
  "a*a*b",
  ".*.*x",
  "\\s*\\s*\\s*\\s*\\s*\\s*$",
  "^ *a* *a* *$",
  // More than one unbounded quantifier that competes with the text after it.
  // `/a.*b.*c/` against 4096 characters of `ab` costs 8.8 s.
  "a.*b.*c",
  ".*a.*b",
  "^https?://.*foo.*bar$",
  // A backreference.
  "(a)\\1",
  // The same shapes inside a lookaround.
  "^(?=(a+)+$)",
  // An unbounded quantifier that a lookahead hides.
  //
  // A lookahead gives back no text, so it was invisible to the rules that
  // compare neighbours. The body of the lookahead runs again for each way that
  // the text before it can match, so `.*(?=.*x)` costs a window times a
  // window. One 1024-character window of it cost 545 ms before this row.
  ".*(?=.*x)",
  "[a-z]*(?=[a-z]*x)",
  "(?=(?:(?=[a-z]*a)a)+)",
  "(?=(?:(?=[a-z]{0,9999}a)a){1,9999})",
  // A fixed repeat pays the body cost at each iteration. The old cost used
  // only the number of end positions, so a fixed count paid the body once.
  "(?:(?=[a-z]*x)a){1024}",
  "(?:(?=[a-z]*x)a){384}[a-z]+",
  NESTED_FIXED_ASSERTIONS,
];

describe("RegexSafety", () => {
  it.effect("accepts every pattern that a user writes", () =>
    Effect.sync(() => {
      for (const source of LINEAR) {
        const problem = regexSafetyError(source, "");
        assert.isTrue(
          Option.isNone(problem),
          `${source} was refused: ${Option.getOrElse(problem, () => "")}`,
        );
      }
    }));

  it.effect("refuses every pattern that grows with a power", () =>
    Effect.sync(() => {
      for (const source of SUPER_LINEAR) {
        assert.isFalse(
          isLinearRegex(source, ""),
          `${source} passed the check`,
        );
      }
    }));

  it.effect("refuses eight nested fixed loops over assertions", () =>
    Effect.sync(() => {
      assert.strictEqual(NESTED_FIXED_ASSERTIONS.length, 103);
      assert.isFalse(isLinearRegex(NESTED_FIXED_ASSERTIONS, ""));
    }));

  it.effect("gives a reason that a user can read", () =>
    Effect.sync(() => {
      assert.deepEqual(
        regexSafetyError("(a+)+$", ""),
        Option.some(
          "a quantifier whose body can grow past its own end can hang the page",
        ),
      );
      assert.deepEqual(
        regexSafetyError("\\s+\\s+\\s+$", ""),
        Option.some(
          "two quantifiers that match the same characters can hang the page",
        ),
      );
      assert.deepEqual(
        regexSafetyError("(a|a)+", ""),
        Option.some(
          "two alternatives that match the same text can hang the page",
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

  it.effect("refuses a property escape when the flags hold no `u`", () =>
    Effect.sync(() => {
      // Without the `u` flag the engine reads `\p{L}` as the four literal
      // characters `p{L}`. The old model read one character, so the model and
      // the engine did not agree. Refuse instead, and accept the escape only
      // where it means what the model says.
      assert.isFalse(isLinearRegex("\\p{L}", ""));
      assert.isFalse(isLinearRegex("\\u{41}", ""));
      assert.isTrue(isLinearRegex("\\p{L}", "u"));
      assert.isTrue(isLinearRegex("\\u{41}", "u"));

      // The reason must tell the user what to write instead. "syntax that the
      // safety check does not know" is true and useless.
      const reason = Option.getOrElse(
        regexSafetyError("\\p{L}+", ""),
        () => "",
      );
      assert.include(reason, "`u` flag");
      assert.include(reason, "[a-zA-Z]");
    }));

  it.effect("reads one character as the engine reads it", () =>
    Effect.sync(() => {
      // With the `u` flag the engine reads one code point, so `\u{1F600}+`
      // repeats one character. The model read two code units, so it saw a
      // repeat of a low surrogate, and `\u{1F600}+\u{1F600}+x` looked safe.
      // It is the shape of `x+x+y`, which the check refuses.
      assert.isFalse(isLinearRegex("\u{1F600}+\u{1F600}+x", "u"));
      assert.isTrue(isLinearRegex("\u{1F600}+x", "u"));
      assert.isTrue(isLinearRegex("[\\u{1F600}-\\u{1F64F}]+x", "u"));
    }));

  it.effect("refuses a long chain of lookarounds", () =>
    Effect.sync(() => {
      // The blunt limit, and it does not need the model to be right. Fourteen
      // lookaheads of this shape are 494 characters, which is inside the cap
      // of find, and one 1024-character window of them cost 6.3 s.
      const chain = `${"(?=(?:(?=[a-z]{0,9999}a)a){1,9999})".repeat(14)}(?!)`;
      assert.isBelow(chain.length, 512);
      assert.isFalse(isLinearRegex(chain, ""));
      assert.include(
        Option.getOrElse(
          regexSafetyError(`${"(?=a)".repeat(9)}b`, ""),
          () => "",
        ),
        "at most eight lookaheads",
      );
      assert.include(
        Option.getOrElse(
          regexSafetyError("(?=(?=(?=(?=a))))", ""),
          () => "",
        ),
        "at most three nested assertions",
      );
      // A pattern that a user writes holds a few assertions, and passes.
      assert.isTrue(isLinearRegex("^(?=.*foo)(?=.*bar)(?=.*baz)", ""));
    }));

  it.effect("refuses a pattern that is too long to read", () =>
    Effect.sync(() => {
      assert.isFalse(isLinearRegex("a".repeat(4096), ""));
      assert.isTrue(isLinearRegex("a".repeat(64), ""));
    }));

  it.effect("uses the flags", () =>
    Effect.sync(() => {
      // Without `i` the two alternatives cannot match one text, and with `i`
      // they can.
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
      assert.isBelow(elapsed, SLOW_CHECK_MS, `the check took ${elapsed}ms`);
    }));

  it.effect("decides a hostile pattern in the same time", () =>
    Effect.sync(() => {
      // 250 levels of nesting, 200 alternatives, and one long run. The check
      // walks a tree, so the cost follows the pattern and never the input.
      const hostile = [
        `${"(".repeat(250)}a${")".repeat(250)}${"b".repeat(500)}`,
        `(?:${
          Array.from({ length: 200 }, (_, index) => `a${index}`).join("|")
        })+`,
        "a".repeat(1024),
        "(a|b)*".repeat(120),
      ];
      const started = performance.now();
      for (const source of hostile) regexSafetyError(source, "i");
      const elapsed = performance.now() - started;
      assert.isBelow(elapsed, SLOW_CHECK_MS, `the check took ${elapsed}ms`);
    }));
});
