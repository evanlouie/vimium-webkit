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
  hintCharacterCount,
  hintCharacterKey,
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

  /**
   * Characters that a case fold expands or joins.
   *
   * Each row gives an alphabet from the user and the alphabet that the hints
   * use. A dropped character either grows to two code points in one of the
   * two cases, or it has the same case fold as an earlier character.
   */
  const FOLD_CASES: readonly {
    readonly name: string;
    readonly input: string;
    readonly expected: string;
  }[] = [
    {
      name: "the Turkish dotted capital I expands to i plus a dot",
      input: "ab\u0130c",
      expected: "abc",
    },
    {
      name: "the Turkish dotted capital I repeats a Latin i",
      input: "abi\u0130",
      expected: "abi",
    },
    {
      name: "the Turkish dotless i has the case fold of the Latin i",
      input: "abi\u0131",
      expected: "abi",
    },
    {
      name: "the German sharp s expands to SS",
      input: "ab\u00df",
      expected: "ab",
    },
    {
      name: "the German capital sharp s expands to SS",
      input: "ab\u1e9e",
      expected: "ab",
    },
    {
      name: "the Greek final sigma has the case fold of the sigma",
      input: "\u03b1\u03b2\u03c3\u03c2",
      expected: "\u03b1\u03b2\u03c3",
    },
    {
      name: "the fi ligature expands to FI",
      input: "ab\ufb01",
      expected: "ab",
    },
    {
      name: "an emoji is one character",
      input: "\u{1f600}\u{1f601}",
      expected: "\u{1f600}\u{1f601}",
    },
    {
      name: "a mathematical letter is one character",
      input: "\u{1d41a}\u{1d41b}",
      expected: "\u{1d41a}\u{1d41b}",
    },
    {
      name: "a Greek capital folds onto its own small letter",
      input: "\u0391\u03b1b",
      expected: "\u03b1b",
    },
  ];

  for (const row of FOLD_CASES) {
    it.effect(`folds the alphabet: ${row.name}`, () =>
      Effect.sync(() => {
        assert.strictEqual(
          normaliseHintCharacters(row.input, "xy"),
          row.expected,
        );
      }));
  }

  it.effect("gives distinct labels for an alphabet that folds", () =>
    Effect.sync(() => {
      // Every character that survives the fold must be one code point, so no
      // two links can show the same label.
      for (const input of FOLD_CASES.map((row) => row.input)) {
        const alphabet = normaliseHintCharacters(input, "xy");
        // The split into code points is intentional.
        const chars = [...alphabet];
        assert.strictEqual(
          new Set(chars).size,
          chars.length,
          `the alphabet of "${input}" has a duplicate character`,
        );
        const hints = hintStrings(60, alphabet);
        assert.strictEqual(
          new Set(hints).size,
          hints.length,
          `the alphabet of "${input}" gives two equal labels`,
        );
        for (const hint of hints) {
          for (const char of hint) assert.include(alphabet, char);
        }
      }
    }));

  it.effect("falls back when the alphabet cannot be used", () =>
    Effect.sync(() => {
      assert.strictEqual(normaliseHintCharacters("", "xy"), "xy");
      assert.strictEqual(normaliseHintCharacters("a", "xy"), "xy");
      assert.strictEqual(normaliseHintCharacters("aaa", "xy"), "xy");
      // Two characters that fold together leave one character behind.
      assert.strictEqual(normaliseHintCharacters("i\u0131", "xy"), "xy");
      assert.strictEqual(normaliseHintCharacters("\u00df\u1e9e", "xy"), "xy");
    }));

  it.effect("gives one matching key to characters that fold together", () =>
    Effect.sync(() => {
      assert.strictEqual(normaliseHintCharacters("ab\u0130", "xy"), "ab");
      assert.strictEqual(normaliseHintCharacters("ab\u00df", "xy"), "ab");
      assert.strictEqual(normaliseHintCharacters("a b", "xy"), "ab");
      // The fold joins the pair, so the identity is one value.
      assert.strictEqual(
        hintCharacterKey("\u03c2"),
        hintCharacterKey("\u03c3"),
      );
      assert.strictEqual(hintCharacterKey("\u0131"), hintCharacterKey("I"));
    }));

  it.effect("refuses half of an astral character", () =>
    Effect.sync(() => {
      // A value that was cut at a UTF-16 boundary carries such a half.
      assert.strictEqual(normaliseHintCharacters("ab\ud800", "xy"), "ab");
      assert.strictEqual(normaliseHintCharacters("ab\udfff", "xy"), "ab");
      assert.strictEqual(normaliseHintCharacters("ab\ud83d", "xy"), "ab");
      // A whole astral character is one hint character.
      assert.strictEqual(
        normaliseHintCharacters("ab\u{1f600}", "xy"),
        "ab\u{1f600}",
      );
    }));

  /**
   * Characters that have no shape of their own.
   *
   * A hint character must be a letter, a number, a punctuation mark or a
   * symbol. Each row gives a set from the user and the alphabet that the hints
   * use. A character that draws nothing gives a label that the user cannot
   * read, and two labels that look the same.
   */
  const INVISIBLE_CASES: readonly {
    readonly name: string;
    readonly input: string;
    readonly expected: string;
  }[] = [
    {
      name: "a variation selector after a heart",
      input: "\u2764\ufe0f\u{1f600}",
      expected: "\u2764\u{1f600}",
    },
    {
      name: "a text variation selector",
      input: "a\ufe0eb",
      expected: "ab",
    },
    {
      name: "a tag character",
      input: "a\u{e0061}b",
      expected: "ab",
    },
    {
      name: "a Hangul choseong filler",
      input: "\u115fx",
      expected: "xy",
    },
    {
      name: "a zero width joiner on its own",
      input: "\u200dabc",
      expected: "abc",
    },
    {
      name: "a zero width joiner inside a family emoji",
      input: "\u{1f468}\u200d\u{1f469}",
      expected: "xy",
    },
    {
      name: "a combining acute after a letter",
      input: "a\u0301bc",
      // NFC joins the pair into one letter, which is one hint character.
      expected: "\u00e1bc",
    },
    {
      name: "a combining acute that follows nothing",
      input: "\u0301abc",
      expected: "abc",
    },
    {
      name: "a zero width space",
      input: "a\u200bbc",
      expected: "abc",
    },
    {
      name: "a control character",
      input: "a\u0007bc",
      expected: "abc",
    },
    {
      name: "a no-break space",
      input: "a\u00a0bc",
      expected: "abc",
    },
    {
      name: "a soft hyphen",
      input: "a\u00adbc",
      expected: "abc",
    },
    {
      name: "a private use character",
      input: "a\ue000bc",
      expected: "abc",
    },
  ];

  for (const row of INVISIBLE_CASES) {
    it.effect(`drops a character with no shape: ${row.name}`, () =>
      Effect.sync(() => {
        assert.strictEqual(
          normaliseHintCharacters(row.input, "xy"),
          row.expected,
        );
      }));
  }

  /** The four grapheme cases from the review. */
  const GRAPHEME_CASES: readonly {
    readonly name: string;
    readonly input: string;
    readonly alphabet: string;
    readonly labels: readonly string[];
  }[] = [
    {
      name: "a family selects the complete fallback",
      input: "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}",
      alphabet: "xy",
      labels: ["xx", "yx", "xy", "yy"],
    },
    {
      name: "a flag loses its two regional indicators",
      input: "\u{1f1e9}\u{1f1ea}",
      alphabet: "xy",
      labels: ["xx", "yx", "xy", "yy"],
    },
    {
      name: "a thumb loses its skin tone modifier",
      input: "\u{1f44d}\u{1f3fd}ab",
      alphabet: "\u{1f44d}ab",
      labels: [
        "a",
        "\u{1f44d}a",
        "b",
        "\u{1f44d}\u{1f44d}",
      ],
    },
    {
      name: "a combining acute composes with its letter",
      input: "e\u0301x",
      alphabet: "\u00e9x",
      labels: ["xx", "\u00e9x", "x\u00e9", "\u00e9\u00e9"],
    },
  ];

  for (const row of GRAPHEME_CASES) {
    it.effect(`keeps grapheme boundaries: ${row.name}`, () =>
      Effect.sync(() => {
        const alphabet = normaliseHintCharacters(row.input, "xy");
        assert.strictEqual(alphabet, row.alphabet);
        assert.deepEqual(hintStrings(4, alphabet), row.labels);
      }));
  }

  it.effect("gives visible and distinct labels for a heart and a face", () =>
    Effect.sync(() => {
      // The reviewer's case. The set holds three code points, and the middle
      // one draws nothing. Without the filter the labels were
      // ["\u2764\u2764", "\u{1f600}", "\ufe0f", "\u2764\ufe0f"]: one label was
      // invisible, and two looked the same.
      const alphabet = normaliseHintCharacters("\u2764\ufe0f\u{1f600}", "xy");
      assert.strictEqual(alphabet, "\u2764\u{1f600}");
      const labels = hintStrings(4, alphabet);
      assert.strictEqual(new Set(labels).size, labels.length);
      for (const label of labels) {
        assert.strictEqual(label.normalize("NFC"), label);
      }
    }));

  it.effect("refuses both endpoints of each emoji joiner property", () =>
    Effect.sync(() => {
      assert.strictEqual(
        normaliseHintCharacters("ab\u{1f1e6}", "xy"),
        "ab",
      );
      assert.strictEqual(
        normaliseHintCharacters("ab\u{1f1ff}", "xy"),
        "ab",
      );
      assert.strictEqual(
        normaliseHintCharacters("ab\u{1f3fb}", "xy"),
        "ab",
      );
      assert.strictEqual(
        normaliseHintCharacters("ab\u{1f3ff}", "xy"),
        "ab",
      );
    }));

  it.effect("refuses Hangul jamo and pair composition", () =>
    Effect.sync(() => {
      assert.strictEqual(normaliseHintCharacters("\u1100x", "xy"), "xy");
      assert.strictEqual(normaliseHintCharacters("\u1161x", "xy"), "xy");
      const alphabet = normaliseHintCharacters("\u1100x\u1161\uac00", "xy");
      assert.strictEqual(alphabet, "x\uac00");
      const labels = hintStrings(6, alphabet);
      assert.strictEqual(
        new Set(labels.map((label) => label.normalize("NFC"))).size,
        labels.length,
      );

      const pairs = [...alphabet].flatMap((first) =>
        [...alphabet].map((second) => first + second)
      );
      assert.strictEqual(
        new Set(pairs.map((pair) => pair.normalize("NFC"))).size,
        pairs.length,
      );
      assert.strictEqual(
        new Set(pairs.map(hintCharacterKey)).size,
        pairs.length,
      );
      const segmenter = new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      });
      for (const pair of pairs) {
        assert.lengthOf([...segmenter.segment(pair)], 2);
      }
    }));

  it.effect("cannot detect font coverage for a Tangsa letter", () =>
    Effect.sync(() => {
      // Font coverage depends on the device and is unavailable in this module.
      assert.strictEqual(
        normaliseHintCharacters("\u{16a70}x", "xy"),
        "\u{16a70}x",
      );
    }));

  it.effect("composes the set with NFC before it reads a character", () =>
    Effect.sync(() => {
      // The same letter, from two sources: one code point, and a letter plus a
      // combining acute. One setting must give one alphabet.
      assert.strictEqual(
        normaliseHintCharacters("\u00e9x", "xy"),
        normaliseHintCharacters("e\u0301x", "xy"),
      );
      assert.strictEqual(hintCharacterCount("e\u0301x"), 2);
      assert.strictEqual(hintCharacterCount("\u{1f600}"), 1);
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
