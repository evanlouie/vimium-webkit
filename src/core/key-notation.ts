/**
 * Key notation: `KeyboardEvent` → `"<c-a>"`, and back.
 *
 * Derived from upstream Vimium's `lib/keyboard_utils.js` (MIT), which in turn
 * credits the `vim-like-key-notation` project. Behaviour is preserved so that
 * existing Vimium `map` lines paste in unchanged (goal G5).
 *
 * WebKit-specific additions live at the bottom: the AppKit private-use-area
 * normalisation that iOS hardware keyboards need, and the reserved-shortcut
 * table that the mapping parser rejects against.
 */

// ---------------------------------------------------------------------------
// Named keys
// ---------------------------------------------------------------------------

/** `event.key` → the name used inside `<...>`. */
const NAMED_KEYS: ReadonlyMap<string, string> = new Map([
  [" ", "space"],
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
  ["Enter", "enter"],
  ["Escape", "esc"],
  ["Backspace", "backspace"],
  ["Delete", "delete"],
  ["Tab", "tab"],
  ["Home", "home"],
  ["End", "end"],
  ["PageUp", "pageup"],
  ["PageDown", "pagedown"],
  ["Insert", "insert"],
]);

/** Accepted aliases when *parsing* a mapping, folded onto the canonical name. */
const NAME_ALIASES: ReadonlyMap<string, string> = new Map([
  ["escape", "esc"],
  ["return", "enter"],
  ["cr", "enter"],
  ["bs", "backspace"],
  ["del", "delete"],
  ["spc", "space"],
  ["pgup", "pageup"],
  ["pgdn", "pagedown"],
  ["pagedn", "pagedown"],
  ["ins", "insert"],
  ["lt", "<"],
]);

const isFunctionKey = (key: string): boolean =>
  /^f([1-9]|1\d|2[0-4])$/.test(key);

// ---------------------------------------------------------------------------
// AppKit private-use-area normalisation (iOS hardware keyboards)
// ---------------------------------------------------------------------------

/**
 * iOS delivers special keys from a hardware keyboard as AppKit function-key
 * codepoints in the Unicode private use area (U+F700–U+F8FF) rather than as
 * named `event.key` values. Mirrors WebKit r236678.
 *
 * Without this, `<up>`/`<down>`/`<esc>` mappings are dead on an iPad with a
 * Magic Keyboard while working fine on macOS — a difference no user will
 * successfully report.
 */
const APPKIT_PUA: ReadonlyMap<number, string> = new Map([
  [0xf700, "ArrowUp"],
  [0xf701, "ArrowDown"],
  [0xf702, "ArrowLeft"],
  [0xf703, "ArrowRight"],
  [0xf727, "Insert"],
  [0xf728, "Delete"],
  [0xf729, "Home"],
  [0xf72b, "End"],
  [0xf72c, "PageUp"],
  [0xf72d, "PageDown"],
  [0xf739, "Delete"],
]);

/** U+F704..U+F726 are F1..F35. */
const appKitFunctionKey = (code: number): string | null => {
  if (code < 0xf704 || code > 0xf726) return null;
  return `F${code - 0xf704 + 1}`;
};

export const normaliseAppKitKey = (key: string): string => {
  if (key.length !== 1) return key;
  const code = key.codePointAt(0);
  if (code === undefined || code < 0xf700 || code > 0xf8ff) return key;
  return APPKIT_PUA.get(code) ?? appKitFunctionKey(code) ?? key;
};

// ---------------------------------------------------------------------------
// Event → notation
// ---------------------------------------------------------------------------

/** The subset of `KeyboardEvent` we depend on. Keeps the module unit-testable. */
export interface KeyEventLike {
  readonly key: string;
  readonly code?: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly repeat?: boolean;
}

const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "AltGraph",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Fn",
  "FnLock",
  "Hyper",
  "Super",
  "Symbol",
  "SymbolLock",
]);

