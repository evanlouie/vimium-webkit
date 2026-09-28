/**
 * The settings dialog holds every documented setting.
 *
 * The README says that all of them are editable in the overlay, and for eight
 * of them that was not true: `linkHintNumbers`, `userDefinedLinkHintCss`, the
 * two navigation patterns, the two URLs and the two history limits had no
 * control at all. A user could therefore not configure them at all, because a
 * userscript has no options page and no configuration file.
 *
 * The comparison below is against the schema, and not against a second list.
 * A setting that arrives with no control fails here.
 */

import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Option, Order, pipe, Record, Struct } from "effect";
import { defaultSettings } from "~/domain/Persisted.ts";
import {
  adjustedFields,
  type EntryField,
  EntryInput,
  formNotes,
  parseExclusionText,
  parseLines,
  SETTINGS_FIELDS,
  SettingsField,
} from "~/ui/Dialog.ts";

const settingKeys = (): readonly string[] =>
  pipe(defaultSettings(), Record.keys, Array.sort(Order.String));

const fieldKeys = (): readonly string[] =>
  pipe(
    SETTINGS_FIELDS,
    Array.map((field) => String(field.key)),
    Array.sort(Order.String),
  );

/** One control of the form, by the setting that it edits. */
const field = (key: string): SettingsField =>
  pipe(
    SETTINGS_FIELDS,
    Array.findFirst((one) => one.key === key),
    Option.getOrElse(() => assert.fail(`${key} has no control`)),
  );

/** One text control of the form, by the setting that it edits. */
const entry = (key: string): EntryField =>
  pipe(
    field(key),
    Option.liftPredicate(SettingsField.$is("Entry")),
    Option.getOrElse(() => assert.fail(`${key} is not a text control`)),
  );

const isNumberEntry = (one: SettingsField): one is EntryField =>
  SettingsField.$is("Entry")(one) && EntryInput.$is("Number")(one.input);

