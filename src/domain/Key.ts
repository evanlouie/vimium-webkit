/**
 * Key notation: `KeyboardEvent` to `"<c-a>"`, and back. Plus the count prefix.
 *
 * Derived from upstream Vimium's `lib/keyboard_utils.js` (MIT), which credits
 * the `vim-like-key-notation` project. The behaviour is kept, so an existing
 * Vimium `map` line works without a change.
 *
 * WebKit additions are at the bottom: the AppKit private-use-area
 * normalisation that iOS hardware keyboards need, and the reserved-shortcut
 * table that the mapping parser refuses against.
 *
 * This module is pure. An absent value is an `Option`. A failure is a
 * `Result` with a `KeyNotationError`. Nothing here throws.
 */

import { Option, Result, Schema } from "effect";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The notation cannot be read.
 *
 * `input` is the text that the user wrote. `detail` says what is wrong with
 * it. The mapping parser adds the line number, which this module does not
 * know.
 */
export class KeyNotationError
  extends Schema.TaggedErrorClass<KeyNotationError>()("KeyNotationError", {
    input: Schema.String,
    detail: Schema.String,
  })
{}

// ---------------------------------------------------------------------------
// Named keys
// ---------------------------------------------------------------------------

/** `event.key` to the name that is used inside `<...>`. */
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

/** The canonical names, for the check in `parseAngleKey`. */
const NAMED_VALUES: ReadonlySet<string> = new Set(NAMED_KEYS.values());

/** Names that are accepted when a mapping is parsed, folded onto the canonical name. */
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
 * iOS sends special keys from a hardware keyboard as AppKit function-key code
 * points in the Unicode private use area (U+F700 to U+F8FF). It does not send
 * a named `event.key`. This table is the mirror of WebKit r236678.
 *
 * Without this table an `<up>`, `<down>` or `<esc>` mapping is dead on an iPad
 * with a Magic Keyboard, but correct on macOS. No user can report that
 * difference.
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

/** U+F704 to U+F726 are F1 to F35. */
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
// Event to notation
// ---------------------------------------------------------------------------

/** The part of `KeyboardEvent` that this module uses. It keeps the module pure. */
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
 * Is the user in an IME composition or a dead-key composition?
 *
 * `keyCode === 229` is the old signal. It stays correct on engines and input
 * methods where `isComposing` is not reliable. Both are read, because a missed
 * guard makes Vimium-WebKit eat keystrokes during a composition. That is the
 * worst failure for a user of a CJK input method.
 */
export const isComposing = (event: KeyEventLike): boolean =>
  event.isComposing === true || event.keyCode === 229;

// ---------------------------------------------------------------------------
// macOS Option chords
// ---------------------------------------------------------------------------

/**
 * The character that a physical key gives with no modifier, per `event.code`.
 *
 * The table names the US positions. It is used for an Option chord only, where
 * the character that macOS reports is a glyph that nobody can write in a
 * mapping file.
 */
const CODE_CHARACTERS: ReadonlyMap<string, string> = new Map([
  ["Minus", "-"],
  ["Equal", "="],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Backslash", "\\"],
  ["Semicolon", ";"],
  ["Quote", "'"],
  ["Backquote", "`"],
  ["Comma", ","],
  ["Period", "."],
  ["Slash", "/"],
]);

/** Is this a single printable ASCII character? */
const isAsciiPrintable = (key: string): boolean =>
  key.length === 1 && key >= "\u0020" && key <= "\u007e";

