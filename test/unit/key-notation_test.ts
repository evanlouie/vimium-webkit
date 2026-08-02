import { test } from "vitest";
import {
  IOS_UNCERTAIN,
  isComposing,
  isModifierKey,
  type KeyEventLike,
  keyNotation,
  KeyNotationError,
  normaliseAppKitKey,
  normaliseKeySequence,
  parseKeySequence,
  reservedReason,
} from "~/core/key-notation.ts";
import { assertEquals, assertThrows } from "./support/assert.ts";

const event = (
  partial: Partial<KeyEventLike> & { key: string },
): KeyEventLike => ({
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...partial,
});

test("keyNotation: bare printable characters are unwrapped", () => {
  assertEquals(keyNotation(event({ key: "j" })), "j");
  assertEquals(keyNotation(event({ key: "/" })), "/");
});

test("keyNotation: shift is folded into printable characters", () => {
  assertEquals(keyNotation(event({ key: "G", shiftKey: true })), "G");
});

test("keyNotation: shift is explicit for named keys", () => {
  assertEquals(keyNotation(event({ key: "Tab", shiftKey: true })), "<s-tab>");
});

test("keyNotation: modifiers emit in canonical c-a-m order", () => {
  assertEquals(
    keyNotation(
      event({ key: "a", ctrlKey: true, altKey: true, metaKey: true }),
    ),
    "<c-a-m-a>",
  );
  assertEquals(keyNotation(event({ key: "d", ctrlKey: true })), "<c-d>");
});

test("keyNotation: named keys map to their short names", () => {
  assertEquals(keyNotation(event({ key: " " })), "<space>");
  assertEquals(keyNotation(event({ key: "Escape" })), "<esc>");
  assertEquals(keyNotation(event({ key: "ArrowUp" })), "<up>");
  assertEquals(keyNotation(event({ key: "F5" })), "<f5>");
});

test("keyNotation: modifier presses carry no key", () => {
  assertEquals(keyNotation(event({ key: "Shift", shiftKey: true })), null);
  assertEquals(isModifierKey(event({ key: "Meta" })), true);
});

test("keyNotation: ignoreKeyboardLayout uses the physical key", () => {
  // A Dvorak user pressing the physical `j` position reports `key: "c"`.
  const dvorak = event({ key: "c", code: "KeyJ" });
  assertEquals(keyNotation(dvorak, false), "c");
  assertEquals(keyNotation(dvorak, true), "j");
});

test("isComposing: both the modern and legacy signals count", () => {
  assertEquals(isComposing(event({ key: "a", isComposing: true })), true);
  assertEquals(isComposing(event({ key: "a", keyCode: 229 })), true);
  assertEquals(isComposing(event({ key: "a" })), false);
});

test("normaliseAppKitKey: iOS private-use codepoints become named keys", () => {
  // Without this, `<up>` and `<esc>` are dead on an iPad with a hardware
  // keyboard while working fine on macOS.
  assertEquals(normaliseAppKitKey("\uF700"), "ArrowUp");
  assertEquals(normaliseAppKitKey("\uF703"), "ArrowRight");
  assertEquals(normaliseAppKitKey("\uF704"), "F1");
  assertEquals(normaliseAppKitKey("\uF72C"), "PageUp");
  assertEquals(normaliseAppKitKey("j"), "j");
});

test("parseKeySequence: splits a mixed sequence", () => {
  assertEquals(normaliseKeySequence("<c-a>gg"), ["<c-a>", "g", "g"]);
  assertEquals(normaliseKeySequence("[["), ["[", "["]);
  assertEquals(normaliseKeySequence("<esc>"), ["<esc>"]);
});

test("parseKeySequence: modifier order does not matter", () => {
  assertEquals(normaliseKeySequence("<a-c-x>"), ["<c-a-x>"]);
  assertEquals(normaliseKeySequence("<ctrl-alt-x>"), ["<c-a-x>"]);
});

test("parseKeySequence: aliases fold onto canonical names", () => {
  assertEquals(normaliseKeySequence("<escape>"), ["<esc>"]);
  assertEquals(normaliseKeySequence("<cr>"), ["<enter>"]);
  assertEquals(normaliseKeySequence("<lt>"), ["<"]);
});

test("parseKeySequence: a trailing dash is the key, not a separator", () => {
  const [key] = parseKeySequence("<c-->");
  assertEquals(key?.char, "-");
  assertEquals(key?.ctrl, true);
});

test("parseKeySequence: `<` is literal when it cannot open a named key", () => {
  // `<<` is upstream's `moveTabLeft` binding, so this is not a corner case.
  assertEquals(normaliseKeySequence("<<"), ["<", "<"]);
  assertEquals(normaliseKeySequence(">>"), [">", ">"]);
  assertEquals(normaliseKeySequence("<"), ["<"]);
});

test("parseKeySequence: malformed input throws with attribution", () => {
  assertThrows(() => parseKeySequence("<c-a"), KeyNotationError);
  assertThrows(() => parseKeySequence("<c-nosuchkey>"), KeyNotationError);
  assertThrows(() => parseKeySequence(""), KeyNotationError);
});

test("reservedReason: Safari's unbindable combinations are known", () => {
  // `preventDefault` is irrelevant for these — the keydown never arrives.
  assertEquals(typeof reservedReason("<m-t>"), "string");
  assertEquals(typeof reservedReason("<c-tab>"), "string");
  assertEquals(reservedReason("<m-e>"), null);
});

test("IOS_UNCERTAIN lists the combinations WebKit 191768 puts in doubt", () => {
  assertEquals(IOS_UNCERTAIN.has("<m-f>"), true);
  assertEquals(IOS_UNCERTAIN.has("<m-j>"), false);
});
