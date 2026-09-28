/**
 * The exclusion rules for one URL.
 *
 * The page chooses the URL, so a pattern must never let the page control how
 * long a match takes. `compilePattern` gives an `Option`, and a bad pattern
 * costs the user that rule only.
 */

import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Option, String as Str, pipe } from "effect";
import {
  compilePattern,
  EffectiveRule,
  exclusionProblems,
  type ExclusionRule,
  isPassKey,
  makeExclusionSet,
  parseExclusionLines,
  patternProblem,
  patternToRegExp,
} from "~/domain/Exclusion.ts";
import { parseExclusionText } from "~/ui/Dialog.ts";

/** Test a compiled pattern. `null` means that the pattern did not compile. */
const matches = (pattern: string, url: string): boolean | null =>
  pipe(
    compilePattern(pattern),
    Option.map((matcher) => matcher(url)),
    Option.getOrNull,
  );

/** Test the regular expression that describes a pattern. `None` when there is none. */
const described = (pattern: string, url: string): Option.Option<boolean> =>
  pipe(
    patternToRegExp(pattern),
    Option.map((regexp) => regexp.test(url)),
  );

const rules = (...entries: readonly ExclusionRule[]): readonly ExclusionRule[] => entries;

/** A verdict that keeps us on, and gives the page `passKeys`. */
const passing = (passKeys: string): EffectiveRule => EffectiveRule.cases.Enabled.make({ passKeys });

/**
 * Raw expressions that can backtrack.
 *
 * The page chooses the URL. A raw expression with this shape turns one crafted
 * URL into a startup that does not end. A limit on the length of the URL does
 * not help on its own: `(a+)+$` needs minutes against forty characters. Such a
 * rule is dropped, and the user keeps every other rule.
 */
const BACKTRACKING: ReadonlyArray<string> = [
  "/(a+)+$/",
  "/(a|a)*$/",
  "/https://(x|x)+\\.test/",
  "/.*.*x/",
  "/(\\w+\\s?)*$/",
];

/**
 * Rules that a user writes, each with a URL that it matches.
 *
 * Every row of this table was refused by the first version of the safety
 * check, and every row is safe. The canonical subdomain rule is the first one:
 * the inner loop cannot take the dot that ends each iteration, so the division
 * into iterations is fixed.
 */
const WANTED: ReadonlyArray<readonly [string, string]> = [
  ["/^https?://([a-z0-9-]+\\.)*example\\.com/.*$/", "https://a.b.example.com/x"],
  ["/https://(?:\\w+\\.)+test/.*/", "https://a.b.test/x"],
  ["/https://\\d{1,3}(\\.\\d{1,3}){3}/.*/", "https://10.0.0.1/x"],
  ["/https://[a-z]+(-[a-z]+)*\\.test/.*/", "https://a-b-c.test/x"],
];

