/**
 * The shipped configuration.
 *
 * Adding a field must be safe, because each field carries its own fallback.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  defaultSettings,
  LOCAL_MARK_TTL_MS,
  LOCAL_MARK_URL_LIMIT,
  type LocalMark,
  type Marks,
  pruneMarks,
  settingsSchema,
} from "~/domain/Persisted.ts";
import { decodeUnknown } from "~/platform/SchemaIo.ts";

/** Decode untrusted input and keep the detail of a failure. It never throws. */
const decodeSettings = decodeUnknown(settingsSchema);

/** A fixed instant, so no test reads the clock. */
const NOW = 1_800_000_000_000;

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
  it.effect("keeps every other field when one field is absent", () =>
    Effect.sync(() => {
      const full = defaultSettings();
      const keys = Object.keys(full);
      assert.isAbove(keys.length, 20, "the point is that there are many");

      for (const missing of keys) {
        const partial: Record<string, unknown> = { ...full };
        delete partial[missing];

        const parsed = decodeSettings(partial);
        assert.isTrue(Result.isSuccess(parsed), `dropping ${missing} rejected the whole object`);
        if (Result.isFailure(parsed)) continue;
        // The defaults are what an empty object decodes to, so the result of
        // dropping one field must be the defaults again.
        assert.deepEqual(parsed.success, full, `dropping ${missing} changed another field`);
      }
    }),
  );

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
      assert.strictEqual(parsed.success.searchUrl, "https://www.google.com/search?q=%s");
    }),
  );

  it.effect("removes duplicate hint characters during decoding", () =>
    Effect.sync(() => {
      // A duplicate makes two hints answer to the same string.
      const parsed = decodeSettings({
        ...defaultSettings(),
        linkHintCharacters: "aabbcc",
      });
      assert.isTrue(Result.isSuccess(parsed));
      if (Result.isFailure(parsed)) return;
      assert.strictEqual(parsed.success.linkHintCharacters, "abc");
    }),
  );

  it.effect("repairs hint number characters during decoding", () =>
    Effect.sync(() => {
      const parsed = decodeSettings({
        ...defaultSettings(),
        linkHintNumbers: "012\ufe0f3",
      });
      assert.isTrue(Result.isSuccess(parsed));
      if (Result.isFailure(parsed)) return;
      assert.strictEqual(parsed.success.linkHintNumbers, "0123");
    }),
  );

  it.effect("falls back on a search URL that has no %s", () =>
    Effect.sync(() => {
      const parsed = decodeSettings({
        ...defaultSettings(),
        searchUrl: "https://example.com/search",
      });
      assert.isTrue(Result.isSuccess(parsed));
      if (Result.isFailure(parsed)) return;
      assert.strictEqual(parsed.success.searchUrl, "https://www.google.com/search?q=%s");
    }),
  );

  it.effect("ships both privacy switches off", () =>
    Effect.sync(() => {
      const settings = defaultSettings();
      assert.strictEqual(settings.enableHistoryIndex, false);
      assert.strictEqual(settings.enableSearchSuggestions, false);
    }),
  );

  it.effect("caps the number of URLs and keeps the newest", () =>
    Effect.sync(() => {
      const now = NOW;
      const marks = markTable(LOCAL_MARK_URL_LIMIT + 50, (index) => now - index);
      const pruned = pruneMarks(marks, now);

      assert.lengthOf(Object.keys(pruned.local), LOCAL_MARK_URL_LIMIT);
      assert.isTrue("https://example.com/0" in pruned.local, "the newest stays");
      assert.isFalse(
        `https://example.com/${LOCAL_MARK_URL_LIMIT + 49}` in pruned.local,
        "the oldest goes",
      );
    }),
  );

  it.effect("expires a stale local mark and keeps every global mark", () =>
    Effect.sync(() => {
      const now = NOW;
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
    }),
  );
});
