/**
 * Hint-string generation.
 *
 * The properties tested here are the ones a human cannot eyeball: prefix
 * freedom (typing a hint is unambiguous), uniqueness (no two links share a
 * hint), and the even scatter of short hints that the sort-then-reverse step
 * produces. A regression in any of them looks like "hints feel a bit off"
 * rather than like a crash.
 */

import { assert, assertEquals } from "@std/assert";
import {
  hintStrings,
  matchByPrefix,
  normaliseHintCharacters,
  numberToHintString,
  reverseString,
} from "~/features/hints/hint-strings.ts";

const DEFAULT_ALPHABET = "sadfjklewcmpgh";

Deno.test("reverseString handles astral characters", () => {
  assertEquals(reverseString("abc"), "cba");
  assertEquals(reverseString(""), "");
  // Naive `split("")` would split the surrogate pair and produce mojibake.
  assertEquals(reverseString("a😀b"), "b😀a");
});

Deno.test("hintStrings returns exactly the requested count", () => {
  for (const count of [1, 2, 5, 13, 14, 15, 100, 197, 1000]) {
    assertEquals(hintStrings(count, DEFAULT_ALPHABET).length, count);
  }
});

Deno.test("hintStrings returns nothing for degenerate input", () => {
  assertEquals(hintStrings(0, DEFAULT_ALPHABET), []);
  assertEquals(hintStrings(-3, DEFAULT_ALPHABET), []);
  // A one-character alphabet cannot produce a prefix-free code at all.
  assertEquals(hintStrings(5, "a"), []);
});

Deno.test("hintStrings are unique", () => {
  const hints = hintStrings(500, DEFAULT_ALPHABET);
  assertEquals(new Set(hints).size, hints.length);
});

Deno.test("hintStrings are prefix-free", () => {
  for (const count of [3, 14, 15, 200, 421]) {
    const hints = hintStrings(count, DEFAULT_ALPHABET);
    for (const a of hints) {
      for (const b of hints) {
        if (a === b) continue;
        assert(
          !b.startsWith(a),
          `"${a}" is a prefix of "${b}" at count ${count}`,
        );
      }
    }
  }
});

Deno.test("hintStrings only use alphabet characters", () => {
  const alphabet = "abc";
  for (const hint of hintStrings(40, alphabet)) {
    for (const char of hint) {
      assert(alphabet.includes(char), `unexpected character "${char}"`);
    }
  }
});

Deno.test("hintStrings matches the reference algorithm exactly", () => {
  // Hand-computed from the plan's snippet, alphabet "ab":
  //   frontier after two expansions is ["b", "aa", "ba"];
  //   sorted -> ["aa", "b", "ba"]; reversed -> ["aa", "b", "ab"].
  assertEquals(hintStrings(3, "ab"), ["aa", "b", "ab"]);
  assertEquals(hintStrings(1, "ab"), ["a"]);
  assertEquals(hintStrings(2, "ab"), ["a", "b"]);
});

Deno.test("hintStrings scatters the short hints", () => {
  // The sort-then-reverse exists so the one-character hints are not all
  // clustered on the first links, which are almost always site chrome.
  const alphabet = "abcd";
  const hints = hintStrings(10, alphabet);
  const shortPositions = hints
    .map((hint, index) => (hint.length === 1 ? index : -1))
    .filter((index) => index >= 0);

  assert(shortPositions.length > 0, "expected some single-character hints");
  assert(
    Math.max(...shortPositions) > shortPositions.length,
    `short hints clustered at the front: ${shortPositions.join(",")}`,
  );
});

Deno.test("hintStrings grows length only as needed", () => {
  const alphabet = "abcd";
  assert(hintStrings(4, alphabet).every((hint) => hint.length === 1));
  // The fifth link forces two-character hints, but not for every link.
  const five = hintStrings(5, alphabet);
  assert(five.some((hint) => hint.length === 1));
  assert(five.some((hint) => hint.length === 2));
});

Deno.test("normaliseHintCharacters removes duplicates and whitespace", () => {
  assertEquals(normaliseHintCharacters("aabbc", "xy"), "abc");
  assertEquals(normaliseHintCharacters("a b\tc", "xy"), "abc");
  assertEquals(normaliseHintCharacters("AaB", "xy"), "ab");
});

Deno.test("normaliseHintCharacters falls back on unusable alphabets", () => {
  assertEquals(normaliseHintCharacters("", "xy"), "xy");
  assertEquals(normaliseHintCharacters("a", "xy"), "xy");
  assertEquals(normaliseHintCharacters("aaa", "xy"), "xy");
});

Deno.test("numberToHintString is decimal for the default digit set", () => {
  const digits = "0123456789";
  assertEquals(numberToHintString(1, digits), "1");
  assertEquals(numberToHintString(9, digits), "9");
  assertEquals(numberToHintString(10, digits), "10");
  assertEquals(numberToHintString(147, digits), "147");
});

Deno.test("numberToHintString honours a custom digit set", () => {
  // Base 3 over "xyz": 1 -> "y", 3 -> "yx", 4 -> "yy".
  assertEquals(numberToHintString(1, "xyz"), "y");
  assertEquals(numberToHintString(3, "xyz"), "yx");
  assertEquals(numberToHintString(4, "xyz"), "yy");
});

Deno.test("numberToHintString rejects degenerate input", () => {
  assertEquals(numberToHintString(0, "0123456789"), "");
  assertEquals(numberToHintString(-1, "0123456789"), "");
  assertEquals(numberToHintString(Number.NaN, "0123456789"), "");
  assertEquals(numberToHintString(5, "a"), "");
});

Deno.test("matchByPrefix returns every index for an empty query", () => {
  assertEquals(matchByPrefix(["aa", "ab", "b"], ""), [0, 1, 2]);
});

Deno.test("matchByPrefix narrows as characters are typed", () => {
  const hints = ["aa", "ab", "b"];
  assertEquals(matchByPrefix(hints, "a"), [0, 1]);
  assertEquals(matchByPrefix(hints, "ab"), [1]);
  assertEquals(matchByPrefix(hints, "c"), []);
});