describe("Exclusion", () => {
  it.effect("uses `*` as the only wildcard and anchors both ends", () =>
    Effect.sync(() => {
      const pattern = "https://example.com/*";
      assert.strictEqual(matches(pattern, "https://example.com/a/b"), true);
      assert.strictEqual(matches(pattern, "https://example.com/"), true);
      // Anchoring matters. Without it an attacker chooses the host.
      assert.strictEqual(matches(pattern, "https://evil.example.com.co/"), false);
      assert.strictEqual(matches(pattern, "http://example.com/"), false);
    }),
  );

  it.effect("matches interior wildcards in order", () =>
    Effect.sync(() => {
      const pattern = "https://*.example.com/*/edit";
      assert.strictEqual(matches(pattern, "https://a.example.com/doc/edit"), true);
      assert.strictEqual(matches(pattern, "https://a.example.com/edit/doc"), false);
      assert.strictEqual(matches(pattern, "https://a.example.com/x/y/edit"), true);
    }),
  );

  it.effect("treats a pattern with no wildcard as an exact match", () =>
    Effect.sync(() => {
      const pattern = "https://example.com/only";
      assert.strictEqual(matches(pattern, "https://example.com/only"), true);
      assert.strictEqual(matches(pattern, "https://example.com/only/more"), false);
    }),
  );

  it.effect("honours a pattern that is delimited by slashes", () =>
    Effect.sync(() => {
      const pattern = "/https://(mail|inbox)\\.google\\.com/.*/";
      assert.strictEqual(matches(pattern, "https://mail.google.com/u/0"), true);
      assert.strictEqual(matches(pattern, "https://drive.google.com/u/0"), false);
    }),
  );

  it.effect("keeps a regex metacharacter literal inside a glob", () =>
    Effect.sync(() => {
      const pattern = "https://example.com/a+b";
      assert.strictEqual(matches(pattern, "https://example.com/a+b"), true);
      assert.strictEqual(matches(pattern, "https://example.com/aaab"), false);
    }),
  );

  it.effect("drops a malformed pattern instead of failing", () =>
    Effect.sync(() => {
      assert.isTrue(Option.isNone(compilePattern("/[unclosed/")));
      assert.isTrue(Option.isNone(compilePattern("   ")));
      assert.isTrue(Option.isNone(compilePattern(`/${"a".repeat(2000)}/`)));
    }),
  );

  it.effect.each(BACKTRACKING)("drops a raw expression that can backtrack: %s", (pattern) =>
    Effect.sync(() => {
      assert.isTrue(Option.isNone(compilePattern(pattern)), `${pattern} compiled`);
      assert.isTrue(Option.isNone(patternToRegExp(pattern)), `${pattern} was still described`);
    }),
  );

  it.effect("refuses an absurdly long URL instead of scanning it", () =>
    Effect.sync(() => {
      assert.strictEqual(matches("/.*/", "https://example.com/"), true);
      assert.strictEqual(matches("/.*/", "x".repeat(5000)), false);
    }),
  );

  it.effect.each(WANTED)("keeps the rules that a user writes: %s", ([pattern, url]) =>
    Effect.sync(() => {
      const problem = patternProblem(pattern);
      assert.isTrue(
        Option.isNone(problem),
        `${pattern} was dropped: ${pipe(
          problem,
          Option.getOrElse(() => ""),
        )}`,
      );
      assert.strictEqual(matches(pattern, url), true, pattern);
    }),
  );

  it.effect("says why it dropped a rule", () =>
    Effect.sync(() => {
      // A dropped rule stops protecting the page. The user must learn that
      // from the log, from the HUD and from the settings dialog, so the reason
      // has to leave this module.
      const reason = patternProblem("/(a+)+$/");
      assert.deepEqual(
        reason,
        Option.some("a quantifier whose body can grow past its own end can hang the page"),
      );
      assert.isTrue(Option.isSome(patternProblem("   ")));
      assert.isTrue(Option.isSome(patternProblem("/[unclosed/")));
      assert.isTrue(Option.isNone(patternProblem("https://example.com/*")));
    }),
  );

  it.effect("lists every rule that it dropped", () =>
    Effect.sync(() => {
      const set = makeExclusionSet(
        rules(
          { pattern: "https://good.test/*", passKeys: "" },
          { pattern: "/(a+)+$/", passKeys: "" },
          { pattern: "/[unclosed/", passKeys: "" },
        ),
      );

      const patterns = pipe(
        set.dropped,
        Array.map((rule) => rule.pattern),
      );
      assert.strictEqual(set.size, 1);
      assert.deepEqual(patterns, ["/(a+)+$/", "/[unclosed/"]);
      pipe(
        set.dropped,
        Array.forEach((rule) => {
          assert.isAbove(rule.reason.length, 0, `${rule.pattern} gave no reason`);
        }),
      );
    }),
  );

  it.effect("marks the line of every rule that is dropped", () =>
    Effect.sync(() => {
      // A rule that gives no matcher is dropped, and the page then stops being
      // excluded. Before this list the drop was silent, and a user saw an
      // active script on a site that they had turned off.
      const text = pipe(
        ["# a comment", "https://example.com/*", "/(a+)+$/ jk", "", "/[unclosed/"],
        Array.join("\n"),
      );

      const problems = exclusionProblems(text);
      const first = pipe(
        problems,
        Array.head,
        Option.getOrElse(() => ""),
      );
      const second = pipe(
        problems,
        Array.get(1),
        Option.getOrElse(() => ""),
      );
      assert.strictEqual(problems.length, 2);
      assert.include(first, "line 3");
      assert.include(first, "/(a+)+$/");
      assert.include(first, "can hang the page");
      assert.include(second, "line 5");
    }),
  );

  it.effect("says nothing about the rules that a user writes", () =>
    Effect.sync(() => {
      const text = pipe(
        [
          "https://example.com/*",
          "https://*.example.com/*  jk",
          "/^https?://([a-z0-9-]+\\.)*example\\.com/.*$/",
          "**",
        ],
        Array.join("\n"),
      );

      assert.deepEqual(exclusionProblems(text), []);
    }),
  );

  it.effect("reads the settings text as the settings dialog reads it", () =>
    Effect.sync(() => {
      // Two readers of one text can drift apart, and a marked line would then
      // not be the dropped rule. This test holds the two together.
      const texts = [
        "https://example.com/*",
        "# a comment\n\nhttps://a.test/*  jk\n  /(a+)+$/   x y  \n",
        "  \n#\nhttps://b.test/*\n\t/x*/\tjk\n",
      ];
      pipe(
        texts,
        Array.forEach((text) => {
          const numbered = pipe(
            parseExclusionLines(text),
            Array.map((entry) => entry.rule),
          );
          assert.deepEqual(
            numbered,
            parseExclusionText(text),
            `the two readers disagree about ${JSON.stringify(text)}`,
          );
        }),
      );
    }),
  );

  it.effect("describes a glob that holds two wildcards side by side", () =>
    Effect.sync(() => {
      // `**` becomes `^.*.*$` when it is translated one wildcard at a time,
      // and the safety check refuses that shape. A glob never backtracks, so
      // the check belongs to the raw form only, and a run of `*` collapses.
      pipe(
        ["**", "https://example.com/**", "a**b"],
        Array.forEach((glob) => {
          assert.isTrue(Option.isSome(compilePattern(glob)), `${glob} gave no matcher`);
          assert.isTrue(Option.isSome(patternToRegExp(glob)), `${glob} was not described`);
        }),
      );

      assert.deepEqual(
        described("https://example.com/**", "https://example.com/a/b"),
        Option.some(true),
      );
      assert.deepEqual(
        described("https://example.com/**", "https://evil.test/"),
        Option.some(false),
      );
    }),
  );

  it.effect("still describes what a glob means", () =>
    Effect.sync(() => {
      assert.isTrue(Option.isSome(patternToRegExp("https://example.com/*")));
      assert.deepEqual(
        described("https://example.com/*", "https://example.com/a"),
        Option.some(true),
      );
      assert.deepEqual(
        described("https://example.com/*", "https://evil.example.com.co/"),
        Option.some(false),
      );
      assert.isTrue(Option.isNone(patternToRegExp("/[unclosed/")));
      assert.isTrue(Option.isNone(patternToRegExp("   ")));
    }),
  );

  it.effect("leaves us fully enabled when no rule matches", () =>
    Effect.sync(() => {
      const set = makeExclusionSet(rules({ pattern: "https://example.com/*", passKeys: "" }));
      assert.deepEqual(set.match("https://other.test/"), passing(""));
    }),
  );

  it.effect("disables us entirely when passKeys is empty", () =>
    Effect.sync(() => {
      const set = makeExclusionSet(rules({ pattern: "https://mail.test/*", passKeys: "" }));
      assert.deepEqual(set.match("https://mail.test/inbox"), EffectiveRule.cases.Disabled.make({}));
    }),
  );

  it.effect("joins the pass keys of every rule that matches", () =>
    Effect.sync(() => {
      const set = makeExclusionSet(
        rules(
          { pattern: "https://app.test/*", passKeys: "jk" },
          { pattern: "https://app.test/editor*", passKeys: "kl" },
        ),
      );
      const passKeys = pipe(
        set.match("https://app.test/editor/1"),
        Option.liftPredicate(EffectiveRule.guards.Enabled),
        Option.map(({ passKeys }) =>
          pipe(passKeys, Array.fromIterable, Array.sort(Str.Order), Array.join("")),
        ),
      );
      assert.deepEqual(passKeys, Option.some("jkl"));
    }),
  );

  it.effect("lets a full exclusion win over a partial one", () =>
    Effect.sync(() => {
      // This order makes "disable Vimium here" behave as the user expects.
      const set = makeExclusionSet(
        rules(
          { pattern: "https://app.test/*", passKeys: "jk" },
          { pattern: "https://app.test/editor*", passKeys: "" },
        ),
      );
      assert.isTrue(EffectiveRule.guards.Disabled(set.match("https://app.test/editor/1")));
    }),
  );

  it.effect("does not count a rule whose pattern cannot compile", () =>
    Effect.sync(() => {
      const set = makeExclusionSet(
        rules(
          { pattern: "/[unclosed/", passKeys: "" },
          { pattern: "/(a+)+$/", passKeys: "" },
          { pattern: "https://app.test/*", passKeys: "j" },
        ),
      );
      assert.strictEqual(set.size, 1);
      assert.deepEqual(set.match("https://app.test/x"), passing("j"));
    }),
  );

  it.effect("caches repeated lookups within a limit", () =>
    Effect.sync(() => {
      const set = makeExclusionSet(rules({ pattern: "*", passKeys: "j" }));
      pipe(
        Array.range(0, 199),
        Array.forEach((index) => {
          set.match(`https://spa.test/#/route/${index}`);
        }),
      );
      // A single-page application makes unlimited URLs. The set must not grow
      // without a limit, and it must still answer correctly.
      assert.deepEqual(set.match("https://spa.test/#/route/0"), passing("j"));
    }),
  );

  it.effect("accepts only a single character as a pass key", () =>
    Effect.sync(() => {
      const rule = passing("jk");
      assert.isTrue(isPassKey(rule, "j"));
      assert.isFalse(isPassKey(rule, "l"));
      // `passKeys` is a set of characters, so `<c-j>` can never be in it.
      assert.isFalse(isPassKey(rule, "<c-j>"));
    }),
  );
});
