/**
 * Hint-string generation.
 *
 * The properties here are the ones that a person cannot see by looking:
 * prefix freedom, uniqueness, and the even spread of the short hints that the
 * sort-then-reverse step produces.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  hintStrings,
  matchByPrefix,
  normaliseHintCharacters,
  numberToHintString,
  reverseString,
} from "~/domain/HintString.ts";

const DEFAULT_ALPHABET = "sadfjklewcmpgh";

describe("HintString", () => {
  it.effect("reverses astral characters correctly", () =>
    Effect.sync(() => {
      assert.strictEqual(reverseString("abc"), "cba");
      assert.strictEqual(reverseString(""), "");
      // A plain `split("")` breaks the surrogate pair.
      assert.strictEqual(reverseString("a😀b"), "b😀a");
    }));

  it.effect("gives exactly the number of hints that was asked for", () =>
    Effect.sync(() => {
      for (const count of [1, 2, 5, 13, 14, 15, 100, 197, 1000]) {
        assert.lengthOf(hintStrings(count, DEFAULT_ALPHABET), count);
      }
    }));

  it.effect("gives nothing for degenerate input", () =>
    Effect.sync(() => {
      assert.deepEqual(hintStrings(0, DEFAULT_ALPHABET), []);
      assert.deepEqual(hintStrings(-3, DEFAULT_ALPHABET), []);
      // An alphabet of one character has no prefix-free code.
      assert.deepEqual(hintStrings(5, "a"), []);
    }));

  it.effect("gives unique hints", () =>
    Effect.sync(() => {
      const hints = hintStrings(500, DEFAULT_ALPHABET);
      assert.strictEqual(new Set(hints).size, hints.length);
    }));

  it.effect("gives prefix-free hints", () =>
    Effect.sync(() => {
      for (const count of [3, 14, 15, 200, 421]) {
        const hints = hintStrings(count, DEFAULT_ALPHABET);
        for (const first of hints) {
          for (const second of hints) {
            if (first === second) continue;
            assert.isFalse(
              second.startsWith(first),
              `"${first}" is a prefix of "${second}" at count ${count}`,
            );
          }
        }
      }
    }));

  it.effect("uses only characters of the alphabet", () =>
    Effect.sync(() => {
      const alphabet = "abc";
      for (const hint of hintStrings(40, alphabet)) {
        for (const char of hint) {
          assert.include(alphabet, char, `unexpected character "${char}"`);
        }
      }
    }));

  it.effect("agrees with the reference algorithm", () =>
    Effect.sync(() => {
      // Computed by hand for the alphabet "ab". The frontier after two
      // expansions is ["b","aa","ba"]; sorted it is ["aa","b","ba"]; reversed
      // it is ["aa","b","ab"].
      assert.deepEqual(hintStrings(3, "ab"), ["aa", "b", "ab"]);
      assert.deepEqual(hintStrings(1, "ab"), ["a"]);
      assert.deepEqual(hintStrings(2, "ab"), ["a", "b"]);
    }));

  it.effect("spreads the short hints over the page", () =>
    Effect.sync(() => {
      // The sort and the reverse exist so that the one-character hints do not
      // all go to the first links, which are almost always the site menu.
      const hints = hintStrings(10, "abcd");
      const shortPositions = hints
        .map((hint, index) => (hint.length === 1 ? index : -1))
        .filter((index) => index >= 0);

      assert.isAbove(shortPositions.length, 0);
      assert.isAbove(
        Math.max(...shortPositions),
        shortPositions.length,
        `the short hints cluster at the front: ${shortPositions.join(",")}`,
      );
    }));

  it.effect("grows the length only as far as it must", () =>
    Effect.sync(() => {
      const alphabet = "abcd";
      assert.isTrue(
        hintStrings(4, alphabet).every((hint) => hint.length === 1),
      );
      // The fifth link forces two characters, but not for every link.
      const five = hintStrings(5, alphabet);
      assert.isTrue(five.some((hint) => hint.length === 1));
      assert.isTrue(five.some((hint) => hint.length === 2));
    }));

  it.effect("removes duplicates and whitespace from the alphabet", () =>
    Effect.sync(() => {
      assert.strictEqual(normaliseHintCharacters("aabbc", "xy"), "abc");
      assert.strictEqual(normaliseHintCharacters("a b\tc", "xy"), "abc");
      assert.strictEqual(normaliseHintCharacters("AaB", "xy"), "ab");
    }));

  it.effect("falls back when the alphabet cannot be used", () =>
    Effect.sync(() => {
      assert.strictEqual(normaliseHintCharacters("", "xy"), "xy");
      assert.strictEqual(normaliseHintCharacters("a", "xy"), "xy");
      assert.strictEqual(normaliseHintCharacters("aaa", "xy"), "xy");
    }));

  it.effect("is decimal for the default digit set", () =>
    Effect.sync(() => {
      const digits = "0123456789";
      assert.strictEqual(numberToHintString(1, digits), "1");
      assert.strictEqual(numberToHintString(9, digits), "9");
      assert.strictEqual(numberToHintString(10, digits), "10");
      assert.strictEqual(numberToHintString(147, digits), "147");
    }));

  it.effect("honours a custom digit set", () =>
    Effect.sync(() => {
      // Base three over "xyz": 1 gives "y", 3 gives "yx", 4 gives "yy".
      assert.strictEqual(numberToHintString(1, "xyz"), "y");
      assert.strictEqual(numberToHintString(3, "xyz"), "yx");
      assert.strictEqual(numberToHintString(4, "xyz"), "yy");
    }));

  it.effect("refuses degenerate input for a hint number", () =>
    Effect.sync(() => {
      assert.strictEqual(numberToHintString(0, "0123456789"), "");
      assert.strictEqual(numberToHintString(-1, "0123456789"), "");
      assert.strictEqual(numberToHintString(Number.NaN, "0123456789"), "");
      assert.strictEqual(numberToHintString(5, "a"), "");
    }));

  it.effect("gives every index for an empty prefix", () =>
    Effect.sync(() => {
      assert.deepEqual(matchByPrefix(["aa", "ab", "b"], ""), [0, 1, 2]);
    }));

  it.effect("narrows as the user types", () =>
    Effect.sync(() => {
      const hints = ["aa", "ab", "b"];
      assert.deepEqual(matchByPrefix(hints, "a"), [0, 1]);
      assert.deepEqual(matchByPrefix(hints, "ab"), [1]);
      assert.deepEqual(matchByPrefix(hints, "c"), []);
    }));
});
