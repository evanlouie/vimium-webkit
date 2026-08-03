/**
 * Key notation.
 *
 * These are the rules that a user meets on the first line of their
 * configuration. A key that is written in one form must arrive in the same
 * form, and a bad line must give a value that names the fault.
 *
 * The parsers give a `Result`. A failure is a value here, so the test asserts
 * on `Result.isFailure` and reads the detail.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import {
  appendCountDigit,
  IOS_UNCERTAIN,
  isComposing,
  isCountDigit,
  isModifierKey,
  type KeyEventLike,
  keyNotation,
  MAX_COUNT,
  normaliseAppKitKey,
  normaliseKeySequence,
  parseKeySequence,
  reservedReason,
  SAFARI_RESERVED,
  shiftedNonLetter,
} from "~/domain/Key.ts";

/**
 * A keyboard event as this module sees it.
 *
 * `KeyEventLike` is a plain interface on purpose, so no DOM is needed. A test
 * that needs a true `KeyboardEvent` belongs in `test/e2e/`.
 */
const event = (
  partial: Partial<KeyEventLike> & { readonly key: string },
): KeyEventLike => ({
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...partial,
});

/** The notation of an event, or `null` when the event carries no key. */
const notation = (
  input: KeyEventLike,
  ignoreKeyboardLayout = false,
): string | null =>
  Option.getOrNull(
    keyNotation(input, { ignoreKeyboardLayout, applePlatform: false }),
  );

/** The notation that a macOS user sees, where Option changes the character. */
const appleNotation = (input: KeyEventLike): string | null =>
  Option.getOrNull(
    keyNotation(input, {
      ignoreKeyboardLayout: false,
      applePlatform: true,
    }),
  );

/** The canonical keys of a sequence, or `null` when the sequence is bad. */
const sequence = (input: string): readonly string[] | null =>
  Result.getOrNull(normaliseKeySequence(input));

