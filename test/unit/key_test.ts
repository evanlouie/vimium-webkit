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
): string | null => Option.getOrNull(keyNotation(input, ignoreKeyboardLayout));

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
   * macOS Option chords.
   *
   * macOS applies Option to the character, so `Option+F` reports the glyph
   * `\u0192`. The shipped mapping names `<a-f>`, which is the physical F key.
   * Each row gives the event and the notation that the mapping file writes.
   */
  const OPTION_CHORDS: readonly {
    readonly name: string;
    readonly event: KeyEventLike;
    readonly expected: string | null;
  }[] = [
    {
      name: "Option+F reports the glyph f-hook",
      event: event({ key: "\u0192", code: "KeyF", altKey: true }),
      expected: "<a-f>",
    },
    {
      name: "Option+M reports the glyph micro",
      event: event({ key: "\u00b5", code: "KeyM", altKey: true }),
      expected: "<a-m>",
    },
    {
      name: "Option+Shift+F reports a capital glyph",
      event: event({
        key: "\u00cf",
        code: "KeyF",
        altKey: true,
        shiftKey: true,
      }),
      expected: "<a-F>",
    },
    {
      name: "Option+E starts a dead key",
      event: event({ key: "Dead", code: "KeyE", altKey: true }),
      expected: "<a-e>",
    },
    {
      name: "Option+1 reports an inverted exclamation mark",
      event: event({ key: "\u00a1", code: "Digit1", altKey: true }),
      expected: "<a-1>",
    },
    {
      name: "Option+Slash reports a division sign",
      event: event({ key: "\u00f7", code: "Slash", altKey: true }),
      expected: "<a-/>",
    },
    {
      name: "Option+Space reports a no-break space",
      event: event({ key: "\u00a0", code: "Space", altKey: true }),
      expected: "<a-space>",
    },
    {
      name: "Alt+A on a Linux AZERTY layout keeps its own letter",
      event: event({ key: "a", code: "KeyQ", altKey: true }),
      expected: "<a-a>",
    },
    {
      name: "AltGr on Windows keeps the character that it makes",
      event: event({
        key: "@",
        code: "KeyQ",
        altKey: true,
        ctrlKey: true,
      }),
      expected: "<c-a-@>",
    },
    {
      name: "a chord with no Alt keeps its own character",
      event: event({ key: "\u0192", code: "KeyF" }),
      expected: "\u0192",
    },
  ];

  for (const row of OPTION_CHORDS) {
    it.effect(`normalises an Option chord: ${row.name}`, () =>
      Effect.sync(() => {
        assert.strictEqual(notation(row.event), row.expected);
      }));
  }

  it.effect("gives an Option chord the same notation as its mapping", () =>
    Effect.sync(() => {
      // The mapping file writes `<a-f>`, and the event must arrive as `<a-f>`.
      const optionF = event({ key: "\u0192", code: "KeyF", altKey: true });
      assert.deepEqual(sequence("<a-f>"), [notation(optionF) ?? ""]);
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