describe("the settings form", () => {
  it.effect("gives every documented setting a control", () =>
    Effect.sync(() => {
      assert.deepEqual(
        fieldKeys(),
        settingKeys(),
        "the form and the schema must hold the same settings",
      );
    }),
  );

  it.effect("reads back what it writes", () =>
    Effect.sync(() => {
      const base = defaultSettings();
      pipe(
        SETTINGS_FIELDS,
        Array.forEach(
          SettingsField.$match({
            Toggle: (toggle) =>
              assert.strictEqual(
                toggle.read(toggle.write(base, !toggle.read(base))),
                !toggle.read(base),
                `the toggle for ${toggle.key} did not take the new value`,
              ),
            // The stored value is written out and read back. A field that
            // changes its own text would show the user something else after
            // each save.
            Entry: (text) =>
              assert.strictEqual(
                text.read(text.write(base, text.read(base))),
                text.read(base),
                `the field for ${text.key} did not round-trip`,
              ),
          }),
        ),
      );
    }),
  );

  it.effect("keeps the stored value when a number is not a number", () =>
    Effect.sync(() => {
      const base = defaultSettings();
      const numbers = pipe(SETTINGS_FIELDS, Array.filter(isNumberEntry));
      assert.isNotEmpty(numbers);
      pipe(
        numbers,
        Array.forEach((number) =>
          assert.strictEqual(
            number.read(number.write(base, "not a number")),
            number.read(base),
            `the field for ${number.key} accepted text as a number`,
          ),
        ),
      );
    }),
  );

  it.effect("names the fields that storage changed", () =>
    Effect.sync(() => {
      const base = defaultSettings();
      const offered = pipe(base, Struct.assign({ hideHud: !base.hideHud, newTabUrl: "x" }));
      const changed = pipe(adjustedFields(offered, base), Array.sort(Order.String));
      assert.deepEqual(changed, ["Hide the HUD", "Page that a new tab opens"]);
      assert.deepEqual(adjustedFields(base, base), []);
    }),
  );

  it.effect("names a field whose text it refused", () =>
    Effect.sync(() => {
      // The write function keeps the stored value here, so the offered
      // settings and the stored settings agree and `adjustedFields` finds
      // nothing. Without this list the user saw the old value come back with
      // no reason for it.
      const notes = formNotes([
        { field: field("linkHintNumbers"), text: "1" },
        { field: field("linkHintCharacters"), text: "a" },
        { field: field("scrollStepSize"), text: "none at all" },
        { field: field("searchUrl"), text: "https://example.com/?q=%s" },
        { field: field("smoothScroll"), text: "true" },
      ]);
      assert.deepEqual(notes.refused, [
        "Digits that choose among filtered hints",
        "Link hint characters",
        "Scroll step size (px)",
      ]);
      assert.deepEqual(notes.clamped, []);
      assert.deepEqual(notes.truncated, []);
    }),
  );

  it.effect("lists an exclusion rule that gives no matcher", () =>
    Effect.sync(() => {
      const notes = formNotes([
        {
          field: field("exclusionRules"),
          text: "https://good.test/*\n/(a+)+$/",
        },
      ]);
      assert.strictEqual(notes.dropped.length, 1);
      const dropped = pipe(
        notes.dropped,
        Array.head,
        Option.getOrElse(() => ""),
      );
      assert.include(dropped, "line 2");
      assert.include(dropped, "/(a+)+$/");
      assert.include(dropped, "can hang the page");
    }),
  );

  it.effect("says that it brought a number into range", () =>
    Effect.sync(() => {
      // A number that is out of range does **not** keep its stored value: the
      // control stores the bound. A message that said the opposite was false,
      // and the user looked for a value that is not there.
      const base = defaultSettings();
      const notes = formNotes([
        { field: field("scrollStepSize"), text: "20000" },
        { field: field("historyIndexLimit"), text: "90000" },
      ]);
      assert.deepEqual(notes.refused, []);
      assert.deepEqual(notes.clamped, ["Scroll step size (px)", "Entries kept in the index"]);
      // What the message claims must be what the write function does.
      const control = entry("scrollStepSize");
      const stored = control.write(base, "20000");
      assert.strictEqual(control.read(stored), "10000");
      assert.notStrictEqual(control.read(stored), control.read(base));
    }),
  );

  it.effect("says nothing about a value that it can use", () =>
    Effect.sync(() => {
      const base = defaultSettings();
      const offered = pipe(
        SETTINGS_FIELDS,
        Array.map((one) => ({
          field: one,
          text: pipe(
            one,
            SettingsField.$match({
              Toggle: ({ read }) => String(read(base)),
              Entry: ({ read }) => read(base),
            }),
          ),
        })),
      );
      assert.deepEqual(formNotes(offered), {
        refused: [],
        clamped: [],
        truncated: [],
        dropped: [],
      });
    }),
  );

  it.effect("says that it dropped the decimals of a number", () =>
    Effect.sync(() => {
      // A control of type `number` gives back `50.7`, because that text is a
      // valid floating-point number. `Number.parseInt` then reads 50. The
      // value is neither refused nor out of range, so this input fell into no
      // report at all and the user saw 50 with no reason for it.
      const base = defaultSettings();
      const notes = formNotes([{ field: field("scrollStepSize"), text: "50.7" }]);
      assert.deepEqual(notes.refused, []);
      assert.deepEqual(notes.clamped, []);
      assert.deepEqual(notes.truncated, ["Scroll step size (px)"]);

      // What the message claims must be what the write function does.
      const control = entry("scrollStepSize");
      assert.strictEqual(control.read(control.write(base, "50.7")), "50");
    }),
  );

  it.effect("reads a list of lines, and drops the empty ones", () =>
    Effect.sync(() => {
      assert.deepEqual(parseLines("  https://a.example/*  \n\n https://b.example/* \n"), [
        "https://a.example/*",
        "https://b.example/*",
      ]);
      assert.deepEqual(parseLines("   \n\n"), []);
    }),
  );

  it.effect("reads one exclusion rule for each line", () =>
    Effect.sync(() => {
      assert.deepEqual(parseExclusionText("# a comment\nhttps://a.example/* jk\nhttps://b/*"), [
        { pattern: "https://a.example/*", passKeys: "jk" },
        { pattern: "https://b/*", passKeys: "" },
      ]);
    }),
  );
});
