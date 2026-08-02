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
import { Effect } from "effect";
import { defaultSettings } from "~/domain/Persisted.ts";
import {
  adjustedFields,
  parseExclusionText,
  parseLines,
  refusedFields,
  SETTINGS_FIELDS,
  SETTINGS_SECTIONS,
} from "~/ui/Dialog.ts";

const settingKeys = (): readonly string[] =>
  Object.keys(defaultSettings()).toSorted();

const fieldKeys = (): readonly string[] =>
  SETTINGS_FIELDS.map((field) => String(field.key)).toSorted();

describe("the settings form", () => {
  it.effect("gives every documented setting a control", () =>
    Effect.sync(() => {
      assert.deepEqual(
        fieldKeys(),
        settingKeys(),
        "the form and the schema must hold the same settings",
      );
    }));

  it.effect("gives each setting exactly one control", () =>
    Effect.sync(() => {
      const seen = new Set<string>();
      for (const field of SETTINGS_FIELDS) {
        const key = String(field.key);
        assert.isFalse(seen.has(key), `${key} has two controls`);
        seen.add(key);
      }
    }));

  it.effect("labels every field and every section", () =>
    Effect.sync(() => {
      for (const section of SETTINGS_SECTIONS) {
        assert.isAbove(section.title.length, 0, "a section has no title");
        assert.isAbove(
          section.fields.length,
          0,
          `the section "${section.title}" has no field`,
        );
      }
      for (const field of SETTINGS_FIELDS) {
        assert.isAbove(
          field.label.length,
          0,
          `the field for ${String(field.key)} has no label`,
        );
      }
    }));

  it.effect("reads back what it writes", () =>
    Effect.sync(() => {
      const base = defaultSettings();
      for (const field of SETTINGS_FIELDS) {
        if (field.kind === "toggle") {
          const flipped = field.write(base, !field.read(base));
          assert.strictEqual(
            field.read(flipped),
            !field.read(base),
            `the toggle for ${String(field.key)} did not take the new value`,
          );
          continue;
        }
        // The stored value is written out and read back. A field that changes
        // its own text would show the user something else after each save.
        const text = field.read(base);
        assert.strictEqual(
          field.read(field.write(base, text)),
          text,
          `the field for ${String(field.key)} did not round-trip`,
        );
      }
    }));

  it.effect("keeps the stored value when a number is not a number", () =>
    Effect.sync(() => {
      const base = defaultSettings();
      for (const field of SETTINGS_FIELDS) {
        if (field.kind !== "number") continue;
        assert.strictEqual(
          field.read(field.write(base, "not a number")),
          field.read(base),
          `the field for ${String(field.key)} accepted text as a number`,
        );
      }
    }));

  it.effect("names the fields that storage changed", () =>
    Effect.sync(() => {
      const base = defaultSettings();
      const offered = { ...base, hideHud: !base.hideHud, newTabUrl: "x" };
      const changed = adjustedFields(offered, base);
      assert.deepEqual(
        [...changed].toSorted(),
        ["Hide the HUD", "Page that a new tab opens"].toSorted(),
      );
      assert.deepEqual(adjustedFields(base, base), []);
    }));

  it.effect("names a field whose text it refused", () =>
    Effect.sync(() => {
      // The write function keeps the stored value here, so the offered
      // settings and the stored settings agree and `adjustedFields` finds
      // nothing. Without this list the user saw the old value come back with
      // no reason for it.
      const field = (key: string) => {
        const found = SETTINGS_FIELDS.find((one) => String(one.key) === key);
        assert.isDefined(found, `${key} has no control`);
        return found;
      };
      const refused = refusedFields([
        { field: field("linkHintNumbers"), text: "1" },
        { field: field("linkHintCharacters"), text: "a" },
        { field: field("scrollStepSize"), text: "0" },
        { field: field("historyIndexLimit"), text: "90000" },
        { field: field("searchUrl"), text: "https://example.com/?q=%s" },
        { field: field("smoothScroll"), text: "true" },
      ]);
      assert.deepEqual(refused, [
        "Digits that choose among filtered hints",
        "Link hint characters",
        "Scroll step size (px)",
        "Entries kept in the index",
      ]);
    }));

  it.effect("says nothing about a value that it can use", () =>
    Effect.sync(() => {
      const base = defaultSettings();
      const offered = SETTINGS_FIELDS.map((one) => ({
        field: one,
        text: one.kind === "toggle"
          ? String(one.read(base))
          : one.read(base),
      }));
      assert.deepEqual(refusedFields(offered), []);
    }));

  it.effect("lets every number control say what it refuses", () =>
    Effect.sync(() => {
      for (const field of SETTINGS_FIELDS) {
        if (field.kind !== "number") continue;
        assert.isDefined(
          field.refuses,
          `the field for ${String(field.key)} cannot report a refusal`,
        );
        assert.isTrue(
          field.refuses?.("not a number") ?? false,
          `the field for ${String(field.key)} accepted text as a number`,
        );
      }
    }));

  it.effect("reads a list of lines, and drops the empty ones", () =>
    Effect.sync(() => {
      assert.deepEqual(
        parseLines("  https://a.example/*  \n\n https://b.example/* \n"),
        ["https://a.example/*", "https://b.example/*"],
      );
      assert.deepEqual(parseLines("   \n\n"), []);
    }));

  it.effect("reads one exclusion rule for each line", () =>
    Effect.sync(() => {
      assert.deepEqual(
        parseExclusionText("# a comment\nhttps://a.example/* jk\nhttps://b/*"),
        [
          { pattern: "https://a.example/*", passKeys: "jk" },
          { pattern: "https://b/*", passKeys: "" },
        ],
      );
    }));
});
