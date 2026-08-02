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

/** Reverse by code point, so an astral character in a custom alphabet survives. */
export const reverseString = (value: string): string =>
  // The split into code points is intentional. A hint alphabet holds
  // characters, and not words.
  // oxlint-disable-next-line typescript/no-misused-spread
  [...value].reverse().join("");

/**
 * Fold a character set from the user into an alphabet that we can use.
 *
 * A duplicate makes two different links show the same hint string. An alphabet
 * of one character cannot give a prefix-free code at all. Both cases give the
 * fallback, instead of hints that the user cannot type.
 */
export const normaliseHintCharacters = (
  characters: string,
  fallback: string,
): string => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const char of characters) {
    const lower = char.toLowerCase();
    if (lower.trim().length === 0 || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out.length >= 2 ? out.join("") : fallback;
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
  // oxlint-disable-next-line typescript/no-misused-spread
  const chars = [...alphabet];
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
  // oxlint-disable-next-line typescript/no-misused-spread
  const chars = [...characterSet];
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
    if (hints[index]?.startsWith(typed) === true) out.push(index);
  }
  return out;
};
