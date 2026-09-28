/**
 * The generation of hint strings.
 *
 * Ported from the Vimium `content_scripts/link_hints.js` (`AlphabetHints`,
 * MIT).
 *
 * Pure: no DOM, no settings object and no side effect. That is the intention.
 * This is the part of the hints subsystem whose correctness must be pinned by
 * unit tests, and the sort-then-reverse step is subtle. A change in it is not
 * visible in a manual test.
 */

import { Array, flow, HashSet, Iterable, Option, Order, Predicate, pipe } from "effect";

/** The code points of a string. A hint character can be outside the BMP. */
const codePoints = (value: string): readonly string[] => Array.fromIterable(value);

/**
 * The composed form of a string.
 *
 * One hint character is one code point *after* NFC. The same alphabet, pasted
 * from two sources, must give one alphabet: `"é"` as one code point and `"é"`
 * as `e` plus a combining acute are the same letter for the user. NFC gives
 * the shorter of the two, so the letter stays one hint character.
 *
 * NFC, and not NFD: NFD makes an accent a character of its own, and an accent
 * alone is not a label that a user can read or type.
 */
const toNfc = (value: string): string => value.normalize("NFC");

/** How many characters a string holds, counted by code point after NFC. */
export const hintCharacterCount: (value: string) => number = flow(toNfc, codePoints, Array.length);

/**
 * Reverse by code point, so an astral character in a custom alphabet survives.
 *
 * The split into code points is intentional. A hint alphabet holds characters,
 * and not words.
 */
export const reverseString: (value: string) => string = flow(
  codePoints,
  Array.reverse,
  Array.join(""),
);

/**
 * The identity of one hint character after a case fold.
 *
 * Two characters that give the same identity collide. The round trip through
 * uppercase finds the pairs that a plain lowercase misses. The Greek final
 * sigma and the Greek sigma both give the sigma. The Turkish dotless i and
 * the Latin i both give the Latin i.
 *
 * The case map is the invariant one, and not a locale one. A hint alphabet
 * must give the same labels in every browser. Under a Turkish locale
 * `toLocaleUpperCase` turns the Latin i into a dotted capital I, so one
 * setting would give two different alphabets on two machines.
 */
export const hintCharacterKey = (char: string): string =>
  char.toLowerCase().toUpperCase().toLowerCase();

/** Unicode properties that define independent hint characters. */
const VISIBLE_CATEGORIES = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const SURROGATE = /^\p{Surrogate}$/u;
const REGIONAL_INDICATOR = /^\p{Regional_Indicator}$/u;
const EMOJI_MODIFIER = /^\p{Emoji_Modifier}$/u;
const HANGUL_SCRIPT = /^\p{Script=Hangul}$/u;
const JOIN_CONTROL = /\p{Join_Control}/u;

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/**
 * Does this character have the Hangul property without being a syllable?
 *
 * Unicode NFD decomposes a Hangul syllable. It does not change a conjoining or
 * compatibility jamo. A jamo can combine with its neighbour, so it is refused.
 */
const isHangulJamo = (char: string): boolean =>
  HANGUL_SCRIPT.test(char) && char.normalize("NFD") === char;

/**
 * Can this code point be one independent hint character?
 *
 * Unicode properties refuse default-ignorable characters, Hangul jamo,
 * regional indicators, emoji modifiers and surrogate halves. Category checks
 * refuse marks, controls, private-use characters and spaces.
 *
 * Font coverage is device-dependent and is not available in this pure module.
 * Thus, this check cannot detect a missing glyph such as U+16A70.
 */
const isIndependentHintCharacter = (char: string): boolean =>
  codePoints(char).length === 1 &&
  !SURROGATE.test(char) &&
  VISIBLE_CATEGORIES.test(char) &&
  !DEFAULT_IGNORABLE.test(char) &&
  !REGIONAL_INDICATOR.test(char) &&
  !EMOJI_MODIFIER.test(char) &&
  !isHangulJamo(char) &&
  codePoints(char.toLowerCase()).length === 1 &&
  codePoints(hintCharacterKey(char)).length === 1;

/** Does the input contain one joined symbol that uses a join control? */
const hasJoinedSymbol = (value: string): boolean =>
  pipe(
    graphemeSegmenter.segment(value),
    Iterable.some(({ segment }) => codePoints(segment).length > 1 && JOIN_CONTROL.test(segment)),
  );

/**
 * The matching key of one ordered pair, when the pair stays two characters.
 *
 * NFC stability gives the canonical-composition property. Unicode extended
 * grapheme cluster rules make sure that the pair stays as two graphemes. The
 * NFC fold key of the pair must still be two code points.
 */
const independentPairKey = (pair: string): Option.Option<string> =>
  pipe(
    pair,
    Option.liftPredicate(
      (pair) => toNfc(pair) === pair && Iterable.size(graphemeSegmenter.segment(pair)) === 2,
    ),
    Option.map((pair) => toNfc(hintCharacterKey(pair))),
    Option.filter((key) => codePoints(key).length === 2),
  );

/**
 * Can all ordered pairs stay separate and keep unique matching keys?
 *
 * Unique NFC fold keys prevent two pairs from getting one matching string.
 */
const hasIndependentPairs = (characters: readonly string[]): boolean =>
  pipe(
    characters,
    Array.cartesianWith(characters, (first, second) => first + second),
    Array.map(independentPairKey),
    Option.all,
    Option.exists((keys) => pipe(keys, HashSet.fromIterable, HashSet.size) === keys.length),
  );

/**
 * The independent characters of a composed value, in lowercase.
 *
 * The first character of each case-fold identity stays, and every later one
 * that collides with it is dropped.
 */