describe("Key", () => {
  it.effect("writes a bare printable character with no wrapper", () =>
    Effect.sync(() => {
      assert.strictEqual(notation(event({ key: "j" })), "j");
      assert.strictEqual(notation(event({ key: "/" })), "/");
    }));

  it.effect("folds shift into a printable character", () =>
    Effect.sync(() => {
      assert.strictEqual(notation(event({ key: "G", shiftKey: true })), "G");
    }));

  it.effect("keeps shift explicit for a named key", () =>
    Effect.sync(() => {
      assert.strictEqual(
        notation(event({ key: "Tab", shiftKey: true })),
        "<s-tab>",
      );
    }));

  it.effect("writes the modifiers in the canonical c-a-m order", () =>
    Effect.sync(() => {
      assert.strictEqual(
        notation(
          event({ key: "a", ctrlKey: true, altKey: true, metaKey: true }),
        ),
        "<c-a-m-a>",
      );
      assert.strictEqual(notation(event({ key: "d", ctrlKey: true })), "<c-d>");
    }));

  it.effect("gives a named key its short name", () =>
    Effect.sync(() => {
      assert.strictEqual(notation(event({ key: " " })), "<space>");
      assert.strictEqual(notation(event({ key: "Escape" })), "<esc>");
      assert.strictEqual(notation(event({ key: "ArrowUp" })), "<up>");
      assert.strictEqual(notation(event({ key: "F5" })), "<f5>");
    }));

  it.effect("gives no notation for a modifier press", () =>
    Effect.sync(() => {
      assert.isTrue(
        Option.isNone(keyNotation(event({ key: "Shift", shiftKey: true }))),
      );
      assert.isTrue(isModifierKey(event({ key: "Meta" })));
      assert.isFalse(isModifierKey(event({ key: "a" })));
    }));

  it.effect("uses the physical key when the layout is ignored", () =>
    Effect.sync(() => {
      // A Dvorak user who presses the physical `j` position reports `key: "c"`.
      const dvorak = event({ key: "c", code: "KeyJ" });
      assert.strictEqual(notation(dvorak, false), "c");
      assert.strictEqual(notation(dvorak, true), "j");
    }));

  it.effect("keeps a shifted digit as its character", () =>
    Effect.sync(() => {
      // `$` must stay `$`. A fold back to `4` gives the key to the count
      // prefix, and four shipped bindings die.
      const shifted = event({ key: "$", code: "Digit4", shiftKey: true });
      assert.strictEqual(notation(shifted, true), "$");
    }));

  /**
   * Option chords on an Apple platform.
   *
   * macOS applies Option to the character, so `Option+F` reports the glyph
   * `\u0192`. A mapping file names `<a-f>`, which is the F key of the layout of
   * the user.
   *
   * Every `key`, `code` and `keyCode` below was measured in a WebKit view. The
   * event was built from the layout data of macOS, one layout at a time, with
   * `UCKeyTranslate`. `keyCode` is the character that the key makes with no
   * modifier, `code` is the US position of the key, and `key` is the character
   * with Option applied.
   *
   * The rows for the arrow keys and the function keys give the `key` name that
   * the DOM reports. Those keys do not make a character, so they never reach
   * the Option rule.
   */
  const OPTION_CHORDS: readonly {
    readonly name: string;
    readonly event: KeyEventLike;
    readonly expected: string | null;
  }[] = [
    // -- macOS US QWERTY ---------------------------------------------------
    {
      name: "US Option+F reports the glyph f-hook",
      event: event({
        key: "\u0192",
        code: "KeyF",
        keyCode: 70,
        altKey: true,
      }),
      expected: "<a-f>",
    },
    {
      name: "US Option+E starts a dead key",
      event: event({ key: "Dead", code: "KeyE", keyCode: 69, altKey: true }),
      expected: "<a-e>",
    },
    {
      name: "US Option+1 reports an inverted exclamation mark",
      event: event({
        key: "\u00a1",
        code: "Digit1",
        keyCode: 49,
        altKey: true,
      }),
      expected: "<a-1>",
    },
    {
      name: "US Option+Space reports a no-break space",
      event: event({
        key: "\u00a0",
        code: "Space",
        keyCode: 32,
        altKey: true,
      }),
      expected: "<a-space>",
    },
    {
      name: "US Option+Slash reports a division sign",
      event: event({
        key: "\u00f7",
        code: "Slash",
        keyCode: 191,
        altKey: true,
      }),
      expected: "<a-/>",
    },
    {
      name: "US Option+Shift+F reports a capital glyph",
      event: event({
        key: "\u00cf",
        code: "KeyF",
        keyCode: 70,
        altKey: true,
        shiftKey: true,
      }),
      expected: "<a-F>",
    },
    {
      // The Shift guard. `keyCode` is 49 here, which is the digit 1, so a fold
      // would give `<a-1>` — the notation of Option+1. Two chords cannot share
      // one binding, so the character stays.
      name: "US Option+Shift+1 keeps the fraction slash",
      event: event({
        key: "\u2044",
        code: "Digit1",
        keyCode: 49,
        altKey: true,
        shiftKey: true,
      }),
      expected: "<a-\u2044>",
    },
    {
      // WebKit already reports the plain character for a Ctrl+Option chord.
      name: "US Ctrl+Option+F reports the plain letter",
      event: event({
        key: "f",
        code: "KeyF",
        keyCode: 70,
        altKey: true,
        ctrlKey: true,
      }),
      expected: "<c-a-f>",
    },
    {
      name: "US Option+Backquote starts a dead key",
      event: event({
        key: "Dead",
        code: "Backquote",
        keyCode: 192,
        altKey: true,
      }),
      expected: "<a-`>",
    },
    {
      // WebKit gives both ISO Option+section and Option+Backquote key code 192.
      // The physical code keeps these two keys distinct.
      name: "ISO Option+section keeps the event character",
      event: event({
        key: "\u00a7",
        code: "IntlBackslash",
        keyCode: 192,
        altKey: true,
      }),
      expected: "<a-\u00a7>",
    },
    {
      // A numpad key has its own key codes, 96 to 105, which name no
      // character. The reported character is already the right one.
      name: "US Option+Numpad1 keeps its digit",
      event: event({ key: "1", code: "Numpad1", keyCode: 97, altKey: true }),
      expected: "<a-1>",
    },
    // -- macOS French AZERTY -----------------------------------------------
    {
      name: "French Option+A gives the A key",
      event: event({
        key: "\u00e6",
        code: "KeyQ",
        keyCode: 65,
        altKey: true,
      }),
      expected: "<a-a>",
    },
    {
      name: "French Option+Q gives the Q key",
      event: event({
        key: "\u2021",
        code: "KeyA",
        keyCode: 81,
        altKey: true,
      }),
      expected: "<a-q>",
    },
    {
      name: "French Option+M gives the M key",
      event: event({
        key: "\u00b5",
        code: "Semicolon",
        keyCode: 77,
        altKey: true,
      }),
      expected: "<a-m>",
    },
    {
      // This row muted the tab before the correction. The user pressed a
      // comma, and the notation said `<a-m>`.
      name: "French Option+comma gives the comma",
      event: event({
        key: "\u221e",
        code: "KeyM",
        keyCode: 188,
        altKey: true,
      }),
      expected: "<a-,>",
    },
    {
      name: "French Option+Shift+A gives a capital A",
      event: event({
        key: "\u00c6",
        code: "KeyQ",
        keyCode: 65,
        altKey: true,
        shiftKey: true,
      }),
      expected: "<a-A>",
    },
    {
      name: "French Option+E gives the E key",
      event: event({
        key: "\u00ea",
        code: "KeyE",
        keyCode: 69,
        altKey: true,
      }),
      expected: "<a-e>",
    },
    // -- macOS German QWERTZ -----------------------------------------------
    {
      name: "German Option+Y gives the Y key",
      event: event({
        key: "\u00a5",
        code: "KeyZ",
        keyCode: 89,
        altKey: true,
      }),
      expected: "<a-y>",
    },
    {
      name: "German Option+Z gives the Z key",
      event: event({
        key: "\u03a9",
        code: "KeyY",
        keyCode: 90,
        altKey: true,
      }),
      expected: "<a-z>",
    },
    {
      // The glyph is printable ASCII here, and it is still not the key that
      // the user pressed.
      name: "German Option+L gives the L key",
      event: event({ key: "@", code: "KeyL", keyCode: 76, altKey: true }),
      expected: "<a-l>",
    },
    {
      name: "German Option+F gives the F key",
      event: event({
        key: "\u0192",
        code: "KeyF",
        keyCode: 70,
        altKey: true,
      }),
      expected: "<a-f>",
    },
    // -- macOS Dvorak ------------------------------------------------------
    {
      name: "Dvorak Option+F gives the F key",
      event: event({
        key: "\u0192",
        code: "KeyY",
        keyCode: 70,
        altKey: true,
      }),
      expected: "<a-f>",
    },
    {
      name: "Dvorak Option+E gives the E key",
      event: event({ key: "Dead", code: "KeyD", keyCode: 69, altKey: true }),
      expected: "<a-e>",
    },
    {
      name: "Dvorak Option+O gives the O key",
      event: event({
        key: "\u00f8",
        code: "KeyS",
        keyCode: 79,
        altKey: true,
      }),
      expected: "<a-o>",
    },
    // -- macOS layouts that are not Latin ----------------------------------
    {
      // A known limit. WebKit cannot name a Cyrillic letter in `keyCode`, so
      // it gives the letter of the US position. No field of this event carries
      // the letter of the user.
      name: "Russian Option+ef gives the letter of the position",
      event: event({
        key: "\u0192",
        code: "KeyA",
        keyCode: 65,
        altKey: true,
      }),
      expected: "<a-a>",
    },
    {
      name: "Greek Option+alpha gives the letter of the position",
      event: event({
        key: "\u2026",
        code: "KeyA",
        keyCode: 65,
        altKey: true,
      }),
      expected: "<a-a>",
    },
    // -- keys that make no character ---------------------------------------
    {
      name: "Option+Escape stays the Escape key",
      event: event({
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        altKey: true,
      }),
      expected: "<a-esc>",
    },
    {
      name: "Option+ArrowUp stays the up key",
      event: event({
        key: "ArrowUp",
        code: "ArrowUp",
        keyCode: 38,
        altKey: true,
      }),
      expected: "<a-up>",
    },
    {
      name: "Option+F1 stays the F1 key",
      event: event({ key: "F1", code: "F1", keyCode: 112, altKey: true }),
      expected: "<a-f1>",
    },
    {
      name: "a chord with no Alt keeps its own character",
      event: event({ key: "\u0192", code: "KeyF", keyCode: 70 }),
      expected: "\u0192",
    },
    // -- the fallbacks -----------------------------------------------------
    {
      // With no `keyCode` the US position is all that is left. It is wrong on
      // a French layout, and it is still better than a glyph that no mapping
      // file can name.
      name: "French Option+A with no keyCode falls back to the position",
      event: event({ key: "\u00e6", code: "KeyQ", altKey: true }),
      expected: "<a-q>",
    },
    {
      name: "an Option chord with no keyCode and no code keeps the glyph",
      event: event({ key: "\u0192", altKey: true }),
      expected: "<a-\u0192>",
    },
  ];

  for (const row of OPTION_CHORDS) {
    it.effect(`reads an Apple Option chord: ${row.name}`, () =>
      Effect.sync(() => {
        assert.strictEqual(appleNotation(row.event), row.expected);
      }));
  }

  /**
   * The same rule must not run on Windows and on Linux.
   *
   * Alt does not change the character there. A layout that is not Latin makes
   * its own letter, and that letter is the binding of the user.
   */
  const NON_APPLE_ALT_CHORDS: readonly {
    readonly name: string;
    readonly event: KeyEventLike;
    readonly expected: string | null;
  }[] = [
    {
      name: "Alt+A on a Linux AZERTY layout keeps its own letter",
      event: event({ key: "a", code: "KeyQ", keyCode: 65, altKey: true }),
      expected: "<a-a>",
    },
    {
      name: "Alt+ef on a Cyrillic layout keeps the Cyrillic letter",
      event: event({
        key: "\u0444",
        code: "KeyA",
        keyCode: 65,
        altKey: true,
      }),
      expected: "<a-\u0444>",
    },
    {
      name: "Alt+alpha on a Greek layout keeps the Greek letter",
      event: event({
        key: "\u03b1",
        code: "KeyA",
        keyCode: 65,
        altKey: true,
      }),
      expected: "<a-\u03b1>",
    },
    {
      name: "Alt+shin on a Hebrew layout keeps the Hebrew letter",
      event: event({
        key: "\u05e9",
        code: "KeyA",
        keyCode: 65,
        altKey: true,
      }),
      expected: "<a-\u05e9>",
    },
    {
      name: "AltGr on Windows keeps the character that it makes",
      event: event({
        key: "@",
        code: "KeyQ",
        keyCode: 81,
        altKey: true,
        ctrlKey: true,
      }),
      expected: "<c-a-@>",
    },
    {
      name: "AltGraph with no Ctrl keeps the character that it makes",
      event: event({
        key: "\u0105",
        code: "KeyA",
        keyCode: 65,
        altKey: true,
      }),
      expected: "<a-\u0105>",
    },
    {
      name: "a macOS glyph on another platform keeps the glyph",
      event: event({
        key: "\u0192",
        code: "KeyF",
        keyCode: 70,
        altKey: true,
      }),
      expected: "<a-\u0192>",
    },
  ];

  for (const row of NON_APPLE_ALT_CHORDS) {
    it.effect(`leaves an Alt chord alone: ${row.name}`, () =>
      Effect.sync(() => {
        assert.strictEqual(notation(row.event), row.expected);
      }));
  }

  /**
   * The whole table of key codes, and the whole table of positions.
   *
   * A wrong entry in either table gives a wrong binding to a real key, and no
   * other test reads more than a few rows. Each row here is one entry.
   */
  it.effect("maps every key code to its character", () =>
    Effect.sync(() => {
      const KEY_CODES: readonly (readonly [number, string])[] = [
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
      ];
      const letters = "abcdefghijklmnopqrstuvwxyz";
      const rows: (readonly [number, string])[] = [...KEY_CODES];
      for (let index = 0; index < letters.length; index++) {
        rows.push([65 + index, letters[index] ?? ""]);
      }
      for (let digit = 0; digit <= 9; digit++) {
        rows.push([48 + digit, String(digit)]);
      }

      for (const [keyCode, char] of rows) {
        const chord = event({ key: "\u0192", keyCode, altKey: true });
        const expected = char === " " ? "<a-space>" : `<a-${char}>`;
        assert.strictEqual(
          appleNotation(chord),
          expected,
          `key code ${keyCode} must give "${char}"`,
        );
      }
    }));

  it.effect("maps every physical position to its character", () =>
    Effect.sync(() => {
      const POSITIONS: readonly (readonly [string, string])[] = [
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
        ["Space", " "],
        ["KeyF", "f"],
        ["Digit7", "7"],
      ];

      for (const [code, char] of POSITIONS) {
        // No `keyCode`, so the position is the only source that is left.
        const chord = event({ key: "\u0192", code, altKey: true });
        const expected = char === " " ? "<a-space>" : `<a-${char}>`;
        assert.strictEqual(
          appleNotation(chord),
          expected,
          `position ${code} must give "${char}"`,
        );
      }
    }));

  it.effect("gives an Option chord the same notation as its mapping", () =>
    Effect.sync(() => {
      // The mapping file writes `<a-f>`, and the event must arrive as `<a-f>`.
      const optionF = event({
        key: "\u0192",
        code: "KeyF",
        keyCode: 70,
        altKey: true,
      });
      assert.deepEqual(sequence("<a-f>"), [appleNotation(optionF) ?? ""]);
    }));

  /**
   * Characters outside the Basic Multilingual Plane.
   *
   * Each row gives a key sequence from a mapping line and the keys that it
   * holds. A walk over UTF-16 units cuts such a character into two halves.
   */
  const ASTRAL_SEQUENCES: readonly {
    readonly name: string;
    readonly input: string;
    readonly expected: readonly string[] | null;
  }[] = [
    {
      name: "an emoji alone is one key",
      input: "\u{1f600}",
      expected: ["\u{1f600}"],
    },
    {
      name: "an emoji after a letter is one key",
      input: "a\u{1f600}",
      expected: ["a", "\u{1f600}"],
    },
    {
      name: "two emoji are two keys",
      input: "\u{1f600}\u{1f601}",
      expected: ["\u{1f600}", "\u{1f601}"],
    },
    {
      name: "a mathematical letter is one key",
      input: "\u{1d41a}",
      expected: ["\u{1d41a}"],
    },
    {
      name: "an emoji takes a modifier",
      input: "<a-\u{1f600}>",
      expected: ["<a-\u{1f600}>"],
    },
    {
      name: "an emoji in angle brackets is the plain key",
      input: "<\u{1f600}>",
      expected: ["\u{1f600}"],
    },
    {
      name: "an unterminated angle key after an emoji is still an error",
      input: "\u{1f600}<c-a",
      expected: null,
    },
  ];

  for (const row of ASTRAL_SEQUENCES) {
    it.effect(`parses an astral sequence: ${row.name}`, () =>
      Effect.sync(() => {
        assert.deepEqual(sequence(row.input), row.expected);
      }));
  }

  /**
   * The notation of an astral key press.
   *
   * The notation must be the same string that the mapping parser gives, or the
   * binding can never fire.
   */
  const ASTRAL_EVENTS: readonly {
    readonly name: string;
    readonly event: KeyEventLike;
    readonly expected: string;
  }[] = [
    {
      name: "an emoji key",
      event: event({ key: "\u{1f600}" }),
      expected: "\u{1f600}",
    },
    {
      name: "a mathematical letter key",
      event: event({ key: "\u{1d41a}" }),
      expected: "\u{1d41a}",
    },
    {
      name: "an emoji key with Ctrl",
      event: event({ key: "\u{1f600}", ctrlKey: true }),
      expected: "<c-\u{1f600}>",
    },
  ];

  for (const row of ASTRAL_EVENTS) {
    it.effect(`writes an astral key: ${row.name}`, () =>
      Effect.sync(() => {
        assert.strictEqual(notation(row.event), row.expected);
        // The mapping and the press must meet.
        assert.deepEqual(sequence(row.expected), [row.expected]);
      }));
  }

  it.effect("does not take half of an astral character as a count digit", () =>
    Effect.sync(() => {
      assert.isFalse(isCountDigit("\u{1f600}", true));
      assert.isFalse(isCountDigit("\u{1f600}", false));
    }));

  it.effect("reads both composition signals", () =>
    Effect.sync(() => {
      assert.isTrue(isComposing(event({ key: "a", isComposing: true })));
      assert.isTrue(isComposing(event({ key: "a", keyCode: 229 })));
      assert.isFalse(isComposing(event({ key: "a" })));
    }));

  it.effect("turns an iOS private-use code point into a named key", () =>
    Effect.sync(() => {
      // Without this table `<up>` and `<esc>` are dead on an iPad with a
      // hardware keyboard, and correct on macOS.
      assert.strictEqual(normaliseAppKitKey("\uF700"), "ArrowUp");
      assert.strictEqual(normaliseAppKitKey("\uF703"), "ArrowRight");
      assert.strictEqual(normaliseAppKitKey("\uF704"), "F1");
      assert.strictEqual(normaliseAppKitKey("\uF72C"), "PageUp");
      assert.strictEqual(normaliseAppKitKey("j"), "j");
    }));

  it.effect("splits a mixed sequence", () =>
    Effect.sync(() => {
      assert.deepEqual(sequence("<c-a>gg"), ["<c-a>", "g", "g"]);
      assert.deepEqual(sequence("[["), ["[", "["]);
      assert.deepEqual(sequence("<esc>"), ["<esc>"]);
    }));

  it.effect("ignores the order of the modifiers in a parse", () =>
    Effect.sync(() => {
      assert.deepEqual(sequence("<a-c-x>"), ["<c-a-x>"]);
      assert.deepEqual(sequence("<ctrl-alt-x>"), ["<c-a-x>"]);
    }));

  it.effect("folds an alias onto the canonical name", () =>
    Effect.sync(() => {
      assert.deepEqual(sequence("<escape>"), ["<esc>"]);
      assert.deepEqual(sequence("<cr>"), ["<enter>"]);
      assert.deepEqual(sequence("<lt>"), ["<"]);
    }));

  it.effect("treats a trailing dash as the key", () =>
    Effect.sync(() => {
      const parsed = parseKeySequence("<c-->");
      assert.isTrue(Result.isSuccess(parsed));
      if (Result.isFailure(parsed)) return;
      const first = parsed.success[0];
      assert.strictEqual(first?.char, "-");
      assert.strictEqual(first?.ctrl, true);
    }));

  it.effect("keeps `<` literal when it cannot open a named key", () =>
    Effect.sync(() => {
      // `<<` is the upstream binding for `moveTabLeft`, so this is not rare.
      assert.deepEqual(sequence("<<"), ["<", "<"]);
      assert.deepEqual(sequence(">>"), [">", ">"]);
      assert.deepEqual(sequence("<"), ["<"]);
      // `<>` cannot open a named key either, so both characters are literal.
      assert.deepEqual(sequence("<>"), ["<", ">"]);
    }));

  it.effect("gives a failure value for malformed notation", () =>
    Effect.sync(() => {
      for (const input of ["<c-a", "<c-nosuchkey>", "<c->", ""]) {
        const parsed = parseKeySequence(input);
        assert.isTrue(
          Result.isFailure(parsed),
          `${input} was accepted`,
        );
        if (Result.isSuccess(parsed)) continue;
        assert.strictEqual(parsed.failure._tag, "KeyNotationError");
        assert.isAbove(parsed.failure.detail.length, 0);
      }
    }));

  it.effect("names an unknown modifier in the failure detail", () =>
    Effect.sync(() => {
      const parsed = parseKeySequence("<x-a>");
      assert.isTrue(Result.isFailure(parsed));
      if (Result.isSuccess(parsed)) return;
      assert.include(parsed.failure.detail, "unknown modifier");
    }));

  it.effect("knows the combinations that Safari never sends", () =>
    Effect.sync(() => {
      // `preventDefault` has no meaning here. The keydown never arrives.
      assert.isTrue(Option.isSome(reservedReason("<m-t>")));
      assert.isTrue(Option.isSome(reservedReason("<c-tab>")));
      assert.isTrue(Option.isNone(reservedReason("<m-e>")));
      // The lookup is case-sensitive, so `<m-T>` is not `<m-t>`.
      assert.isTrue(Option.isNone(reservedReason("<m-T>")));
      assert.isAbove(SAFARI_RESERVED.length, 0);
    }));

  it.effect("warns about an explicit shift on a character shift changes", () =>
    Effect.sync(() => {
      assert.isTrue(shiftedNonLetter("<c-s-1>"));
      assert.isFalse(shiftedNonLetter("<c-s-a>"));
      assert.isFalse(shiftedNonLetter("<c-a>"));
    }));

  it.effect("lists the combinations that WebKit 191768 puts in doubt", () =>
    Effect.sync(() => {
      assert.isTrue(IOS_UNCERTAIN.has("<m-f>"));
      assert.isFalse(IOS_UNCERTAIN.has("<m-j>"));
    }));

  it.effect("takes `0` as a count digit only after a count starts", () =>
    Effect.sync(() => {
      assert.isFalse(isCountDigit("0", false));
      assert.isTrue(isCountDigit("0", true));
      assert.isTrue(isCountDigit("1", false));
      assert.isFalse(isCountDigit("<c-1>", true));
    }));

  it.effect("stops a count at the maximum", () =>
    Effect.sync(() => {
      assert.strictEqual(appendCountDigit(0, "3"), 3);
      assert.strictEqual(appendCountDigit(3, "7"), 37);
      // `999999999G` must not hang a tab.
      assert.strictEqual(appendCountDigit(MAX_COUNT, "9"), MAX_COUNT);
    }));
});