export const isModifierKey = (event: KeyEventLike): boolean =>
  MODIFIER_KEYS.has(event.key);

/**
 * IME and dead-key composition.
 *
 * `keyCode === 229` is the legacy signal that survives on engines and IMEs
 * where `isComposing` is unreliable; both are checked because a missed guard
 * here means Vimium-WebKit eats keystrokes mid-composition, which is the single
 * most damaging failure mode for CJK users.
 */
export const isComposing = (event: KeyEventLike): boolean =>
  event.isComposing === true || event.keyCode === 229;

/**
 * Derive the base character, optionally ignoring the active keyboard layout.
 *
 * With `ignoreKeyboardLayout` the physical `event.code` wins, so that a Dvorak
 * or Cyrillic layout still drives QWERTY-positioned bindings.
 */
export const keyChar = (
  event: KeyEventLike,
  ignoreKeyboardLayout: boolean,
): string | null => {
  if (isModifierKey(event)) return null;

  if (ignoreKeyboardLayout && event.code) {
    const code = event.code;
    if (code.startsWith("Key")) return code.slice(3).toLowerCase();
    // Shifted digits are the exception: the *character* is what the binding
    // names, and folding `Shift+4` back to `"4"` both killed four shipped
    // bindings (`$`, `#`, `*`, `^`) and fed them to the count prefix. Physical
    // positions are what this option is for, and a shifted digit's position is
    // already unambiguous from the character.
    if (code.startsWith("Digit") && !event.shiftKey) return code.slice(5);
    if (code.startsWith("Numpad")) {
      const suffix = code.slice(6);
      // `NumpadDivide` etc. are named keys, not characters; lowercasing them
      // produced `"divide"`, which no notation can express.
      return /^\d$/.test(suffix) ? suffix : normaliseAppKitKey(event.key);
    }
  }

  const key = normaliseAppKitKey(event.key);
  if (key.length === 0 || key === "Unidentified") return null;

  const named = NAMED_KEYS.get(key);
  if (named) return named;
  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) return key.toLowerCase();
  return key;
};

/**
 * Canonical modifier order.
 *
 * Emission is always in this order so that trie keys are stable; *parsing* is
 * order-insensitive so that hand-written `<a-c-x>` still works.
 */
type ModifierLetter = "c" | "a" | "m" | "s";

const isNamedChar = (char: string): boolean =>
  char.length > 1 || NAMED_KEYS.has(char) || isFunctionKey(char);

/**
 * Render an event as Vimium key notation, or `null` if it carries no key.
 *
 * `Shift` is folded into the character for single printable characters (`F`,
 * not `<s-f>`) and expressed explicitly for named keys (`<s-tab>`), matching
 * upstream and matching what users actually write.
 */
export const keyNotation = (
  event: KeyEventLike,
  ignoreKeyboardLayout = false,
): string | null => {
  let char = keyChar(event, ignoreKeyboardLayout);
  if (char === null) return null;

  const named = isNamedChar(char);
  const modifiers: ModifierLetter[] = [];

  if (event.ctrlKey) modifiers.push("c");
  if (event.altKey) modifiers.push("a");
  if (event.metaKey) modifiers.push("m");
  if (event.shiftKey && named) modifiers.push("s");

  if (!named && char.length === 1 && event.shiftKey) {
    // A layout-derived char under `ignoreKeyboardLayout` has not had shift
    // applied by the platform, so apply it ourselves.
    char = char.toUpperCase();
  }

  if (modifiers.length === 0 && !named) return char;
  return `<${[...modifiers, char].join("-")}>`;
};

// ---------------------------------------------------------------------------
// Notation parsing
// ---------------------------------------------------------------------------

