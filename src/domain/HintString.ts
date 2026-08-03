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

/** Is this one half of a surrogate pair, and therefore half a character? */
const isSurrogateHalf = (char: string): boolean => {
  const code = char.codePointAt(0);
  return code !== undefined && code >= 0xd800 && code <= 0xdfff;
};

/**
 * A hint character must be a letter, a number, a punctuation mark or a symbol.
 *
 * These categories usually have a shape of their own. The checks below remove
 * symbols that join another emoji into one grapheme.
 *
 * - A mark (`\p{M}`) draws on the character before it. A combining acute alone
 *   is not a label.
 * - A format character (`\p{Cf}`) draws nothing. The variation selector
 *   U+FE0F and the zero width joiner are the two that a user meets, because
 *   they hide inside an emoji that was copied from a message.
 * - A control character, a surrogate half and a private use character
 *   (`\p{C}`) have no agreed shape.
 * - A space (`\p{Z}`) gives a label that looks empty.
 *
 * Each accepted character is one visible NFC code point. It also stays one
 * code point through its case fold. This is the invariant that matching needs.
 * Some scripts can draw adjacent letters as one grapheme, so no grapheme count
 * is claimed here.
 */
const VISIBLE_CATEGORIES = /^[\p{L}\p{N}\p{P}\p{S}]$/u;

/** Symbols that join an adjacent emoji instead of staying separate. */
const EMOJI_JOINERS = /^[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]$/u;

/** Why a character cannot be a hint character. */
export type HintRefusal =
  | "half-character"
  | "invisible"
  | "emoji-joiner"
  | "case-fold"
  | "duplicate";

/** One sentence for the user, for each refusal. */
export const describeHintRefusal = (refusal: HintRefusal): string => {
  switch (refusal) {
    case "half-character":
      return "it is half of a character";
    case "invisible":
      return "it is not a letter, a number, a punctuation mark or a symbol";
    case "emoji-joiner":
      return "it joins an adjacent emoji into one grapheme";
    case "case-fold":
      return "a case fold makes it two characters";
    case "duplicate":
      return "it repeats an earlier character";
  }
};

/**
 * Can this character be one character of a hint label?
 *
 * The character must be one code point, it must have a shape of its own, and
 * it must stay one code point through the whole case fold. Five kinds of
 * character break those rules:
 *
 * - Half of a surrogate pair is not a character at all. It comes from a value
 *   that was cut at a UTF-16 boundary.
 * - An invisible character gives a label that the user cannot see. The
 *   variation selector U+FE0F is the one that a user meets, because it hides
 *   inside a copied emoji.
 * - A regional indicator or an emoji modifier joins an adjacent emoji. It does
 *   not stay one displayed character in a longer label.
 * - The Turkish dotted capital I becomes the Latin i plus a combining dot.
 *   The alphabet then holds a second Latin i, and two hints show the same
 *   label.
 * - The German sharp s becomes the two letters SS in uppercase.
 * - The fi ligature becomes the two letters FI in uppercase.
 *
 * A label that grows to two characters is a label that the user cannot type.
 */
export const isUsableHintCharacter = (char: string): boolean =>
  refuseHintCharacter(char) === null;

/** Why this character is refused, or `null` when it is accepted. */
export const refuseHintCharacter = (char: string): HintRefusal | null => {
  if (codePoints(char).length !== 1) return "half-character";
  if (isSurrogateHalf(char)) return "half-character";
  if (!VISIBLE_CATEGORIES.test(char)) return "invisible";
  if (EMOJI_JOINERS.test(char)) return "emoji-joiner";
  if (codePoints(char.toLowerCase()).length !== 1) return "case-fold";
  if (codePoints(hintCharacterKey(char)).length !== 1) return "case-fold";
  return null;
};

/** One character of a set that was refused, and the reason. */
export interface DroppedHintCharacter {
  readonly char: string;
  readonly refusal: HintRefusal;
}

/** The characters that a set gives, and the characters that it loses. */
export interface HintAlphabet {
  readonly characters: readonly string[];
  readonly dropped: readonly DroppedHintCharacter[];
}

/**
 * Read a character set from the user.
 *
 * The value is composed with NFC first. Each code point is then accepted,
 * refused for its own reason, or dropped as a repeat of an earlier character.
 * Every accepted character is lowercase, so the label and the keystroke agree.
 */
export const readHintCharacters = (characters: string): HintAlphabet => {
  const seen = new Set<string>();
  const out: string[] = [];
  const dropped: DroppedHintCharacter[] = [];
  for (const char of codePoints(toNfc(characters))) {
    const refusal = refuseHintCharacter(char);
    if (refusal !== null) {
      dropped.push({ char, refusal });
      continue;
    }
    const key = hintCharacterKey(char);
    if (seen.has(key)) {
      dropped.push({ char, refusal: "duplicate" });
      continue;
    }
    seen.add(key);
    out.push(char.toLowerCase());
  }
  return { characters: out, dropped };
};

/**
 * Fold a character set from the user into an alphabet that we can use.
 *
 * A duplicate makes two different links show the same hint string. An alphabet
 * of one character cannot give a prefix-free code at all. Both cases give the
 * fallback, instead of hints that the user cannot type.
 *
 * A character that a case fold expands, a character that has no shape, and a
 * character that collides with an earlier one are dropped. The result is
 * therefore a sequence of distinct visible code points, and each one is one
 * hint character.
 */
export const normaliseHintCharacters = (
  characters: string,
  fallback: string,
): string => {
  const alphabet = readHintCharacters(characters).characters;
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