/**
 * The character of the physical key for an Option chord on macOS.
 *
 * macOS applies Option to the character. `Option+F` reports `event.key` as
 * `\u0192`, and `Option+E` reports `Dead`. A mapping file names `<a-f>`, so
 * every shipped Option binding was dead on the main platform.
 *
 * Three guards keep the documented layout behaviour:
 *
 * 1. The rule applies only when the reported character is not printable ASCII.
 *    A layout that gives a plain letter for an Alt chord, as X11 and Windows
 *    do, keeps its own character.
 * 2. A chord with Ctrl keeps its character. AltGr is Ctrl plus Alt on Windows,
 *    and it makes text.
 * 3. With Shift only a letter is translated. The character of a shifted digit
 *    or of shifted punctuation depends on the layout, and `event.code` does
 *    not carry it.
 *
 * `Option.none()` means that the event is not such a chord.
 */
const appleAltKey = (event: KeyEventLike): Option.Option<string> => {
  if (!event.altKey || event.ctrlKey) return Option.none();
  const code = event.code;
  if (code === undefined || isAsciiPrintable(event.key)) return Option.none();

  if (code.length === 4 && code.startsWith("Key")) {
    return Option.some(code.slice(3).toLowerCase());
  }
  if (event.shiftKey) return Option.none();
  if (code === "Space") return Option.some(" ");
  if (code.length === 6 && code.startsWith("Digit")) {
    return Option.some(code.slice(5));
  }
  return Option.fromNullishOr(CODE_CHARACTERS.get(code) ?? null);
};

/**
 * Give the base character. The active keyboard layout can be ignored.
 *
 * With `ignoreKeyboardLayout` the physical `event.code` wins. A Dvorak or a
 * Cyrillic layout then still drives the bindings at the QWERTY positions.
 *
 * An Option chord on macOS is the other case that reads `event.code`. See
 * `appleAltKey`.
 *
 * `Option.none()` means that the event carries no character.
 */
export const keyChar = (
  event: KeyEventLike,
  ignoreKeyboardLayout: boolean,
): Option.Option<string> => {
  if (isModifierKey(event)) return Option.none();

  if (ignoreKeyboardLayout && event.code) {
    const code = event.code;
    if (code.startsWith("Key")) return Option.some(code.slice(3).toLowerCase());
    // A shifted digit is the exception. The binding names the *character*, so
    // a fold of `Shift+4` back to `"4"` killed four shipped bindings (`$`,
    // `#`, `*` and `^`) and gave them to the count prefix. This option is
    // about physical positions, and the position of a shifted digit is already
    // clear from the character.
    if (code.startsWith("Digit") && !event.shiftKey) {
      return Option.some(code.slice(5));
    }
    if (code.startsWith("Numpad")) {
      const suffix = code.slice(6);
      // `NumpadDivide` and its kind are named keys, and not characters. A
      // lowercase of them gave `"divide"`, which no notation can write.
      return Option.some(
        /^\d$/.test(suffix) ? suffix : normaliseAppKitKey(event.key),
      );
    }
  }

  // An Option chord on macOS reports a glyph. The physical key decides there,
  // so `map <a-f> ...` still names the F key.
  const raw = Option.getOrElse(appleAltKey(event), () => event.key);

  const key = normaliseAppKitKey(raw);
  if (key.length === 0 || key === "Unidentified") return Option.none();

  const named = NAMED_KEYS.get(key);
  if (named !== undefined) return Option.some(named);
  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) return Option.some(key.toLowerCase());
  return Option.some(key);
};

/**
 * The canonical modifier order.
 *
 * The order of the output is always this one, so a trie key is stable. A
 * *parse* ignores the order, so a hand-written `<a-c-x>` still works.
 */
type ModifierLetter = "c" | "a" | "m" | "s";

const isNamedChar = (char: string): boolean =>
  char.length > 1 || NAMED_KEYS.has(char) || isFunctionKey(char);

/**
 * Write an event as Vimium key notation.
 *
 * `Shift` is folded into the character for a single printable character (`F`,
 * and not `<s-f>`). It is explicit for a named key (`<s-tab>`). This is what
 * upstream does, and what users write.
 *
 * This entry point is lenient: an event with no key gives `Option.none()`. It
 * is on the synchronous key path, where there is no failure to report.
 */