export interface ParsedKey {
  readonly notation: string;
  readonly char: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

export class KeyNotationError extends Error {
  readonly input: string;
  constructor(input: string, message: string) {
    super(message);
    this.name = "KeyNotationError";
    this.input = input;
  }
}

const parseAngleKey = (body: string, original: string): ParsedKey => {
  // Split on `-`, but the final segment may itself be `-`, as in `<c-->`.
  const parts: string[] = [];
  let index = 0;
  while (index < body.length) {
    const dash = body.indexOf("-", index);
    if (dash === -1 || dash === body.length - 1) {
      parts.push(body.slice(index));
      break;
    }
    parts.push(body.slice(index, dash));
    index = dash + 1;
  }

  const last = parts.pop();
  if (last === undefined || last.length === 0) {
    throw new KeyNotationError(original, `${original} has no key`);
  }

  let ctrl = false;
  let alt = false;
  let meta = false;
  let shift = false;

  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "c":
      case "ctrl":
      case "control":
        ctrl = true;
        break;
      case "a":
      case "alt":
      case "opt":
      case "option":
        alt = true;
        break;
      case "m":
      case "meta":
      case "cmd":
      case "command":
      case "d":
        meta = true;
        break;
      case "s":
      case "shift":
        shift = true;
        break;
      default:
        throw new KeyNotationError(
          original,
          `unknown modifier "${part}" in ${original}`,
        );
    }
  }

  const lowered = last.toLowerCase();
  const char = last.length === 1
    ? last
    : NAME_ALIASES.get(lowered) ?? (isFunctionKey(lowered) ? lowered : lowered);

  if (
    char.length > 1 && ![...NAMED_KEYS.values()].includes(char) &&
    !isFunctionKey(char)
  ) {
    throw new KeyNotationError(
      original,
      `unknown key name "${last}" in ${original}`,
    );
  }

  return {
    notation: renderKey({ char, ctrl, alt, meta, shift }),
    char,
    ctrl,
    alt,
    meta,
    shift,
  };
};

const renderKey = (
  key: Omit<ParsedKey, "notation">,
): string => {
  const named = isNamedChar(key.char);
  const upper = key.char.toUpperCase();
  // Folding shift into the character only works where the character *has* an
  // uppercase form. On a digit or a punctuation mark `toUpperCase()` is the
  // identity, so `<c-s-1>` silently canonicalised to `<c-1>` — dead, and
  // colliding with any real `<c-1>` binding. Keep the modifier explicit there.
  const foldable = !named && key.shift && upper !== key.char;

  const modifiers: ModifierLetter[] = [];
  if (key.ctrl) modifiers.push("c");
  if (key.alt) modifiers.push("a");
  if (key.meta) modifiers.push("m");
  if (key.shift && !foldable) modifiers.push("s");

  const char = foldable ? upper : key.char;
  if (modifiers.length === 0 && !named) return char;
  return `<${[...modifiers, char].join("-")}>`;
};

const literalKey = (char: string): ParsedKey => ({
  notation: char,
  char,
  ctrl: false,
  alt: false,
  meta: false,
  shift: false,
});

/**
 * Split a mapping's key sequence into individual keys.
 *
 * `"<c-a>gg"` → `["<c-a>", "g", "g"]`. Throws `KeyNotationError` on malformed
 * input so that the mapping parser can attribute the failure to a line number.
 */