const independentCharacters: (nfc: string) => readonly string[] = flow(
  codePoints,
  Array.filter(isIndependentHintCharacter),
  Array.map((char) => ({ char, key: hintCharacterKey(char) })),
  Array.dedupeWith((first, second) => first.key === second.key),
  Array.map(({ char }) => char.toLowerCase()),
);

/**
 * Read a character set from the user.
 *
 * The value is composed with NFC first. Invalid and repeated code points are
 * removed. A joined symbol or an unsafe pair refuses the complete alphabet.
 * Every accepted character is lowercase, so the label and the keystroke agree.
 */
export const readHintCharacters: (characters: string) => readonly string[] = flow(
  toNfc,
  Option.liftPredicate(Predicate.not(hasJoinedSymbol)),
  Option.map(independentCharacters),
  Option.filter(hasIndependentPairs),
  Option.getOrElse(() => Array.empty<string>()),
);

/**
 * Fold a character set from the user into an alphabet that we can use.
 *
 * A duplicate makes two different links show the same hint string. An alphabet
 * of one character cannot give a prefix-free code at all. Both cases give the
 * fallback, instead of hints that the user cannot type.
 *
 * A character that a case fold expands or has no shape is dropped. A character
 * that collides with an earlier one is also dropped. Joined symbols and unsafe
 * pairs select the fallback. Each remaining code point is independent.
 */
export const normaliseHintCharacters = (characters: string, fallback: string): string =>
  pipe(
    characters,
    readHintCharacters,
    Option.liftPredicate((alphabet) => alphabet.length >= 2),
    Option.match({ onNone: () => fallback, onSome: Array.join("") }),
  );

/**
 * The digits of a positive number in the radix of `chars`, last digit first.
 *
 * `lowest` is the value of the first character. It is 0 for an ordinary
 * numeral. It is 1 for a bijective numeral, which has no zero digit, so every
 * string of characters is the numeral of exactly one number.
 *
 * A loop, and not an `Array.unfold` over `Option`: filter mode numbers every
 * match again on each keystroke. In Node 26, `numberToHintString` took 6.2 ms
 * for 8000 numbers with the unfold, and 2.3 ms with this loop.
 */
const digitsOf =
  (chars: readonly string[], lowest: 0 | 1) =>
  (value: number): readonly string[] => {
    const digits: string[] = [];
    let rest = value;
    while (rest > 0) {
      const shifted = rest - lowest;
      // `noUncheckedIndexedAccess` asks for the fallback. The index is a
      // remainder of the length, so it is always inside the array.
      digits.push(chars[shifted % chars.length] ?? "");
      rest = Math.floor(shifted / chars.length);
    }
    return digits;
  };

/**
 * Where the last frontier of the breadth-first expansion stands.
 *
 * The expansion starts from the empty root. Each step takes the oldest hint of
 * the frontier and appends one child for each character, so the frontier grows
 * by `base - 1`. The steps stop at the first one after which the frontier holds
 * `linkCount` hints. The positions are indices into the order in which the
 * hints were appended.
 */
const lastFrontier = (linkCount: number, base: number): readonly number[] => {
  const steps = Math.max(1, Math.ceil((linkCount - 1) / (base - 1)));
  return pipe(
    linkCount,
    Array.makeBy((index) => steps + index),
  );
};

/**
 * Mixed-radix hint strings in breadth-first order. They are built *backwards*,
 * then sorted, then reversed.
 *
 * The hint at position `p` of the expansion puts one character in front of the
 * hint at position `floor((p - 1) / base)`. That is the bijective numeral of
 * `p`, with its last digit first.
 *
 * The sort and the reverse are the important step. Without them the short
 * hints all go to the first links in document order, which are usually the
 * navigation of the site. With them the short hints are spread over the page.
 *
 * The result is prefix-free. A hint is therefore unambiguous as soon as the
 * user types its last character.
 */
export const hintStrings = (linkCount: number, alphabet: string): readonly string[] =>
  pipe(
    // The split into code points is intentional. See `reverseString`.
    codePoints(alphabet),
    Option.liftPredicate((chars) => chars.length >= 2 && linkCount > 0),
    Option.map((chars) =>
      pipe(
        lastFrontier(linkCount, chars.length),
        Array.map(flow(digitsOf(chars, 1), Array.join(""))),
        Array.sort(Order.String),
        Array.map(reverseString),
      ),
    ),
    Option.getOrElse(() => Array.empty<string>()),
  );

/**
 * A 1-based hint number in mixed radix, for filter mode.
 *
 * With the default `linkHintNumbers` of `"0123456789"` this is the decimal
 * form. The indirection lets the setting give another set of digits. Upstream
 * supports a set that is not Latin.
 */
export const numberToHintString = (value: number, characterSet: string): string =>
  pipe(
    // The split into code points is intentional. See `reverseString`.
    codePoints(characterSet),
    Option.liftPredicate((chars) => chars.length >= 2 && Number.isFinite(value) && value >= 1),
    Option.map((chars) =>
      pipe(Math.floor(value), digitsOf(chars, 0), Array.reverse, Array.join("")),
    ),
    Option.getOrElse(() => ""),
  );

/** The indices of the hints that an extension of `typed` can still reach. */
export const matchByPrefix = (hints: readonly string[], typed: string): readonly number[] =>
  pipe(
    hints,
    Array.map((hint, index) => ({ hint, index })),
    // A count of UTF-16 units is enough here. `startsWith` compares whole
    // units, and both strings are built from the same alphabet, so a prefix
    // can never end inside a character.
    Array.filter(({ hint }) => hint.startsWith(typed)),
    Array.map(({ index }) => index),
  );
