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

import { Array, Boolean, Match, Option, Record, Result, Schema, Struct, flow, pipe } from "effect";

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
export class KeyNotationError extends Schema.TaggedError<KeyNotationError>()("KeyNotationError", {
  input: Schema.String,
  detail: Schema.String,
}) {}

const notationError = (input: string, detail: string): KeyNotationError =>
  new KeyNotationError({ input, detail });

// ---------------------------------------------------------------------------
// Named keys
// ---------------------------------------------------------------------------

/** `event.key` to the name that is used inside `<...>`. */
const NAMED_KEYS: Record.ReadonlyRecord<string, string> = {
  " ": "space",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Enter: "enter",
  Escape: "esc",
  Backspace: "backspace",
  Delete: "delete",
  Tab: "tab",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  Insert: "insert",
};

/** The canonical names, for the check in `parseAngleKey`. */
const NAMED_VALUES: ReadonlyArray<string> = Record.values(NAMED_KEYS);

/** Names that are accepted when a mapping is parsed, folded onto the canonical name. */
const NAME_ALIASES: Record.ReadonlyRecord<string, string> = {
  escape: "esc",
  return: "enter",
  cr: "enter",
  bs: "backspace",
  del: "delete",
  spc: "space",
  pgup: "pageup",
  pgdn: "pagedown",
  pagedn: "pagedown",
  ins: "insert",
  lt: "<",
};

/** A function key in notation, `f1` to `f24`. */
const isFunctionKey = (key: string): boolean => /^f([1-9]|1\d|2[0-4])$/.test(key);

/** A function key as `event.key` names it, `F1` to `F24`. */
const isFunctionKeyName = (key: string): boolean => /^F([1-9]|1\d|2[0-4])$/.test(key);

// ---------------------------------------------------------------------------
// Code points
// ---------------------------------------------------------------------------

/**
 * The code points of a string.
 *
 * A key can be outside the Basic Multilingual Plane. An emoji and a
 * mathematical letter are each one character, and each one holds two UTF-16
 * units. A walk over the units gives two halves, and neither half can match a
 * key that the user pressed.
 */
const codePoints = (value: string): ReadonlyArray<string> => Array.fromIterable(value);

/** How many characters a string holds, counted by code point. */
const charCount = (value: string): number => codePoints(value).length;

const isSingleChar = (value: string): boolean => charCount(value) === 1;

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
const isAppKitFunctionKey = (code: number): boolean => code >= 0xf704 && code <= 0xf726;

const appKitFunctionKey = flow(
  Option.liftPredicate(isAppKitFunctionKey),
  Option.map((code) => `F${code - 0xf704 + 1}`),
);

/** The `event.key` that an AppKit code point stands for. */
const appKitKey = (code: number): Option.Option<string> =>
  pipe(
    APPKIT_PUA.get(code),
    Option.fromUndefinedOr,
    Option.orElse(() => appKitFunctionKey(code)),
  );

export const normaliseAppKitKey = (key: string): string =>
  pipe(
    key,
    Option.liftPredicate(isSingleChar),
    Option.flatMap((char) => pipe(char.codePointAt(0), Option.fromUndefinedOr)),
    Option.filter((code) => code >= 0xf700 && code <= 0xf8ff),
    Option.flatMap(appKitKey),
    Option.getOrElse(() => key),
  );

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

export const isModifierKey = (event: KeyEventLike): boolean => MODIFIER_KEYS.has(event.key);

/**
 * Is the user in an IME composition or a dead-key composition?
 *
 * `keyCode === 229` is the old signal. It stays correct on engines and input
 * methods where `isComposing` is not reliable. Both are read, because a missed
 * guard makes Vimium-WebKit eat keystrokes during a composition. That is the
 * worst failure for a user of a CJK input method.
 *
 * A dead key is not such a composition on the first press. Measured in a
 * WebKit view with the macOS layout data: `Option+E` on a US layout gives
 * `key: "Dead"`, `keyCode: 69` and `isComposing: false`. The event therefore
 * reaches `keyChar`, and `<a-e>` runs. The key that follows the dead key is a
 * composition, and this guard drops it.
 */
export const isComposing = (event: KeyEventLike): boolean =>
  event.isComposing === true || event.keyCode === 229;

