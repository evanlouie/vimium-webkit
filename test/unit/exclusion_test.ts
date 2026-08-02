/**
 * The exclusion rules for one URL.
 *
 * The page chooses the URL, so a pattern must never let the page control how
 * long a match takes. `compilePattern` gives an `Option`, and a bad pattern
 * costs the user that rule only.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  compilePattern,
  type ExclusionRule,
  isPassKey,
  makeExclusionSet,
  patternToRegExp,
} from "~/domain/Exclusion.ts";

/** Test a compiled pattern. `null` means that the pattern did not compile. */
const matches = (pattern: string, url: string): boolean | null => {
  const compiled = compilePattern(pattern);
  return Option.isNone(compiled) ? null : compiled.value(url);
};

const rules = (
  ...entries: readonly ExclusionRule[]
): readonly ExclusionRule[] => entries;

describe("Exclusion", () => {
  it.effect("uses `*` as the only wildcard and anchors both ends", () =>
    Effect.sync(() => {
      const pattern = "https://example.com/*";
      assert.strictEqual(matches(pattern, "https://example.com/a/b"), true);
      assert.strictEqual(matches(pattern, "https://example.com/"), true);
      // Anchoring matters. Without it an attacker chooses the host.
      assert.strictEqual(
        matches(pattern, "https://evil.example.com.co/"),
        false,
      );
      assert.strictEqual(matches(pattern, "http://example.com/"), false);
    }));

  it.effect("matches interior wildcards in order", () =>
    Effect.sync(() => {
      const pattern = "https://*.example.com/*/edit";
      assert.strictEqual(
        matches(pattern, "https://a.example.com/doc/edit"),
        true,
      );
      assert.strictEqual(
        matches(pattern, "https://a.example.com/edit/doc"),
        false,
      );
      assert.strictEqual(
        matches(pattern, "https://a.example.com/x/y/edit"),
        true,
      );
    }));

  it.effect("treats a pattern with no wildcard as an exact match", () =>
    Effect.sync(() => {
      const pattern = "https://example.com/only";
      assert.strictEqual(matches(pattern, "https://example.com/only"), true);
      assert.strictEqual(
        matches(pattern, "https://example.com/only/more"),
        false,
      );
    }));

  it.effect("cannot be made to backtrack by a glob", () =>
    Effect.sync(() => {
      // As a regular expression this shape is polynomial in the number of
      // wildcards. Matched greedily it is linear.
      const pattern = `https://${"a*".repeat(24)}end`;
      const hostile = `https://${"a".repeat(3000)}`;

      const started = performance.now();
      assert.strictEqual(matches(pattern, hostile), false);
      const elapsed = performance.now() - started;

      // Two orders of magnitude of slack. The point is "not seconds".
      assert.isBelow(elapsed, 200, `the glob match took ${elapsed}ms`);
    }));

  it.effect("honours a pattern that is delimited by slashes", () =>
    Effect.sync(() => {
      const pattern = "/https://(mail|inbox)\\.google\\.com/.*/";
      assert.strictEqual(matches(pattern, "https://mail.google.com/u/0"), true);
      assert.strictEqual(
        matches(pattern, "https://drive.google.com/u/0"),
        false,
      );
    }));

  it.effect("keeps a regex metacharacter literal inside a glob", () =>
    Effect.sync(() => {
      const pattern = "https://example.com/a+b";
      assert.strictEqual(matches(pattern, "https://example.com/a+b"), true);
      assert.strictEqual(matches(pattern, "https://example.com/aaab"), false);
    }));

  it.effect("drops a malformed pattern instead of failing", () =>
    Effect.sync(() => {
      assert.isTrue(Option.isNone(compilePattern("/[unclosed/")));
      assert.isTrue(Option.isNone(compilePattern("   ")));
      assert.isTrue(Option.isNone(compilePattern(`/${"a".repeat(2000)}/`)));
    }));

  it.effect("drops a raw expression that can backtrack", () =>
    Effect.sync(() => {
      // The page chooses the URL. A raw expression with this shape turns one
      // crafted URL into a frozen startup, and the 4,096-character limit on
      // the URL does not help: `(a+)+$` needs minutes against forty
      // characters. Such a rule is dropped, and the user keeps every other
      // rule.
      const bombs = [
        "/(a+)+$/",
        "/(a|a)*$/",
        "/https://(x|x)+\\.test/",
        "/.*.*x/",
        "/(\\w+\\s?)*$/",
      ];
      for (const pattern of bombs) {
        assert.isTrue(
          Option.isNone(compilePattern(pattern)),
          `${pattern} compiled`,
        );
        assert.isTrue(
          Option.isNone(patternToRegExp(pattern)),
          `${pattern} was still described`,
        );
      }
    }));

  it.effect("keeps a raw expression that matches in linear time", () =>
    Effect.sync(() => {
      // A hostile URL for each pattern, and a deadline for the whole set. A
      // pattern that survives the check must stay bounded on any input.
      const hostile = `https://${"a".repeat(3000)}!`;
      const patterns = [
        "/https://(mail|inbox)\\.google\\.com/.*/",
        "/.*/",
        "/https://[a-z]+\\.test/[0-9]*/",
        "/^https?://example\\.com/.*$/",
      ];

      const started = performance.now();
      for (const pattern of patterns) {
        const compiled = compilePattern(pattern);
        assert.isTrue(Option.isSome(compiled), `${pattern} was dropped`);
        if (Option.isNone(compiled)) continue;
        compiled.value(hostile);
      }
      const elapsed = performance.now() - started;
      assert.isBelow(elapsed, 200, `the match took ${elapsed}ms`);
    }));

  it.effect("refuses an absurdly long URL instead of scanning it", () =>
    Effect.sync(() => {
      assert.strictEqual(matches("/.*/", "https://example.com/"), true);
      assert.strictEqual(matches("/.*/", "x".repeat(5000)), false);
    }));

  it.effect("still describes what a glob means", () =>
    Effect.sync(() => {
      const pattern = patternToRegExp("https://example.com/*");
      assert.isTrue(Option.isSome(pattern));
      if (Option.isNone(pattern)) return;
      assert.isTrue(pattern.value.test("https://example.com/a"));
      assert.isFalse(pattern.value.test("https://evil.example.com.co/"));
      assert.isTrue(Option.isNone(patternToRegExp("/[unclosed/")));
      assert.isTrue(Option.isNone(patternToRegExp("   ")));
    }));

  it.effect("leaves us fully enabled when no rule matches", () =>
    Effect.sync(() => {
      const set = makeExclusionSet(
        rules({ pattern: "https://example.com/*", passKeys: "" }),
      );
      assert.deepEqual(set.match("https://other.test/"), {
        enabled: true,
        passKeys: "",
      });
    }));

  it.effect("disables us entirely when passKeys is empty", () =>
    Effect.sync(() => {
      const set = makeExclusionSet(
        rules({ pattern: "https://mail.test/*", passKeys: "" }),
      );
      assert.deepEqual(set.match("https://mail.test/inbox"), {
        enabled: false,
        passKeys: "",
      });
    }));

  it.effect("joins the pass keys of every rule that matches", () =>
    Effect.sync(() => {
      const set = makeExclusionSet(rules(
        { pattern: "https://app.test/*", passKeys: "jk" },
        { pattern: "https://app.test/editor*", passKeys: "kl" },
      ));
      const rule = set.match("https://app.test/editor/1");
      assert.isTrue(rule.enabled);
      assert.strictEqual([...rule.passKeys].sort().join(""), "jkl");
    }));

  it.effect("lets a full exclusion win over a partial one", () =>
    Effect.sync(() => {
      // This order makes "disable Vimium here" behave as the user expects.
      const set = makeExclusionSet(rules(
        { pattern: "https://app.test/*", passKeys: "jk" },
        { pattern: "https://app.test/editor*", passKeys: "" },
      ));
      assert.isFalse(set.match("https://app.test/editor/1").enabled);
    }));

  it.effect("does not count a rule whose pattern cannot compile", () =>
    Effect.sync(() => {
      const set = makeExclusionSet(rules(
        { pattern: "/[unclosed/", passKeys: "" },
        { pattern: "/(a+)+$/", passKeys: "" },
        { pattern: "https://app.test/*", passKeys: "j" },
      ));
      assert.strictEqual(set.size, 1);
      assert.strictEqual(set.match("https://app.test/x").passKeys, "j");
    }));

  it.effect("caches repeated lookups within a limit", () =>
    Effect.sync(() => {
      const set = makeExclusionSet(rules({ pattern: "*", passKeys: "j" }));
      for (let index = 0; index < 200; index++) {
        set.match(`https://spa.test/#/route/${index}`);
      }
      // A single-page application makes unlimited URLs. The set must not grow
      // without a limit, and it must still answer correctly.
      assert.strictEqual(set.match("https://spa.test/#/route/0").passKeys, "j");
    }));

  it.effect("accepts only a single character as a pass key", () =>
    Effect.sync(() => {
      const rule = { enabled: true, passKeys: "jk" };
      assert.isTrue(isPassKey(rule, "j"));
      assert.isFalse(isPassKey(rule, "l"));
      // `passKeys` is a set of characters, so `<c-j>` can never be in it.
      assert.isFalse(isPassKey(rule, "<c-j>"));
    }));
});
