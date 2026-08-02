/**
 * Find-query parsing.
 *
 * The behaviours here are the ones that a user sees when they are wrong:
 * smartcase, which queries are regular expressions, and that a bad pattern
 * reports an error while the user still types it.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  escapeRegExp,
  type FindQueryOptions,
  hasUpperCase,
  literalSource,
  parseFindQuery,
  splitRegexLiteral,
  stripDirectives,
  toRegExp,
  wordQuery,
} from "~/domain/FindQuery.ts";

const literal: FindQueryOptions = { regexFindMode: false };
const regexMode: FindQueryOptions = { regexFindMode: true };

describe("FindQuery", () => {
  it.effect("does not limit the case test to ASCII", () =>
    Effect.sync(() => {
      assert.isFalse(hasUpperCase("hello"));
      assert.isTrue(hasUpperCase("Hello"));
      assert.isTrue(hasUpperCase("ПРИВЕТ"));
      assert.isFalse(hasUpperCase("привет"));
      // A digit and a punctuation mark have no case, so smartcase stays on.
      assert.isFalse(hasUpperCase("1234-!?"));
    }));

  it.effect("makes a lower-case query case-insensitive", () =>
    Effect.sync(() => {
      const query = parseFindQuery("hello", literal);
      assert.isTrue(query.ignoreCase);
      assert.isTrue(query.smartcase);
      assert.include(query.flags, "i");
    }));

  it.effect("makes any upper-case character case-sensitive", () =>
    Effect.sync(() => {
      const query = parseFindQuery("Hello", literal);
      assert.isFalse(query.ignoreCase);
      assert.isTrue(query.smartcase);
      assert.notInclude(query.flags, "i");
    }));

  it.effect("lets an explicit directive beat smartcase", () =>
    Effect.sync(() => {
      const forced = parseFindQuery("Hello\\i", literal);
      assert.isTrue(forced.ignoreCase);
      assert.isFalse(forced.smartcase);
      assert.strictEqual(forced.pattern, "Hello");

      const pinned = parseFindQuery("hello\\I", literal);
      assert.isFalse(pinned.ignoreCase);
      assert.isFalse(pinned.smartcase);
    }));

  it.effect("removes a single escape and keeps a doubled one", () =>
    Effect.sync(() => {
      assert.deepEqual(stripDirectives("foo\\r").isRegex, Option.some(true));
      assert.deepEqual(stripDirectives("foo\\R").isRegex, Option.some(false));
      assert.strictEqual(stripDirectives("foo\\r").text, "foo");

      // A doubled backslash means "a literal backslash", so it survives.
      const doubled = stripDirectives("foo\\\\r");
      assert.strictEqual(doubled.text, "foo\\r");
      assert.isTrue(Option.isNone(doubled.isRegex));
    }));

  it.effect("takes the default kind from regexFindMode", () =>
    Effect.sync(() => {
      assert.strictEqual(parseFindQuery("a.c", literal).kind, "literal");
      assert.strictEqual(parseFindQuery("a.c", regexMode).kind, "regex");
      // The directive beats the setting, in both directions.
      assert.strictEqual(parseFindQuery("a.c\\r", literal).kind, "regex");
      assert.strictEqual(parseFindQuery("a.c\\R", regexMode).kind, "literal");
    }));

  it.effect("recognises /pattern/flags", () =>
    Effect.sync(() => {
      assert.deepEqual(
        splitRegexLiteral("/foo/"),
        Option.some({ body: "foo", flags: "" }),
      );
      assert.deepEqual(
        splitRegexLiteral("/foo/i"),
        Option.some({ body: "foo", flags: "i" }),
      );
      assert.deepEqual(
        splitRegexLiteral("/a\\/b/"),
        Option.some({ body: "a\\/b", flags: "" }),
      );

      // Not literals: no delimiter, an unknown flag, or a repeated flag.
      assert.isTrue(Option.isNone(splitRegexLiteral("foo")));
      assert.isTrue(Option.isNone(splitRegexLiteral("/foo/x")));
      assert.isTrue(Option.isNone(splitRegexLiteral("/foo/ii")));
      // A plain search that holds a slash stays a plain search.
      assert.isTrue(Option.isNone(splitRegexLiteral("and/or")));
    }));

  it.effect("treats /pattern/ as a regex even with regexFindMode off", () =>
    Effect.sync(() => {
      const query = parseFindQuery("/a.c/", literal);
      assert.strictEqual(query.kind, "regex");
      assert.strictEqual(query.source, "a.c");

      const compiled = toRegExp(query);
      assert.isTrue(Option.isSome(compiled));
      if (Option.isNone(compiled)) return;
      assert.isTrue(compiled.value.test("abc"));
    }));

  it.effect("lets /pattern/i beat smartcase", () =>
    Effect.sync(() => {
      const query = parseFindQuery("/Foo/i", literal);
      assert.isTrue(query.ignoreCase);
      assert.isFalse(query.smartcase);
      assert.strictEqual(query.flags, "gi");
    }));

  it.effect("neutralises a metacharacter", () =>
    Effect.sync(() => {
      const escaped = escapeRegExp("a.c*[x]");
      assert.isTrue(new RegExp(escaped).test("a.c*[x]"));
      assert.isFalse(new RegExp(escaped).test("abc*[x]"));
    }));

  it.effect("accepts collapsed whitespace in a literal query", () =>
    Effect.sync(() => {
      // The engine folds every whitespace character to one space and keeps the
      // length, so a run of spaces stays and the pattern must allow it.
      assert.strictEqual(literalSource("sign in"), "sign +in");
      const compiled = toRegExp(parseFindQuery("sign in", literal));
      assert.isTrue(Option.isSome(compiled));
      if (Option.isNone(compiled)) return;
      assert.isTrue(compiled.value.test("sign  in"));
      assert.notStrictEqual(literalSource("a.b c"), "a.b c");
    }));

  it.effect("treats an empty query as empty and not as an error", () =>
    Effect.sync(() => {
      const query = parseFindQuery("", literal);
      assert.isTrue(query.isEmpty);
      assert.isTrue(Option.isNone(query.error));
      assert.isTrue(Option.isNone(toRegExp(query)));

      // A query of directives alone is also empty.
      assert.isTrue(parseFindQuery("\\i", literal).isEmpty);
    }));

  it.effect("reports a malformed regex instead of throwing", () =>
    Effect.sync(() => {
      const query = parseFindQuery("/a(/", literal);
      assert.isTrue(Option.isSome(query.error));
      assert.isTrue(Option.isNone(toRegExp(query)));
    }));

  it.effect("never treats a literal query as malformed", () =>
    Effect.sync(() => {
      const query = parseFindQuery("a(", literal);
      assert.isTrue(Option.isNone(query.error));
      const compiled = toRegExp(query);
      assert.isTrue(Option.isSome(compiled));
      if (Option.isNone(compiled)) return;
      assert.isTrue(compiled.value.test("a("));
    }));

  it.effect("gives a new RegExp on every call", () =>
    Effect.sync(() => {
      // `lastIndex` is state on a `g` expression. Two searches that share one
      // expression lose matches.
      const query = parseFindQuery("a", literal);
      const first = toRegExp(query);
      const second = toRegExp(query);
      assert.isTrue(Option.isSome(first) && Option.isSome(second));
      if (Option.isNone(first) || Option.isNone(second)) return;
      assert.notStrictEqual(first.value, second.value);
      first.value.exec("aaa");
      assert.strictEqual(second.value.lastIndex, 0);
    }));

  it.effect("anchors a word query on word boundaries", () =>
    Effect.sync(() => {
      const query = wordQuery("find");
      const compiled = toRegExp(query);
      assert.isTrue(Option.isSome(compiled));
      if (Option.isNone(compiled)) return;
      assert.isTrue(compiled.value.test("please find it"));
      assert.isFalse(new RegExp(query.source, "i").test("refinance"));
    }));

  it.effect("does not anchor a token that is not a word", () =>
    Effect.sync(() => {
      const query = wordQuery("->");
      assert.notInclude(query.source, "\\b");
      const compiled = toRegExp(query);
      assert.isTrue(Option.isSome(compiled));
      if (Option.isNone(compiled)) return;
      assert.isTrue(compiled.value.test("a -> b"));
    }));

  it.effect("applies smartcase to a word query", () =>
    Effect.sync(() => {
      assert.isTrue(wordQuery("find").ignoreCase);
      assert.isFalse(wordQuery("Find").ignoreCase);
    }));

  it.effect("refuses a pattern that backtracks catastrophically", () =>
    Effect.sync(() => {
      // `(a+)+$` against a long line backtracks exponentially, and find mode
      // owns the keyboard, so the tab is lost. The pattern runs again on every
      // keystroke, so one character becomes a freeze.
      for (const source of ["(a+)+$", "(a*)*b", "(\\d+)+$", "(a|a)*$"]) {
        const query = parseFindQuery(source, regexMode);
        assert.isTrue(
          Option.isSome(query.error),
          `${source} compiled with no complaint`,
        );
        assert.isTrue(Option.isNone(toRegExp(query)));
      }
    }));

  it.effect("decides without running the pattern", () =>
    Effect.sync(() => {
      // Each of these defeated the timed probe that stood here before.
      //
      // `(a|a|a|a)*$` is the probe bomb: twenty characters of `a` take more
      // than a minute, so the probe *was* the freeze that it looked for.
      //
      // The two `\s*` patterns pass a twenty-character probe in some
      // milliseconds, and then grow with a power of the length: eighty
      // characters cost 1.5 seconds, and a paragraph costs minutes.
      //
      // The check now reads the text and never runs it, so the whole set is
      // decided in well under one frame.
      const bombs = [
        "(a|a|a|a)*$",
        "\\s*\\s*\\s*\\s*\\s*\\s*$",
        "^ *a* *a* *$",
        "(?:a|ab)*$",
        "(a?){10}a{10}$",
      ];

      const started = performance.now();
      for (const source of bombs) {
        const query = parseFindQuery(source, regexMode);
        assert.isTrue(
          Option.isSome(query.error),
          `${source} compiled with no complaint`,
        );
        assert.isTrue(Option.isNone(toRegExp(query)));
      }
      const elapsed = performance.now() - started;
      assert.isBelow(elapsed, 50, `the decision took ${elapsed}ms`);
    }));

  it.effect("still allows an ordinary quantifier", () =>
    Effect.sync(() => {
      for (
        const source of [
          "a+",
          "\\d{2,4}",
          "(?:foo|bar)+",
          "[a-z]*x",
          "colou?r",
          "^https://(mail|inbox)\\.example\\.com/.*$",
        ]
      ) {
        const query = parseFindQuery(source, regexMode);
        assert.isTrue(
          Option.isNone(query.error),
          `${source} was refused`,
        );
        assert.isTrue(Option.isSome(toRegExp(query)));
      }
    }));

  it.effect("never refuses a query that a user types as text", () =>
    Effect.sync(() => {
      // A literal query is escaped before it becomes an expression, so the
      // safety check must never take a plain search away from a user.
      for (
        const text of [
          "a+b",
          "(a*)*",
          "* * *",
          "sign   in",
          "c:\\\\windows",
          "ПРИВЕТ",
        ]
      ) {
        const query = parseFindQuery(text, literal);
        assert.isTrue(Option.isNone(query.error), `${text} was refused`);
        assert.isTrue(Option.isSome(toRegExp(query)));
      }
      assert.isTrue(Option.isNone(wordQuery("a+b").error));
    }));

  it.effect("refuses an absurdly long pattern", () =>
    Effect.sync(() => {
      const query = parseFindQuery("a".repeat(600), regexMode);
      assert.isTrue(Option.isSome(query.error));
    }));
});
