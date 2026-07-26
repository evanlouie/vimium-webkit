/**
 * Filter-mode scoring and matching.
 *
 * The two behaviours worth pinning down: a query word that matches nothing must
 * zero the whole candidate (filter mode is a filter, not a ranking), and hints
 * must be renumbered on every keystroke so the digit shown beside a link is
 * always the digit that selects it.
 */

import { assert, assertEquals } from "@std/assert";
import {
  type FilterCandidate,
  filterHints,
  linkWords,
  matchedPrefixLength,
  scoreLinkText,
} from "~/features/hints/filter.ts";

const DIGITS = "0123456789";

const candidates = (...texts: readonly string[]): readonly FilterCandidate[] =>
  texts.map((linkText, index) => ({ index, linkText, secondary: false }));

const query = (text: string, digits = ""): {
  text: string;
  digits: string;
  numberCharacters: string;
} => ({ text, digits, numberCharacters: DIGITS });

Deno.test("linkWords lowercases and splits on whitespace", () => {
  assertEquals(linkWords("  Sign   In Now\n"), ["sign", "in", "now"]);
  assertEquals(linkWords(""), []);
  assertEquals(linkWords("   "), []);
});

Deno.test("scoreLinkText zeroes a candidate missing any query word", () => {
  assertEquals(scoreLinkText(["sign", "out"], linkWords("Sign in")), 0);
  assert(scoreLinkText(["sign", "in"], linkWords("Sign in")) > 0);
});

Deno.test("scoreLinkText prefers prefix over substring", () => {
  const prefix = scoreLinkText(["sig"], linkWords("signal"));
  const substring = scoreLinkText(["igna"], linkWords("signal"));
  assert(
    prefix > substring,
    `prefix ${prefix} should beat substring ${substring}`,
  );
});

Deno.test("scoreLinkText prefers shorter link text", () => {
  const short = scoreLinkText(["sign"], linkWords("Sign in"));
  const long = scoreLinkText(
    ["sign"],
    linkWords("Sign in to your account to continue reading"),
  );
  assert(short > long, `short ${short} should beat long ${long}`);
});

Deno.test("scoreLinkText is zero without a query or without words", () => {
  assertEquals(scoreLinkText([], linkWords("Sign in")), 0);
  assertEquals(scoreLinkText(["sign"], []), 0);
});

Deno.test("filterHints numbers every hint from 1 when the query is empty", () => {
  const outcome = filterHints(candidates("one", "two", "three"), query(""));
  assertEquals(outcome.matched.map((match) => match.hintString), [
    "1",
    "2",
    "3",
  ]);
  assertEquals(outcome.matched.map((match) => match.index), [0, 1, 2]);
  assertEquals(outcome.candidates.length, 3);
  assertEquals(outcome.exact, null);
});

Deno.test("filterHints drops non-matching candidates", () => {
  const outcome = filterHints(
    candidates("Sign in", "Sign out", "Search"),
    query("out"),
  );
  assertEquals(outcome.matched.length, 1);
  assertEquals(outcome.matched[0]?.index, 1);
});

Deno.test("filterHints renumbers on every keystroke", () => {
  const all = candidates("Alpha", "Beta", "Gamma");

  const before = filterHints(all, query(""));
  assertEquals(
    before.matched.find((match) => match.index === 2)?.hintString,
    "3",
  );

  // Once "a" filters out "Beta", Gamma becomes hint 2 — not still hint 3.
  const after = filterHints(all, query("gam"));
  assertEquals(
    after.matched.find((match) => match.index === 2)?.hintString,
    "1",
  );
});

Deno.test("filterHints sorts by score, keeping document order on ties", () => {
  const outcome = filterHints(
    candidates("Downloads", "Download", "Download now please"),
    query("download"),
  );
  // The exact single-word match is shortest and therefore scores highest.
  assertEquals(outcome.matched[0]?.index, 1);
});

Deno.test("filterHints narrows by the digit queue", () => {
  const outcome = filterHints(
    candidates("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"),
    query("", "1"),
  );
  // "1" is a prefix of "10", "11" and "12", so it cannot activate on its own.
  assertEquals(
    outcome.candidates.map((match) => match.hintString),
    ["1", "10", "11", "12"],
  );
  assertEquals(outcome.exact?.hintString, "1");
});

Deno.test("filterHints reports an unambiguous digit selection", () => {
  const outcome = filterHints(candidates("a", "b", "c"), query("", "2"));
  assertEquals(outcome.candidates.length, 1);
  assertEquals(outcome.exact?.index, 1);
});

Deno.test("filterHints treats a lone text match as exact", () => {
  const outcome = filterHints(
    candidates("Sign in", "Sign out", "Search"),
    query("sea"),
  );
  assertEquals(outcome.candidates.length, 1);
  assertEquals(outcome.exact?.index, 2);
});

Deno.test("filterHints yields nothing when the query matches nothing", () => {
  const outcome = filterHints(candidates("one", "two"), query("zzz"));
  assertEquals(outcome.matched, []);
  assertEquals(outcome.candidates, []);
  assertEquals(outcome.exact, null);
});

Deno.test("filterHints combines the text and digit queues", () => {
  const outcome = filterHints(
    candidates("Report A", "Report B", "Report C", "Summary"),
    query("report", "2"),
  );
  assertEquals(outcome.matched.length, 3);
  assertEquals(outcome.candidates.length, 1);
  assertEquals(outcome.exact?.hintString, "2");
});

Deno.test("matchedPrefixLength dims only a real prefix", () => {
  assertEquals(matchedPrefixLength("12", "1"), 1);
  assertEquals(matchedPrefixLength("12", "12"), 2);
  assertEquals(matchedPrefixLength("12", "3"), 0);
  assertEquals(matchedPrefixLength("12", ""), 0);
});
