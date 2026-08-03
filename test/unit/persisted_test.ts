/**
 * The shipped configuration.
 *
 * Two properties matter here. Adding a field must be safe, because each field
 * carries its own fallback. And the defaults are the schema, so there is one
 * list of them and not two.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  defaultSettings,
  findHistoryGroup,
  type GroupSpec,
  historyGroup,
  LOCAL_MARK_TTL_MS,
  LOCAL_MARK_URL_LIMIT,
  type LocalMark,
  type Marks,
  marksGroup,
  pruneMarks,
  repairSettings,
  sessionGroup,
  settingsGroup,
  settingsSchema,
} from "~/domain/Persisted.ts";
import { decodeUnknown } from "~/platform/SchemaIo.ts";

/** Decode untrusted input and keep the detail of a failure. It never throws. */
const decodeSettings = decodeUnknown(settingsSchema);

const GROUPS: readonly GroupSpec<unknown>[] = [
  settingsGroup,
  marksGroup,
  findHistoryGroup,
  historyGroup,
  sessionGroup,
];

const markTable = (urls: number, at: (index: number) => number): Marks => {
  const local: Record<string, Record<string, LocalMark>> = {};
  for (let index = 0; index < urls; index++) {
    local[`https://example.com/${index}`] = {
      a: { scrollX: 0, scrollY: index, savedAt: at(index) },
    };
  }
  return { local, global: {} };
};

