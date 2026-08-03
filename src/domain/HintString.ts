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

/** The code points of a string. A hint character can be outside the BMP. */
// oxlint-disable-next-line typescript/no-misused-spread
const codePoints = (value: string): readonly string[] => [...value];

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
export const hintCharacterCount = (value: string): number =>
  codePoints(toNfc(value)).length;

/** Reverse by code point, so an astral character in a custom alphabet survives. */
export const reverseString = (value: string): string =>
  // The split into code points is intentional. A hint alphabet holds
  // characters, and not words.
  [...codePoints(value)].reverse().join("");

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
const hasJoinedSymbol = (value: string): boolean => {
  for (const { segment } of graphemeSegmenter.segment(value)) {
    if (codePoints(segment).length > 1 && JOIN_CONTROL.test(segment)) {
      return true;
    }
  }
  return false;
};

/**
 * Can all ordered pairs stay separate and keep unique matching keys?
 *
 * NFC stability gives the canonical-composition property. Unicode extended
 * grapheme cluster rules make sure that each pair stays as two graphemes.
 * Unique NFC fold keys prevent two pairs from getting one matching string.
 */
const hasIndependentPairs = (characters: readonly string[]): boolean => {
  const keys = new Set<string>();
  for (const first of characters) {
    for (const second of characters) {
      const pair = first + second;
      if (toNfc(pair) !== pair) return false;
      if ([...graphemeSegmenter.segment(pair)].length !== 2) return false;
      const key = toNfc(hintCharacterKey(pair));
      if (codePoints(key).length !== 2 || keys.has(key)) return false;
      keys.add(key);
    }
  }
  return true;
};

/**
 * Read a character set from the user.
 *
 * The value is composed with NFC first. Invalid and repeated code points are
 * removed. A joined symbol or an unsafe pair refuses the complete alphabet.
 * Every accepted character is lowercase, so the label and the keystroke agree.
 */
export const readHintCharacters = (characters: string): readonly string[] => {
  const nfc = toNfc(characters);
  if (hasJoinedSymbol(nfc)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const char of codePoints(nfc)) {
    if (!isIndependentHintCharacter(char)) continue;
    const key = hintCharacterKey(char);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(char.toLowerCase());
  }
  return hasIndependentPairs(out) ? out : [];
};

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
export const normaliseHintCharacters = (
  characters: string,
  fallback: string,
): string => {
  const alphabet = readHintCharacters(characters);
  return alphabet.length >= 2 ? alphabet.join("") : fallback;
};

/**
 * Mixed-radix hint strings in breadth-first order. They are built *backwards*,
 * then sorted, then reversed.
 *
 * The sort and the reverse are the important step. Without them the short
 * hints all go to the first links in document order, which are usually the
 * navigation of the site. With them the short hints are spread over the page.
 *
 * The result is prefix-free. A hint is therefore unambiguous as soon as the
 * user types its last character.
 */
export const hintStrings = (
  linkCount: number,
  alphabet: string,
): readonly string[] => {
  if (linkCount <= 0) return [];
  // The split into code points is intentional. See `reverseString`.
  const chars = codePoints(alphabet);
  if (chars.length < 2) return [];

  const hints: string[] = [""];
  let offset = 0;

  while (hints.length - offset < linkCount || hints.length === 1) {
    // `offset` cannot go past `hints.length`, because each turn adds at least
    // two entries. `noUncheckedIndexedAccess` still asks for the guard.
    const hint = hints[offset++] ?? "";
    for (const char of chars) hints.push(char + hint);
  }

  return hints.slice(offset, offset + linkCount).sort().map(reverseString);
};

/**
 * A 1-based hint number in mixed radix, for filter mode.
 *
 * With the default `linkHintNumbers` of `"0123456789"` this is the decimal
 * form. The indirection lets the setting give another set of digits. Upstream
 * supports a set that is not Latin.
 */
export const numberToHintString = (
  value: number,
  characterSet: string,
): string => {
  // The split into code points is intentional. See `reverseString`.
  const chars = codePoints(characterSet);
  const base = chars.length;
  if (base < 2 || !Number.isFinite(value) || value < 1) return "";

  const digits: string[] = [];
  let remaining = Math.floor(value);
  while (remaining > 0) {
    digits.unshift(chars[remaining % base] ?? "");
    remaining = Math.floor(remaining / base);
  }
  return digits.join("");
};

/** The indices of the hints that an extension of `typed` can still reach. */
export const matchByPrefix = (
  hints: readonly string[],
  typed: string,
): readonly number[] => {
  if (typed.length === 0) return hints.map((_, index) => index);
  const out: number[] = [];
  for (let index = 0; index < hints.length; index++) {
    // A count of UTF-16 units is enough here. `startsWith` compares whole
    // units, and both strings are built from the same alphabet, so a prefix
    // can never end inside a character.
    if (hints[index]?.startsWith(typed) === true) out.push(index);
  }
  return out;
};