// ---------------------------------------------------------------------------
// macOS Option chords
// ---------------------------------------------------------------------------

/**
 * The character that a Windows virtual key code names.
 *
 * WebKit on macOS builds `event.keyCode` from `charactersIgnoringModifiers`.
 * This is the character of the active layout with no Option and no Command.
 *
 * WebKit's `windowsKeyCodeForKeyEvent` first maps the character code. It then
 * uses the US position table when that mapping gives no code.
 *
 * Measured in a real WebKit view, one row for each entry. See the table in
 * `test/unit/key_test.ts`.
 */
const KEY_CODE_CHARACTERS: ReadonlyMap<number, string> = new Map([
  [32, " "],
  [186, ";"],
  [187, "="],
  [188, ","],
  [189, "-"],
  [190, "."],
  [191, "/"],
  [192, "`"],
  [219, "["],
  [220, "\\"],
  [221, "]"],
  [222, "'"],
]);

/**
 * The character that a physical key gives with no modifier, per `event.code`.
 *
 * The table names the US positions. It is the fallback of the Option rule, for
 * an event that carries no `keyCode`. The letters and the digits follow a
 * pattern, so `codeCharacter` reads them from the code itself.
 */
const CODE_CHARACTERS: Record.ReadonlyRecord<string, string> = {
  Space: " ",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** Is this one ASCII letter? */
const isAsciiLetter = (key: string): boolean => key.length === 1 && key >= "a" && key <= "z";

/**
 * The character of the layout, from the legacy `event.keyCode`.
 *
 * `keyCode` is deprecated, and it is read here for one reason: it is the only
 * field of a `KeyboardEvent` that carries the *unmodified* character of the
 * key. `event.key` carries the character with Option applied, and `event.code`
 * carries the US position of the key. Neither one is the key of the user.
 *
 * `Option.none()` means that the code names no character, as `0`, a function
 * key and an arrow key do.
 */
const keyCodeCharacter = (keyCode: number): Option.Option<string> =>
  pipe(
    Match.value(keyCode),
    Match.when(
      (code) => code >= 65 && code <= 90,
      (code) => Option.some(String.fromCharCode(code + 32)),
    ),
    Match.when(
      (code) => code >= 48 && code <= 57,
      (code) => Option.some(String.fromCharCode(code)),
    ),
    Match.orElse((code) => pipe(KEY_CODE_CHARACTERS.get(code), Option.fromUndefinedOr)),
  );

/** The character of the US physical position, from `event.code`. */
const codeCharacter = (code: string): Option.Option<string> =>
  pipe(
    Match.value(code),
    Match.when(
      (position) => position.length === 4 && position.startsWith("Key"),
      (position) => Option.some(position.slice(3).toLowerCase()),
    ),
    Match.when(
      (position) => position.length === 6 && position.startsWith("Digit"),
      (position) => Option.some(position.slice(5)),
    ),
    Match.orElse((position) => pipe(CODE_CHARACTERS, Record.get(position))),
  );

/**
 * The character that the key makes with no modifier: the layout first, from
 * `event.keyCode`, and the US position after it, from `event.code`.
 */
const unmodifiedCharacter = (event: KeyEventLike): Option.Option<string> =>
  pipe(
    event.keyCode,
    Option.fromUndefinedOr,
    Option.flatMap(keyCodeCharacter),
    Option.orElse(() => pipe(event.code, Option.fromUndefinedOr, Option.flatMap(codeCharacter))),
  );

/**
 * The character of the physical key for an Option chord on an Apple platform.
 *
 * macOS applies Option to the character. `Option+F` reports `event.key` as
 * `\u0192`, and `Option+E` reports `Dead`. A mapping file names `<a-f>`, so
 * every shipped Option binding was dead on the main platform.
 *
 * The rule takes the character that the physical key makes under the active
 * layout with no modifier. `event.keyCode` carries it, and `event.code` does
 * not: `event.code` is the US position, so it gives `<a-q>` for the A key of a
 * French layout and `<a-y>` for the F key of a Dvorak layout.
 *
 * The sources, in order, and the cost of each one:
 *
 * 1. `event.key` for `IntlBackslash`. Its `keyCode` aliases Backquote on an ISO
 *    keyboard, so the event character prevents two keys from colliding.
 * 2. `event.keyCode`. The character of the layout for a Latin layout. For a
 *    layout that is not Latin, WebKit falls back to the US position. A
 *    Cyrillic or a Greek key therefore gives the letter of the position.
 * 3. `event.code`, when the event carries no `keyCode`. It is the US position
 *    always, so it is wrong on Dvorak, AZERTY and QWERTZ.
 * 4. `event.key`, through `Option.none()`. It is usually the Option glyph,
 *    which the user cannot write in a mapping file.
 *
 * Three guards hold:
 *
 * 1. Apple platforms only. On Windows and on Linux, Alt does not change the
 *    character, so a Cyrillic, Greek or Hebrew letter must stay itself.
 * 2. A chord with Ctrl keeps its character. WebKit already reports the plain
 *    character for `Ctrl+Option+F`, and AltGr on Windows makes text.
 * 3. With Shift only a letter is translated. `keyCode` gives the unshifted
 *    character, so a shifted digit would fold `Option+Shift+1` onto `<a-1>`,
 *    which is the notation of `Option+1`. Two chords cannot share a binding.
 *
 * `Option.none()` means that the event is not such a chord.
 */
const appleAltKey = (event: KeyEventLike, applePlatform: boolean): Option.Option<string> =>
  pipe(
    event,
    Option.liftPredicate(
      (chord) => applePlatform && chord.altKey && !chord.ctrlKey && chord.code !== "IntlBackslash",
    ),
    Option.flatMap(unmodifiedCharacter),
    Option.filter((char) => !event.shiftKey || isAsciiLetter(char)),
  );

/**
 * What the reader of a key must know about the machine and the settings.
 *
 * Both values come from the caller, so this module stays pure. `domain/` may
 * not read `navigator`, and a key rule that changes with the platform still
 * needs the platform.
 */
export interface KeyContext {
  /** Bind the physical position, and not the character of the layout. */
  readonly ignoreKeyboardLayout: boolean;
  /**
   * Is this macOS, iOS or iPadOS?
   *
   * Only there does Alt change the character that the key makes. See
   * `appleAltKey`.
   */
  readonly applePlatform: boolean;
}

/** No layout option, and no Apple rule. For a test, and for a plain caller. */
export const PLAIN_KEY_CONTEXT: KeyContext = {
  ignoreKeyboardLayout: false,
  applePlatform: false,
};

/** Keep the old layout flag for callers that do not read platform data. */
const readKeyContext = (context: KeyContext | boolean): KeyContext =>
  pipe(
    Match.value(context),
    Match.when(Match.boolean, (ignoreKeyboardLayout) => ({
      ignoreKeyboardLayout,
      applePlatform: false,
    })),
    Match.orElse((offered) => offered),
  );

/**
 * The character of the physical position, when the layout is ignored.
 *
 * `Option.none()` means that the position does not decide, and the character
 * of the layout decides instead.
 */
const physicalChar = (event: KeyEventLike, context: KeyContext): Option.Option<string> =>
  pipe(
    event.code,
    Option.fromUndefinedOr,
    Option.filter((code) => context.ignoreKeyboardLayout && code.length > 0),
    Option.flatMap((code) =>
      pipe(
        Match.value(code),
        Match.when(
          (position) => position.startsWith("Key"),
          (position) => Option.some(position.slice(3).toLowerCase()),
        ),
        // A shifted digit is the exception. The binding names the *character*,
        // so a fold of `Shift+4` back to `"4"` killed four shipped bindings
        // (`$`, `#`, `*` and `^`) and gave them to the count prefix. This
        // option is about physical positions, and the position of a shifted
        // digit is already clear from the character.
        Match.when(
          (position) => position.startsWith("Digit") && !event.shiftKey,
          (position) => Option.some(position.slice(5)),
        ),
        Match.when(
          (position) => position.startsWith("Numpad"),
          (position) => Option.some(numpadChar(position.slice(6), event.key)),
        ),
        Match.orElse(() => Option.none()),
      ),
    ),
  );

/**
 * The character of a numpad key.
 *
 * `NumpadDivide` and its kind are named keys, and not characters. A lowercase
 * of them gave `"divide"`, which no notation can write.
 */
const numpadChar = (suffix: string, key: string): string =>
  pipe(
    suffix,
    Option.liftPredicate((digit) => /^\d$/.test(digit)),
    Option.getOrElse(() => normaliseAppKitKey(key)),
  );

/**
 * The character of the layout.
 *
 * An Option chord on macOS reports a glyph. The character of the layout
 * decides there, so `map <a-f> ...` still names the F key of the user.
 */
const layoutChar = (event: KeyEventLike, context: KeyContext): Option.Option<string> =>
  pipe(
    appleAltKey(event, context.applePlatform),
    Option.getOrElse(() => event.key),
    normaliseAppKitKey,
    Option.liftPredicate((key) => key.length > 0 && key !== "Unidentified"),
    Option.map(namedChar),
  );

/** The short name of a named key or a function key. Any other key is its character. */
const namedChar = (key: string): string =>
  pipe(
    NAMED_KEYS,
    Record.get(key),
    Option.orElse(() =>
      pipe(
        key,
        Option.liftPredicate(isFunctionKeyName),
        Option.map((name) => name.toLowerCase()),
      ),
    ),
    Option.getOrElse(() => key),
  );

/**
 * Give the base character. The active keyboard layout can be ignored.
 *
 * With `ignoreKeyboardLayout` the physical `event.code` wins. A Dvorak or a
 * Cyrillic layout then still drives the bindings at the QWERTY positions.
 *
 * An Option chord on an Apple platform is the other case that does not use
 * `event.key`. See `appleAltKey`.
 *
 * `Option.none()` means that the event carries no character.
 */
export const keyChar = (
  event: KeyEventLike,
  offeredContext: KeyContext | boolean,
): Option.Option<string> =>
  pipe(
    event,
    Option.liftPredicate((press) => !isModifierKey(press)),
    Option.flatMap((press) => {
      const context = readKeyContext(offeredContext);
      return pipe(
        physicalChar(press, context),
        Option.orElse(() => layoutChar(press, context)),
      );
    }),
  );

/**
 * The canonical modifier order.
 *
 * The order of the output is always this one, so a trie key is stable. A
 * *parse* ignores the order, so a hand-written `<a-c-x>` still works.
 */
type ModifierLetter = "c" | "a" | "m" | "s";

/** The modifiers that a key holds. */
interface Modifiers {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

/** The letters of the held modifiers, in the canonical order. */
const modifierLetters = ({ ctrl, alt, meta, shift }: Modifiers): ReadonlyArray<ModifierLetter> =>
  pipe(
    [
      [ctrl, "c"],
      [alt, "a"],
      [meta, "m"],
      [shift, "s"],
    ] as const,
    Array.filter(([held]) => held),
    Array.map(([, letter]) => letter),
  );

const isNamedChar = (char: string): boolean =>
  charCount(char) > 1 || pipe(NAMED_KEYS, Record.has(char)) || isFunctionKey(char);

/**
 * Write one key.
 *
 * A character with no modifier stands alone. A named key and every chord go
 * inside `<...>`. `named` belongs to the character before any shift fold.
 */
const writeKey =
  (char: string, named: boolean) =>
  (modifiers: Modifiers): string => {
    const letters = modifierLetters(modifiers);
    return pipe(
      Array.isReadonlyArrayEmpty(letters) && !named,
      Boolean.match({
        onFalse: () => pipe(letters, Array.append(char), Array.join("-"), (body) => `<${body}>`),
        onTrue: () => char,
      }),
    );
  };

/**
 * Write the key of an event.
 *
 * Shift is folded into a character that is not a named key. Under
 * `ignoreKeyboardLayout`, and for an Option chord on an Apple platform, the
 * character does not carry the shift, so the fold applies it here.
 */
const eventNotation = (event: KeyEventLike, char: string): string => {
  const named = isNamedChar(char);
  const held: Modifiers = {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  };
  return pipe(
    event.shiftKey && !named,
    Boolean.match({
      onFalse: () => pipe(held, writeKey(char, named)),
      onTrue: () =>
        pipe(held, Struct.assign({ shift: false }), writeKey(char.toUpperCase(), named)),
    }),
  );
};

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
  context: KeyContext | boolean = PLAIN_KEY_CONTEXT,
): Option.Option<string> =>
  pipe(
    keyChar(event, context),
    Option.map((char) => eventNotation(event, char)),
  );

// ---------------------------------------------------------------------------
// Notation parsing
// ---------------------------------------------------------------------------

export interface ParsedKey extends Modifiers {
  readonly notation: string;
  readonly char: string;
}

/** A parsed key before it has a notation. */
type Chord = Omit<ParsedKey, "notation">;

const renderKey = (key: Chord): string => {
  const named = isNamedChar(key.char);
  return pipe(
    key.char.toUpperCase(),
    // A fold of shift into the character works only where the character
    // *has* an uppercase form. On a digit or on a punctuation mark
    // `toUpperCase()` is the identity, so `<c-s-1>` became `<c-1>` without a
    // message. That binding is dead, and it collides with a real `<c-1>`
    // binding. Keep the modifier.
    Option.liftPredicate((upper) => key.shift && !named && upper !== key.char),
    Option.match({
      onNone: () => pipe(key, writeKey(key.char, named)),
      onSome: (upper) => pipe(key, Struct.assign({ shift: false }), writeKey(upper, named)),
    }),
  );
};

/** Every name that a modifier goes by, and the modifier that it names. */
const MODIFIER_NAMES: Record.ReadonlyRecord<string, keyof Modifiers> = {
  c: "ctrl",
  ctrl: "ctrl",
  control: "ctrl",
  a: "alt",
  alt: "alt",
  opt: "alt",
  option: "alt",
  m: "meta",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  d: "meta",
  s: "shift",
  shift: "shift",
};

/** A `-` between two segments. The last segment can be `-` itself, as in `<c-->`. */
const SEGMENT_SEPARATOR = /-(?!$)/;

const modifierOf =
  (original: string) =>
  (part: string): Result.Result<keyof Modifiers, KeyNotationError> =>
    pipe(
      MODIFIER_NAMES,
      Record.get(part.toLowerCase()),
      Result.fromOption(() => notationError(original, `unknown modifier "${part}" in ${original}`)),
    );

/** The canonical name of the key segment. A single character stays itself. */
const keyName = (segment: string): string =>
  pipe(
    segment,
    Option.liftPredicate(isSingleChar),
    Option.orElse(() => pipe(NAME_ALIASES, Record.get(segment.toLowerCase()))),
    Option.getOrElse(() => segment.toLowerCase()),
  );

/** Can a key of this name ever arrive? */
const isKnownChar = (char: string): boolean =>
  charCount(char) <= 1 || pipe(NAMED_VALUES, Array.contains(char)) || isFunctionKey(char);

const readChord = (
  modifierNames: ReadonlyArray<string>,
  segment: string,
  original: string,
): Result.Result<ParsedKey, KeyNotationError> =>
  Result.gen(function* () {
    const named = yield* pipe(modifierNames, Array.map(modifierOf(original)), Result.all);
    const char = yield* pipe(
      keyName(segment),
      Result.liftPredicate(isKnownChar, () =>
        notationError(original, `unknown key name "${segment}" in ${original}`),
      ),
    );
    const holds = (modifier: keyof Modifiers): boolean => pipe(named, Array.contains(modifier));
    const chord: Chord = {
      char,
      ctrl: holds("ctrl"),
      alt: holds("alt"),
      meta: holds("meta"),
      shift: holds("shift"),
    };
    return pipe(chord, Struct.assign({ notation: renderKey(chord) }));
  });

const parseAngleKey = (
  body: string,
  original: string,
): Result.Result<ParsedKey, KeyNotationError> =>
  pipe(
    body.split(SEGMENT_SEPARATOR),
    Array.matchRight({
      onEmpty: () => Result.fail(notationError(original, `${original} has no key`)),
      onNonEmpty: (modifierNames, segment) => readChord(modifierNames, segment, original),
    }),
  );

const literalKey = (char: string): ParsedKey => ({
  notation: char,
  char,
  ctrl: false,
  alt: false,
  meta: false,
  shift: false,
});

/**
 * One key as the user wrote it: a `<...>` group, an unterminated `<...`, or
 * one character.
 *
 * `<` is special only when it can open a named key. `<<` (the upstream binding
 * for `moveTabLeft`) and a final `<` are literal characters, as in Vimium's own
 * parser. An unterminated `<c-a` is still an error, because a silent change
 * into four separate keys is much worse than a message that names the line to
 * correct. `<lt>` stays available for a literal with no doubt.
 *
 * The match is over code points, and not over UTF-16 units. A walk over the
 * units cuts an emoji into two halves, and each half becomes a key of its own.
 * Such a key can never match a press.
 */
const KEY_TOKEN = /<[^<>][^>]*>|<[^<>][^>]*$|./gsu;

const readToken =
  (input: string) =>
  (token: RegExpExecArray): Result.Result<ParsedKey, KeyNotationError> => {
    const [text] = token;
    return pipe(
      Match.value(text),
      Match.when(isSingleChar, (char) => Result.succeed(literalKey(char))),
      // A `<x>` with no modifier is a named key, for example `<esc>`. The same
      // parser reads it, because a split on `-` gives one segment.
      Match.when(
        (group) => group.endsWith(">"),
        (group) => parseAngleKey(group.slice(1, -1), group),
      ),
      // A position in a message is a character position, as the match is.
      Match.orElse(() =>
        Result.fail(
          notationError(
            input,
            `unterminated "<" at position ${charCount(input.slice(0, token.index))}`,
          ),
        ),
      ),
    );
  };

/**
 * Split the key sequence of a mapping into single keys.
 *
 * `"<c-a>gg"` becomes `["<c-a>", "g", "g"]`. Bad input gives a
 * `KeyNotationError` in the failure channel, so the mapping parser can add the
 * line number to it.
 */
export const parseKeySequence = (
  input: string,
): Result.Result<Array.NonEmptyReadonlyArray<ParsedKey>, KeyNotationError> =>
  pipe(
    input.matchAll(KEY_TOKEN),
    Array.fromIterable,
    Array.map(readToken(input)),
    Result.all,
    Result.flatMap(
      Array.match({
        onEmpty: () => Result.fail(notationError(input, "empty key sequence")),
        onNonEmpty: (keys) => Result.succeed(keys),
      }),
    ),
  );

/** The canonical notation of each key in a sequence. */
export const normaliseKeySequence = flow(
  parseKeySequence,
  Result.map(Array.map((key) => key.notation)),
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

/**
 * Why this combination never reaches the page on Safari.
 *
 * The canonical notation is matched with attention to case. A lookup in lower
 * case would answer `<m-T>` (Reopen Last Closed Tab) with the reason of
 * `<m-t>` (New Tab). That is the correct verdict for the wrong reason, and the
 * wrong verdict for a shifted combination whose unshifted twin is reserved.
 */
export const reservedReason = (notation: string): Option.Option<string> =>
  pipe(
    SAFARI_RESERVED,
    Array.findFirst((entry) => entry.notation === notation),
    Option.map((entry) => entry.reason),
  );

/** A notation with an explicit shift on one character. */
const SHIFTED_CHORD = /^<(?:[cam]-)*s-(.)>$/u;

/**
 * Does this notation name an explicit shift on a character that shift changes?
 *
 * `<c-s-1>` is such a case. A true `Ctrl+Shift+1` reports `event.key === "!"`
 * on a US layout, so the binding can never run, whatever the canonical form
 * is. The result depends on the layout, which is why this is a warning and not
 * an error. On some layouts the shifted digit is the digit.
 */
export const shiftedNonLetter = (notation: string): boolean =>
  pipe(
    SHIFTED_CHORD.exec(notation),
    Option.fromNullishOr,
    Option.flatMap(Array.get(1)),
    Option.exists((char) => char.toUpperCase() === char.toLowerCase()),
  );

/**
 * Combinations that Safari *does* send on macOS, but which
 * [WebKit bug 191768](https://bugs.webkit.org/show_bug.cgi?id=191768) shows
 * can be unpreventable on iOS. They are permitted, and marked in the help
 * dialog.
 */
export const IOS_UNCERTAIN: ReadonlySet<string> = new Set(["<m-s>", "<m-p>", "<m-f>", "<m-d>"]);

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
export const isCountDigit = (notation: string, started: boolean): boolean =>
  isSingleChar(notation) && notation >= lowestCountDigit(started) && notation <= "9";

const lowestCountDigit = Boolean.match({ onFalse: () => "1", onTrue: () => "0" });

/** Add one digit to a count. The result stops at `MAX_COUNT`. */
export const appendCountDigit = (current: number, notation: string): number =>
  Math.min(MAX_COUNT, current * 10 + Number(notation));