describe("Persisted", () => {
  it.effect("gives every group defaults that satisfy its own schema", () =>
    Effect.sync(() => {
      // `defaultSettings()` decodes the literal `{}`, so a field that is added
      // with no fallback fails here and not at a `document-start` of a user.
      for (const group of GROUPS) {
        const result = decodeUnknown(group.schema)(group.defaults());
        assert.isTrue(
          Result.isSuccess(result),
          `the defaults of ${group.name} failed its own schema`,
        );
      }
    }));

  it.effect("keeps every other field when one field is absent", () =>
    Effect.sync(() => {
      const full = defaultSettings();
      const keys = Object.keys(full);
      assert.isAbove(keys.length, 20, "the point is that there are many");

      for (const missing of keys) {
        const partial: Record<string, unknown> = { ...full };
        delete partial[missing];

        const parsed = decodeSettings(partial);
        assert.isTrue(
          Result.isSuccess(parsed),
          `dropping ${missing} rejected the whole object`,
        );
        if (Result.isFailure(parsed)) continue;
        // The defaults are what an empty object decodes to, so the result of
        // dropping one field must be the defaults again.
        assert.deepEqual(
          parsed.success,
          full,
          `dropping ${missing} changed another field`,
        );
      }
    }));

  it.effect("costs exactly one field when one field is corrupt", () =>
    Effect.sync(() => {
      const parsed = decodeSettings({
        ...defaultSettings(),
        scrollStepSize: "sixty",
        keyMappings: 42,
        exclusionRules: "not an array",
      });

      assert.isTrue(Result.isSuccess(parsed));
      if (Result.isFailure(parsed)) return;
      assert.strictEqual(parsed.success.scrollStepSize, 60);
      assert.strictEqual(parsed.success.keyMappings, "");
      assert.deepEqual(parsed.success.exclusionRules, []);
      // The neighbours that nobody touched stay as they are.
      assert.strictEqual(parsed.success.smoothScroll, true);
      assert.strictEqual(
        parsed.success.searchUrl,
        "https://www.google.com/search?q=%s",
      );
    }));

  it.effect("drops an unknown key from a newer build", () =>
    Effect.sync(() => {
      const parsed = decodeSettings({
        ...defaultSettings(),
        somethingFromTheFuture: { nested: true },
      });
      assert.isTrue(Result.isSuccess(parsed));
      if (Result.isFailure(parsed)) return;
      assert.isFalse("somethingFromTheFuture" in parsed.success);
    }));

  it.effect("demands distinct hint characters", () =>
    Effect.sync(() => {
      // A duplicate makes two hints answer to the same string.
      const parsed = decodeSettings({
        ...defaultSettings(),
        linkHintCharacters: "aabbcc",
      });
      assert.isTrue(Result.isSuccess(parsed));
      if (Result.isFailure(parsed)) return;
      assert.strictEqual(parsed.success.linkHintCharacters, "sadfjklewcmpgh");
    }));

  /**
   * Hint alphabets that a case fold breaks.
   *
   * Each row gives a stored value and the value that the decoder accepts.
   * `null` means that the field falls back to the shipped alphabet.
   */
  const HINT_ALPHABETS: readonly {
    readonly name: string;
    readonly stored: string;
    readonly expected: string | null;
  }[] = [
    {
      name: "the Turkish dotted capital I expands to i plus a dot",
      stored: "ab\u0130",
      expected: null,
    },
    {
      name: "the Turkish dotless i has the case fold of the Latin i",
      stored: "abi\u0131",
      expected: null,
    },
    {
      name: "the German sharp s expands to SS",
      stored: "ab\u00df",
      expected: null,
    },
    {
      name: "the Greek final sigma has the case fold of the sigma",
      stored: "\u03c3\u03c2",
      expected: null,
    },
    {
      name: "a plain duplicate is refused",
      stored: "aab",
      expected: null,
    },
    {
      name: "a Greek alphabet is kept",
      stored: "\u03b1\u03b2\u03b3",
      expected: "\u03b1\u03b2\u03b3",
    },
    {
      name: "an emoji alphabet is kept",
      stored: "\u{1f600}\u{1f601}",
      expected: "\u{1f600}\u{1f601}",
    },
    {
      name: "a mathematical alphabet is kept",
      stored: "\u{1d41a}\u{1d41b}\u{1d41c}",
      expected: "\u{1d41a}\u{1d41b}\u{1d41c}",
    },
    {
      name: "one emoji is one character, and one is too few",
      stored: "\u{1f600}",
      expected: null,
    },
    {
      name: "half of a surrogate pair is not a character",
      stored: "ab\ud83d",
      expected: null,
    },
    {
      name: "an ASCII alphabet is kept",
      stored: "asdfg",
      expected: "asdfg",
    },
    {
      // The reviewer's case. The variation selector draws nothing, so one
      // label was invisible and two looked the same.
      name: "a heart with a variation selector is refused",
      stored: "\u2764\ufe0f\u{1f600}",
      expected: null,
    },
    {
      name: "a family emoji with a zero width joiner is refused",
      stored: "\u{1f468}\u200d\u{1f469}",
      expected: null,
    },
    {
      name: "a letter with a combining accent is refused",
      stored: "e\u0301x",
      expected: null,
    },
    {
      name: "a letter that is already composed is kept",
      stored: "\u00e9x",
      expected: "\u00e9x",
    },
  ];

  for (const row of HINT_ALPHABETS) {
    it.effect(`decodes a hint alphabet: ${row.name}`, () =>
      Effect.sync(() => {
        const parsed = decodeSettings({
          ...defaultSettings(),
          linkHintCharacters: row.stored,
        });
        assert.isTrue(Result.isSuccess(parsed));
        if (Result.isFailure(parsed)) return;
        assert.strictEqual(
          parsed.success.linkHintCharacters,
          row.expected ?? "sadfjklewcmpgh",
        );
      }));
  }

  /**
   * The repair of a stored hint alphabet.
   *
   * A stored value can become invalid after an upgrade, and the user can edit
   * it in the storage viewer of the manager. The repair keeps the characters
   * that work, and it gives one line that the user reads in the HUD.
   */
  const REPAIRS: readonly {
    readonly name: string;
    readonly stored: string;
    readonly repaired: string;
    readonly says: readonly string[];
  }[] = [
    {
      name: "a German alphabet loses the sharp s only",
      stored: "asdfghjkl\u00df",
      repaired: "asdfghjkl",
      says: ["U+00DF", "case fold", "asdfghjkl"],
    },
    {
      name: "a heart loses its variation selector",
      stored: "\u2764\ufe0f\u{1f600}",
      repaired: "\u2764\u{1f600}",
      says: ["U+FE0F", "letter, a number"],
    },
    {
      name: "a repeated letter is dropped once",
      stored: "aAsdf",
      repaired: "asdf",
      says: ["repeats an earlier character"],
    },
    {
      name: "a combining accent joins the letter before it",
      stored: "e\u0301x",
      repaired: "\u00e9x",
      says: ["composed"],
    },
    {
      name: "a set that keeps one character is left to the schema",
      stored: "a\u00df",
      repaired: "a\u00df",
      says: ["Fewer than two characters"],
    },
  ];

  for (const row of REPAIRS) {
    it.effect(`repairs a stored alphabet: ${row.name}`, () =>
      Effect.sync(() => {
        const outcome = repairSettings({ linkHintCharacters: row.stored });
        const value = outcome.value as { linkHintCharacters: string };
        assert.strictEqual(value.linkHintCharacters, row.repaired);
        assert.lengthOf(outcome.notices, 1);
        const notice = outcome.notices[0] ?? "";
        for (const part of row.says) {
          assert.include(notice, part, `the message must name "${part}"`);
        }
      }));
  }

  it.effect("says nothing about a set that it does not change", () =>
    Effect.sync(() => {
      const outcome = repairSettings({
        linkHintCharacters: "sadfjklewcmpgh",
        linkHintNumbers: "0123456789",
      });
      assert.deepEqual(outcome.notices, []);
    }));

  it.effect("repairs a set of hint numbers as well", () =>
    Effect.sync(() => {
      const outcome = repairSettings({ linkHintNumbers: "012\ufe0f3" });
      const value = outcome.value as { linkHintNumbers: string };
      assert.strictEqual(value.linkHintNumbers, "0123");
      assert.include(outcome.notices[0] ?? "", "Hint number characters");
    }));

  it.effect("repairs a value to itself the second time", () =>
    Effect.sync(() => {
      const once = repairSettings({ linkHintCharacters: "asdfghjkl\u00df" });
      const twice = repairSettings(once.value);
      assert.deepEqual(twice.value, once.value);
      assert.deepEqual(twice.notices, []);
    }));

  it.effect("leaves data that is not an object alone", () =>
    Effect.sync(() => {
      for (const data of [null, 7, "text", [1, 2]]) {
        const outcome = repairSettings(data);
        assert.deepEqual(outcome.value, data);
        assert.deepEqual(outcome.notices, []);
      }
    }));

  it.effect("accepts the repaired value that it gives", () =>
    Effect.sync(() => {
      // The repair and the schema must agree. A repaired value that the schema
      // then refuses would still drop the whole field.
      for (const row of REPAIRS) {
        const outcome = repairSettings({
          ...defaultSettings(),
          linkHintCharacters: row.stored,
        });
        const parsed = decodeSettings(outcome.value);
        assert.isTrue(Result.isSuccess(parsed));
        if (Result.isFailure(parsed)) return;
        const expected = row.repaired === row.stored
          ? "sadfjklewcmpgh"
          : row.repaired;
        assert.strictEqual(parsed.success.linkHintCharacters, expected);
      }
    }));

  it.effect("falls back on a search URL that has no %s", () =>
    Effect.sync(() => {
      const parsed = decodeSettings({
        ...defaultSettings(),
        searchUrl: "https://example.com/search",
      });
      assert.isTrue(Result.isSuccess(parsed));
      if (Result.isFailure(parsed)) return;
      assert.strictEqual(
        parsed.success.searchUrl,
        "https://www.google.com/search?q=%s",
      );
    }));

  it.effect("ships the documented defaults", () =>
    Effect.sync(() => {
      const settings = defaultSettings();
      // The two that decide which path every other test takes.
      assert.strictEqual(settings.filterLinkHints, false);
      assert.strictEqual(settings.smoothScroll, true);
      // The two privacy switches, both off.
      assert.strictEqual(settings.enableHistoryIndex, false);
      assert.strictEqual(settings.enableSearchSuggestions, false);
      assert.lengthOf(settings.searchEngines.split("\n"), 5);
    }));

  it.effect("gives each group a distinct storage name", () =>
    Effect.sync(() => {
      const names = GROUPS.map((group) => group.name);
      assert.strictEqual(new Set(names).size, names.length);
      for (const group of GROUPS) {
        assert.isAtLeast(group.schemaVersion, 1);
      }
    }));

  it.effect("caps the number of URLs and keeps the newest", () =>
    Effect.sync(() => {
      const now = Date.now();
      const marks = markTable(
        LOCAL_MARK_URL_LIMIT + 50,
        (index) => now - index,
      );
      const pruned = pruneMarks(marks, now);

      assert.lengthOf(Object.keys(pruned.local), LOCAL_MARK_URL_LIMIT);
      assert.isTrue(
        "https://example.com/0" in pruned.local,
        "the newest stays",
      );
      assert.isFalse(
        `https://example.com/${LOCAL_MARK_URL_LIMIT + 49}` in pruned.local,
        "the oldest goes",
      );
    }));

  it.effect("expires a stale local mark and keeps every global mark", () =>
    Effect.sync(() => {
      const now = Date.now();
      const marks: Marks = {
        local: {
          "https://fresh.test/": {
            a: { scrollX: 0, scrollY: 0, savedAt: now - 1000 },
          },
          "https://stale.test/": {
            a: { scrollX: 0, scrollY: 0, savedAt: now - LOCAL_MARK_TTL_MS - 1 },
          },
        },
        global: {
          A: { url: "https://kept.test/", scrollX: 0, scrollY: 0, savedAt: 0 },
        },
      };

      const pruned = pruneMarks(marks, now);
      assert.deepEqual(Object.keys(pruned.local), ["https://fresh.test/"]);
      // The user names a global mark, so it is never expired.
      assert.deepEqual(Object.keys(pruned.global), ["A"]);
    }));
});