export const keyNotation = (
  event: KeyEventLike,
  ignoreKeyboardLayout = false,
): Option.Option<string> => {
  const base = keyChar(event, ignoreKeyboardLayout);
  if (Option.isNone(base)) return Option.none();
  let char = base.value;

  const named = isNamedChar(char);
  const modifiers: ModifierLetter[] = [];

  if (event.ctrlKey) modifiers.push("c");
  if (event.altKey) modifiers.push("a");
  if (event.metaKey) modifiers.push("m");
  if (event.shiftKey && named) modifiers.push("s");

  if (!named && char.length === 1 && event.shiftKey) {
    // Under `ignoreKeyboardLayout` the platform did not apply shift to a
    // character that comes from the layout. Apply it here.
    char = char.toUpperCase();
  }

  if (modifiers.length === 0 && !named) return Option.some(char);
  return Option.some(`<${[...modifiers, char].join("-")}>`);
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

const renderKey = (key: Omit<ParsedKey, "notation">): string => {
  const named = isNamedChar(key.char);
  const upper = key.char.toUpperCase();
  // A fold of shift into the character works only where the character *has* an
  // uppercase form. On a digit or on a punctuation mark `toUpperCase()` is the
  // identity, so `<c-s-1>` became `<c-1>` without a message. That binding is
  // dead, and it collides with a real `<c-1>` binding. Keep the modifier.
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

const parseAngleKey = (
  body: string,
  original: string,
): Result.Result<ParsedKey, KeyNotationError> => {
  // Split on `-`. The last segment can be `-` itself, as in `<c-->`.
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
    return Result.fail(
      new KeyNotationError({
        input: original,
        detail: `${original} has no key`,
      }),
    );
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
        return Result.fail(
          new KeyNotationError({
            input: original,
            detail: `unknown modifier "${part}" in ${original}`,
          }),
        );
    }
  }

  const lowered = last.toLowerCase();
  const char = last.length === 1
    ? last
    : NAME_ALIASES.get(lowered) ?? lowered;

  if (char.length > 1 && !NAMED_VALUES.has(char) && !isFunctionKey(char)) {
    return Result.fail(
      new KeyNotationError({
        input: original,
        detail: `unknown key name "${last}" in ${original}`,
      }),
    );
  }

  return Result.succeed({
    notation: renderKey({ char, ctrl, alt, meta, shift }),
    char,
    ctrl,
    alt,
    meta,
    shift,
  });
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
 * Split the key sequence of a mapping into single keys.
 *
 * `"<c-a>gg"` becomes `["<c-a>", "g", "g"]`. Bad input gives a
 * `KeyNotationError` in the failure channel, so the mapping parser can add the
 * line number to it.
 */
export const parseKeySequence = (
  input: string,
): Result.Result<readonly ParsedKey[], KeyNotationError> => {
  const keys: ParsedKey[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (char === undefined) break;

    if (char === "<") {
      // `<` is special only when it can open a named key. `<<` (the upstream
      // binding for `moveTabLeft`) and a final `<` are literal characters, as
      // in Vimium's own parser. An unterminated `<c-a` is still an error,
      // because a silent change into four separate keys is much worse than a
      // message that names the line to correct. `<lt>` stays available for a
      // literal with no doubt.
      const following = input[index + 1];
      if (following === "<" || following === ">" || following === undefined) {
        keys.push(literalKey(char));
        index += 1;
        continue;
      }

      const close = input.indexOf(">", index + 1);
      if (close === -1) {
        return Result.fail(
          new KeyNotationError({
            input,
            detail: `unterminated "<" at position ${index}`,
          }),
        );
      }
      const body = input.slice(index + 1, close);
      if (body.length === 0) {
        return Result.fail(
          new KeyNotationError({
            input,
            detail: `empty "<>" at position ${index}`,
          }),
        );
      }
      // A `<x>` with no modifier is a named key, for example `<esc>`. The same
      // parser reads it, because a split on `-` gives one segment.
      const parsed = parseAngleKey(body, input.slice(index, close + 1));
      if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
      keys.push(parsed.success);
      index = close + 1;
      continue;
    }

    keys.push(literalKey(char));
    index += 1;
  }

  if (keys.length === 0) {
    return Result.fail(
      new KeyNotationError({ input, detail: "empty key sequence" }),
    );
  }
  return Result.succeed(keys);
};

/** The canonical notation of each key in a sequence. */
export const normaliseKeySequence = (
  input: string,
): Result.Result<readonly string[], KeyNotationError> =>
  Result.map(
    parseKeySequence(input),
    (keys) => keys.map((key) => key.notation),
  );

// ---------------------------------------------------------------------------
// Safari reserved shortcuts
// ---------------------------------------------------------------------------

export interface ReservedShortcut {
  readonly notation: string;
  readonly reason: string;
}

/**
 * Combinations for which Safari sends no `keydown` to the page.
 *
 * `preventDefault()` has no meaning here. The event does not arrive at all
 * (w3c/uievents#65), so a binding on one of these can never run. The mapping
 * parser refuses them, instead of accepting a binding that is already dead.
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
 * Why this combination never reaches the page on Safari.
 *
 * The canonical notation is matched with attention to case. A lookup in lower
 * case would answer `<m-T>` (Reopen Last Closed Tab) with the reason of
 * `<m-t>` (New Tab). That is the correct verdict for the wrong reason, and the
 * wrong verdict for a shifted combination whose unshifted twin is reserved.
 */
export const reservedReason = (notation: string): Option.Option<string> =>
  Option.fromNullishOr(RESERVED_BY_NOTATION.get(notation) ?? null);

/**
 * Does this notation name an explicit shift on a character that shift changes?
 *
 * `<c-s-1>` is such a case. A true `Ctrl+Shift+1` reports `event.key === "!"`
 * on a US layout, so the binding can never run, whatever the canonical form
 * is. The result depends on the layout, which is why this is a warning and not
 * an error. On some layouts the shifted digit is the digit.
 */
export const shiftedNonLetter = (notation: string): boolean => {
  const match = /^<(?:[cam]-)*s-(.)>$/u.exec(notation);
  const char = match?.[1];
  if (char === undefined) return false;
  return char.toUpperCase() === char.toLowerCase();
};

/**
 * Combinations that Safari *does* send on macOS, but which
 * [WebKit bug 191768](https://bugs.webkit.org/show_bug.cgi?id=191768) shows
 * can be unpreventable on iOS. They are permitted, and marked in the help
 * dialog.
 */
export const IOS_UNCERTAIN: ReadonlySet<string> = new Set([
  "<m-s>",
  "<m-p>",
  "<m-f>",
  "<m-d>",
]);

// ---------------------------------------------------------------------------
// The count prefix
// ---------------------------------------------------------------------------

/**
 * One implementation of the count prefix, because there were two. Normal mode
 * stopped at 9999, with a comment that named the hang that the limit prevents.
 * Visual mode wrote the same parser again with no limit, and it also stopped
 * every keyboard event. Escape could therefore not end the freeze.
 */

/** The limit of the count prefix. `999999999G` must not hang a tab. */
export const MAX_COUNT = 9999;

/**
 * Is this key a count digit at this moment?
 *
 * `0` is a digit only after a count starts. Before that it is a key that the
 * user can bind. This is what makes the upstream `map 0 scrollToLeft` work.
 */
export const isCountDigit = (notation: string, started: boolean): boolean => {
  if (notation.length !== 1) return false;
  return started
    ? notation >= "0" && notation <= "9"
    : notation >= "1" && notation <= "9";
};

/** Add one digit to a count. The result stops at `MAX_COUNT`. */
export const appendCountDigit = (current: number, notation: string): number =>
  Math.min(MAX_COUNT, current * 10 + Number(notation));
