/**
 * Hint-string generation.
 *
 * Ported from Vimium's `content_scripts/link_hints.js` (`AlphabetHints`, MIT).
 *
 * Pure: no DOM, no settings object, no side effects. That is deliberate — this
 * is the one part of the hints subsystem whose correctness is worth pinning
 * down with unit tests, and the sort-then-reverse step is subtle enough that a
 * regression would be invisible in manual testing.
 */

/** Reverse by code point, so astral characters in a custom alphabet survive. */
export const reverseString = (value: string): string =>
  // Intentional code-point split. Hint alphabets contain characters, not words.
  // oxlint-disable-next-line typescript/no-misused-spread
  [...value].reverse().join("");

/**
 * Fold a user-supplied character set into a usable alphabet.
 *
 * Duplicates would make two distinct links share a hint string, and a
 * single-character alphabet cannot produce a prefix-free code at all, so both
 * fall back rather than generating hints the user cannot type.
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
 * Breadth-first mixed-radix hint strings, built *backwards*, then sorted and
 * reversed.
 *
 * The sort-then-reverse is the whole trick: without it the short hints all land
 * on the first few links in document order, which are usually the site chrome.
 * With it they are scattered evenly across the page.
 *
 * The result is prefix-free, so a hint is unambiguous the moment its last
 * character is typed.
 */
export const hintStrings = (
  linkCount: number,
  alphabet: string,
): readonly string[] => {
  if (linkCount <= 0) return [];
  // Intentional code-point split. See `reverseString`.
  // oxlint-disable-next-line typescript/no-misused-spread
  const chars = [...alphabet];
  if (chars.length < 2) return [];

  const hints: string[] = [""];
  let offset = 0;

  while (hints.length - offset < linkCount || hints.length === 1) {
    // `offset` never overruns `hints.length` because each iteration appends at
    // least two entries, but `noUncheckedIndexedAccess` still wants the guard.
    const hint = hints[offset++] ?? "";
    for (const char of chars) hints.push(char + hint);
  }

  return hints.slice(offset, offset + linkCount).sort().map(reverseString);
};

/**
 * Mixed-radix rendering of a 1-based hint number, for filter mode.
 *
 * With the default `linkHintNumbers` of `"0123456789"` this is just the decimal
 * representation; the indirection exists so the setting can supply any digit
 * set (upstream honours it for non-Latin numerals).
 */
export const numberToHintString = (
  value: number,
  characterSet: string,
): string => {
  // Intentional code-point split. See `reverseString`.
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

/** Indices of the hints still reachable by extending `typed`. */
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
