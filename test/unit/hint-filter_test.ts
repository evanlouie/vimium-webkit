/**
 * Filter-mode scoring and matching.
 *
 * Two behaviours are important. A query word that matches nothing must zero
 * the whole candidate, because filter mode is a filter and not a ranking. And
 * the hints must be numbered again on every keystroke, so the digit beside a
 * link is always the digit that selects it.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  type FilterCandidate,
  filterHints,
  type FilterQuery,
  linkWords,
  matchedPrefixLength,
  scoreLinkText,
} from "~/domain/HintFilter.ts";

const DIGITS = "0123456789";

const candidates = (
  ...texts: readonly string[]
): readonly FilterCandidate[] =>
  texts.map((linkText, index) => ({ index, linkText, secondary: false }));

const query = (text: string, digits = ""): FilterQuery => ({
  text,
  digits,
  numberCharacters: DIGITS,
});

describe("HintFilter", () => {
  it.effect("lowercases and splits the link text on whitespace", () =>
    Effect.sync(() => {
      assert.deepEqual(linkWords("  Sign   In Now\n"), ["sign", "in", "now"]);
      assert.deepEqual(linkWords(""), []);
      assert.deepEqual(linkWords("   "), []);
    }));

  it.effect("zeroes a candidate that misses one query word", () =>
    Effect.sync(() => {
      assert.strictEqual(
        scoreLinkText(["sign", "out"], linkWords("Sign in")),
        0,
      );
      assert.isAbove(scoreLinkText(["sign", "in"], linkWords("Sign in")), 0);
    }));

  it.effect("prefers a prefix over a substring", () =>
    Effect.sync(() => {
      const prefix = scoreLinkText(["sig"], linkWords("signal"));
      const substring = scoreLinkText(["igna"], linkWords("signal"));
      assert.isAbove(prefix, substring);
    }));

  it.effect("prefers shorter link text", () =>
    Effect.sync(() => {
      const short = scoreLinkText(["sign"], linkWords("Sign in"));
      const long = scoreLinkText(
        ["sign"],
        linkWords("Sign in to your account to continue reading"),
      );
      assert.isAbove(short, long);
    }));

  it.effect("scores zero with no query and with no words", () =>
    Effect.sync(() => {
      assert.strictEqual(scoreLinkText([], linkWords("Sign in")), 0);
      assert.strictEqual(scoreLinkText(["sign"], []), 0);
    }));

  it.effect("numbers every hint from 1 when the query is empty", () =>
    Effect.sync(() => {
      const outcome = filterHints(candidates("one", "two", "three"), query(""));
      assert.deepEqual(outcome.matched.map((match) => match.hintString), [
        "1",
        "2",
        "3",
      ]);
      assert.deepEqual(outcome.matched.map((match) => match.index), [0, 1, 2]);
      assert.lengthOf(outcome.candidates, 3);
      assert.isTrue(Option.isNone(outcome.exact));
    }));

  it.effect("drops a candidate that does not match", () =>
    Effect.sync(() => {
      const outcome = filterHints(
        candidates("Sign in", "Sign out", "Search"),
        query("out"),
      );
      assert.lengthOf(outcome.matched, 1);
      assert.strictEqual(outcome.matched[0]?.index, 1);
    }));

  it.effect("numbers the hints again on every keystroke", () =>
    Effect.sync(() => {
      const all = candidates("Alpha", "Beta", "Gamma");

      const before = filterHints(all, query(""));
      assert.strictEqual(
        before.matched.find((match) => match.index === 2)?.hintString,
        "3",
      );

      // Once "gam" removes Beta, Gamma becomes hint 1 and not hint 3.
      const after = filterHints(all, query("gam"));
      assert.strictEqual(
        after.matched.find((match) => match.index === 2)?.hintString,
        "1",
      );
    }));

  it.effect("sorts by score and keeps the document order on a tie", () =>
    Effect.sync(() => {
      const outcome = filterHints(
        candidates("Downloads", "Download", "Download now please"),
        query("download"),
      );
      // The exact single word is the shortest, so it scores highest.
      assert.strictEqual(outcome.matched[0]?.index, 1);
    }));

  it.effect("narrows by the digit queue", () =>
    Effect.sync(() => {
      const outcome = filterHints(
        candidates("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"),
        query("", "1"),
      );
      // "1" is a prefix of "10", "11" and "12", so it cannot activate alone.
      assert.deepEqual(
        outcome.candidates.map((match) => match.hintString),
        ["1", "10", "11", "12"],
      );
      assert.strictEqual(
        Option.getOrNull(outcome.exact)?.hintString,
        "1",
      );
    }));

  it.effect("reports an unambiguous digit selection", () =>
    Effect.sync(() => {
      const outcome = filterHints(candidates("a", "b", "c"), query("", "2"));
      assert.lengthOf(outcome.candidates, 1);
      assert.strictEqual(Option.getOrNull(outcome.exact)?.index, 1);
    }));

  it.effect("treats a single text match as exact", () =>
    Effect.sync(() => {
      const outcome = filterHints(
        candidates("Sign in", "Sign out", "Search"),
        query("sea"),
      );
      assert.lengthOf(outcome.candidates, 1);
      assert.strictEqual(Option.getOrNull(outcome.exact)?.index, 2);
    }));

  it.effect("gives nothing when the query matches nothing", () =>
    Effect.sync(() => {
      const outcome = filterHints(candidates("one", "two"), query("zzz"));
      assert.deepEqual(outcome.matched, []);
      assert.deepEqual(outcome.candidates, []);
      assert.isTrue(Option.isNone(outcome.exact));
    }));

  it.effect("combines the text queue and the digit queue", () =>
    Effect.sync(() => {
      const outcome = filterHints(
        candidates("Report A", "Report B", "Report C", "Summary"),
        query("report", "2"),
      );
      assert.lengthOf(outcome.matched, 3);
      assert.lengthOf(outcome.candidates, 1);
      assert.strictEqual(
        Option.getOrNull(outcome.exact)?.hintString,
        "2",
      );
    }));

  it.effect("dims a true prefix only", () =>
    Effect.sync(() => {
      assert.strictEqual(matchedPrefixLength("12", "1"), 1);
      assert.strictEqual(matchedPrefixLength("12", "12"), 2);
      assert.strictEqual(matchedPrefixLength("12", "3"), 0);
      assert.strictEqual(matchedPrefixLength("12", ""), 0);
    }));
});
