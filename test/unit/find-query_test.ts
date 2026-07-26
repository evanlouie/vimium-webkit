/**
 * Find-query parsing.
 *
 * The behaviours pinned here are the ones users notice being wrong: smartcase
 * (a lower-case query must match anything, an upper-case one must not), which
 * queries are regular expressions, and that a malformed pattern reports an
 * error instead of throwing while the user is still typing it.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  escapeRegExp,
  hasUpperCase,
  literalSource,
  parseFindQuery,
  splitRegexLiteral,
  stripDirectives,
  toRegExp,
  wordQuery,
} from "~/features/find/query.ts";

const literal = { regexFindMode: false };
const regexMode = { regexFindMode: true };

Deno.test("hasUpperCase is not limited to ASCII", () => {
  assert(!hasUpperCase("hello"));
  assert(hasUpperCase("Hello"));
  assert(hasUpperCase("ПРИВЕТ"));
  assert(!hasUpperCase("привет"));
  // Digits and punctuation have no case and must not defeat smartcase.
  assert(!hasUpperCase("1234-!?"));
});

Deno.test("smartcase: lower-case queries are case-insensitive", () => {
  const query = parseFindQuery("hello", literal);
  assert(query.ignoreCase);
  assert(query.smartcase);
  assert(query.flags.includes("i"));
});

Deno.test("smartcase: any upper-case character makes the query case-sensitive", () => {
  const query = parseFindQuery("Hello", literal);
  assert(!query.ignoreCase);
  assert(query.smartcase);
  assert(!query.flags.includes("i"));
});

Deno.test("smartcase is overridden by an explicit directive", () => {
  const forced = parseFindQuery("Hello\\i", literal);
  assert(forced.ignoreCase);
  assert(!forced.smartcase);
  assertEquals(forced.pattern, "Hello");

  const pinned = parseFindQuery("hello\\I", literal);
  assert(!pinned.ignoreCase);
  assert(!pinned.smartcase);
});

Deno.test("stripDirectives removes single escapes and unescapes doubled ones", () => {
  assertEquals(stripDirectives("foo\\r").isRegex, true);
  assertEquals(stripDirectives("foo\\R").isRegex, false);
  assertEquals(stripDirectives("foo\\r").text, "foo");

  // A doubled backslash means "I want a literal backslash", so it survives.
  const doubled = stripDirectives("foo\\\\r");
  assertEquals(doubled.text, "foo\\r");
  assertEquals(doubled.isRegex, null);
});

Deno.test("regexFindMode selects the default kind", () => {
  assertEquals(parseFindQuery("a.c", literal).kind, "literal");
  assertEquals(parseFindQuery("a.c", regexMode).kind, "regex");
  // ...and the directive beats the setting, in both directions.
  assertEquals(parseFindQuery("a.c\\r", literal).kind, "regex");
  assertEquals(parseFindQuery("a.c\\R", regexMode).kind, "literal");
});

Deno.test("splitRegexLiteral recognises /pattern/flags", () => {
  assertEquals(splitRegexLiteral("/foo/"), { body: "foo", flags: "" });
  assertEquals(splitRegexLiteral("/foo/i"), { body: "foo", flags: "i" });
  assertEquals(splitRegexLiteral("/a\\/b/"), { body: "a\\/b", flags: "" });

  // Not literals: no delimiters, an unknown flag, or a repeated flag.
  assertEquals(splitRegexLiteral("foo"), null);
  assertEquals(splitRegexLiteral("/foo/x"), null);
  assertEquals(splitRegexLiteral("/foo/ii"), null);
  // A plain search containing a slash stays a plain search.
  assertEquals(splitRegexLiteral("and/or"), null);
});

Deno.test("/pattern/ is a regex even when regexFindMode is off", () => {
  const query = parseFindQuery("/a.c/", literal);
  assertEquals(query.kind, "regex");
  assertEquals(query.source, "a.c");

  const compiled = toRegExp(query);
  assert(compiled !== null);
  assert(compiled.test("abc"));
});

Deno.test("/pattern/i forces case-insensitivity over smartcase", () => {
  const query = parseFindQuery("/Foo/i", literal);
  assert(query.ignoreCase);
  assert(!query.smartcase);
  assertEquals(query.flags, "gi");
});

Deno.test("escapeRegExp neutralises metacharacters", () => {
  const escaped = escapeRegExp("a.c*[x]");
  assertEquals(new RegExp(escaped).test("a.c*[x]"), true);
  assertEquals(new RegExp(escaped).test("abc*[x]"), false);
});

Deno.test("literal queries tolerate collapsed whitespace", () => {
  // The engine folds every whitespace character to U+0020 without changing
  // length, so runs of spaces survive and the pattern has to allow for them.
  assertEquals(literalSource("sign in"), "sign +in");
  const compiled = toRegExp(parseFindQuery("sign in", literal));
  assert(compiled !== null);
  assert(compiled.test("sign  in"));
  assertNotEquals(literalSource("a.b c"), "a.b c");
});

Deno.test("an empty query is empty, not an error", () => {
  const query = parseFindQuery("", literal);
  assert(query.isEmpty);
  assertEquals(query.error, null);
  assertEquals(toRegExp(query), null);

  // A query that is nothing but directives is also empty.
  assert(parseFindQuery("\\i", literal).isEmpty);
});

Deno.test("a malformed regex reports an error instead of throwing", () => {
  const query = parseFindQuery("/a(/", literal);
  assert(query.error !== null);
  assertEquals(toRegExp(query), null);
});

Deno.test("a literal query is never malformed", () => {
  const query = parseFindQuery("a(", literal);
  assertEquals(query.error, null);
  const compiled = toRegExp(query);
  assert(compiled !== null);
  assert(compiled.test("a("));
});

Deno.test("toRegExp returns a fresh regex each call", () => {
  // `lastIndex` is mutable state on a `g` regex; sharing one across searches
  // silently skips matches.
  const query = parseFindQuery("a", literal);
  const first = toRegExp(query);
  const second = toRegExp(query);
  assert(first !== null && second !== null);
  assert(first !== second);
  first.exec("aaa");
  assertEquals(second.lastIndex, 0);
});

Deno.test("wordQuery anchors on word boundaries", () => {
  const query = wordQuery("find");
  const compiled = toRegExp(query);
  assert(compiled !== null);
  assert(compiled.test("please find it"));
  assertEquals(new RegExp(query.source, "i").test("refinance"), false);
});

Deno.test("wordQuery does not anchor a non-word token", () => {
  const query = wordQuery("->");
  assertEquals(query.source.includes("\\b"), false);
  const compiled = toRegExp(query);
  assert(compiled !== null);
  assert(compiled.test("a -> b"));
});

Deno.test("wordQuery applies smartcase", () => {
  assert(wordQuery("find").ignoreCase);
  assert(!wordQuery("Find").ignoreCase);
});

Deno.test("a catastrophically backtracking pattern is refused", () => {
  // `(a+)+$` against a long line backtracks exponentially, and find mode owns
  // the keyboard — so the tab is gone with no way to abort. The pattern is
  // re-run on every keystroke, which turns one typed character into a freeze.
  //
  // Refused empirically rather than syntactically: every syntactic rule either
  // rejects patterns users legitimately want or misses ones that hang.
  for (const source of ["(a+)+$", "(a*)*b", "(\\d+)+$", "(a|a)*$"]) {
    const query = parseFindQuery(source, { regexFindMode: true });
    assert(
      query.error !== null,
      `${source} compiled without complaint`,
    );
    assertEquals(toRegExp(query), null);
  }
});

Deno.test("ordinary quantifiers are still allowed", () => {
  for (const source of ["a+", "\\d{2,4}", "(?:foo|bar)+", "[a-z]*x"]) {
    const query = parseFindQuery(source, { regexFindMode: true });
    assertEquals(query.error, null, `${source} was refused`);
    assert(toRegExp(query) !== null);
  }
});

Deno.test("an absurdly long pattern is refused", () => {
  const query = parseFindQuery("a".repeat(600), { regexFindMode: true });
  assert(query.error !== null);
});