export const parseKeySequence = (input: string): readonly ParsedKey[] => {
  const keys: ParsedKey[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (char === undefined) break;

    if (char === "<") {
      // `<` is only special when it plausibly opens a named key. `<<` (upstream's
      // `moveTabLeft` binding) and a trailing `<` are literal characters, which
      // matches Vimium's parser. An unterminated `<c-a` is still an error,
      // because silently reinterpreting it as four separate keys is far worse
      // than telling the user which line to fix. `<lt>` remains available for an
      // unambiguous literal.
      const following = input[index + 1];
      if (following === "<" || following === ">" || following === undefined) {
        keys.push(literalKey(char));
        index += 1;
        continue;
      }

      const close = input.indexOf(">", index + 1);
      if (close === -1) {
        throw new KeyNotationError(
          input,
          `unterminated "<" at position ${index}`,
        );
      }
      const body = input.slice(index + 1, close);
      if (body.length === 0) {
        throw new KeyNotationError(input, `empty "<>" at position ${index}`);
      }
      // A bare `<x>` with no modifier is a named key, e.g. `<esc>`; the same
      // parser handles it, since splitting on `-` yields a single segment.
      keys.push(parseAngleKey(body, input.slice(index, close + 1)));
      index = close + 1;
      continue;
    }

    keys.push(literalKey(char));
    index += 1;
  }

  if (keys.length === 0) {
    throw new KeyNotationError(input, "empty key sequence");
  }
  return keys;
};

/** The canonical notation string for each key in a sequence. */
export const normaliseKeySequence = (input: string): readonly string[] =>
  parseKeySequence(input).map((key) => key.notation);

// ---------------------------------------------------------------------------
// Safari reserved shortcuts
// ---------------------------------------------------------------------------

export interface ReservedShortcut {
  readonly notation: string;
  readonly reason: string;
}

/**
 * Combinations for which Safari never dispatches a `keydown` to the page.
 *
 * `preventDefault()` is irrelevant here — the event does not arrive at all
 * (w3c/uievents#65), so a binding on one of these can never fire. The mapping
 * parser rejects them outright rather than accepting a binding that is dead on
 * arrival.
 */
export const SAFARI_RESERVED: readonly ReservedShortcut[] = [
  { notation: "<m-n>", reason: "Safari: New Window" },
  { notation: "<m-w>", reason: "Safari: Close Tab" },
  { notation: "<m-q>", reason: "macOS: Quit" },
  { notation: "<m-t>", reason: "Safari: New Tab" },
  { notation: "<m-r>", reason: "Safari: Reload" },
  { notation: "<m-l>", reason: "Safari: focus the address bar" },
  { notation: "<c-tab>", reason: "Safari: Next Tab" },
  { notation: "<c-s-tab>", reason: "Safari: Previous Tab" },
];

const RESERVED_BY_NOTATION: ReadonlyMap<string, string> = new Map(
  SAFARI_RESERVED.map((entry) => [entry.notation, entry.reason]),
);

/**
 * Why this combination never reaches the page on Safari, or `null`.
 *
 * Matched case-sensitively on the canonical notation. Lowercasing the lookup
 * would answer `<m-T>` (Reopen Last Closed Tab) with the reason recorded for
 * `<m-t>` (New Tab) — the right verdict for the wrong reason, and the wrong
 * verdict for any shifted combination whose unshifted twin happens to be
 * reserved.
 */
export const reservedReason = (notation: string): string | null =>
  RESERVED_BY_NOTATION.get(notation) ?? null;

/**
 * Is this notation an explicit shift on a character that shift *changes*?
 *
 * `<c-s-1>` is such a case: a real `Ctrl+Shift+1` reports `event.key === "!"`
 * on a US layout, so the binding can never fire however it is canonicalised.
 * The layout dependence is the reason this is a warning rather than an error —
 * on some layouts the shifted digit really is the digit.
 */
export const shiftedNonLetter = (notation: string): boolean => {
  const match = /^<(?:[cam]-)*s-(.)>$/u.exec(notation);
  const char = match?.[1];
  if (char === undefined) return false;
  return char.toUpperCase() === char.toLowerCase();
};

/**
 * Combinations Safari *does* deliver on macOS but which
 * [WebKit bug 191768](https://bugs.webkit.org/show_bug.cgi?id=191768) suggests
 * may be unpreventable on iOS. Allowed, but flagged in the help dialog.
 */
export const IOS_UNCERTAIN: ReadonlySet<string> = new Set([
  "<m-s>",
  "<m-p>",
  "<m-f>",
  "<m-d>",
]);
