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
