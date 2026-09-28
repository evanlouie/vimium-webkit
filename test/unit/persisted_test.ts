/**
 * The shipped configuration.
 *
 * Adding a field must be safe, because each field carries its own fallback.
 */

import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Record, Result, Struct, pipe } from "effect";
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

const markTable = (urls: number, at: (index: number) => number): Marks => ({
  local: pipe(
    urls,
    Array.makeBy((index): readonly [string, Record<string, LocalMark>] => [
      `https://example.com/${index}`,
      { a: { scrollX: 0, scrollY: index, savedAt: at(index) } },
    ]),
    Record.fromEntries,
  ),
  global: {},
});

describe("Persisted", () => {
  it.effect("keeps every other field when one field is absent", () =>
    Effect.sync(() => {
      const full = defaultSettings();
      const keys = Record.keys(full);
      assert.isAbove(keys.length, 20, "the point is that there are many");

      pipe(
        keys,
        Array.forEach((missing) => {
          const parsed = pipe(full, Struct.omit([missing]), decodeSettings);
          assert.isTrue(Result.isSuccess(parsed), `dropping ${missing} rejected the whole object`);
          // The defaults are what an empty object decodes to, so the result of
          // dropping one field must be the defaults again.
          assert.deepEqual(
            parsed,
            Result.succeed(full),
            `dropping ${missing} changed another field`,
          );
        }),
      );
    }),
  );

  it.effect("costs exactly one field when one field is corrupt", () =>
    Effect.sync(() => {
      const parsed = pipe(
        defaultSettings(),
        Struct.assign({
          scrollStepSize: "sixty",
          keyMappings: 42,
          exclusionRules: "not an array",
        }),
        decodeSettings,
      );

      assert.isTrue(Result.isSuccess(parsed));
      const fields = pipe(
        parsed,
        Result.map(
          Struct.pick([
            "scrollStepSize",
            "keyMappings",
            "exclusionRules",
            "smoothScroll",
            "searchUrl",
          ]),
        ),
      );
      assert.deepEqual(
        fields,
        Result.succeed({
          scrollStepSize: 60,
          keyMappings: "",
          exclusionRules: [],
          // The neighbours that nobody touched stay as they are.
          smoothScroll: true,
          searchUrl: "https://www.google.com/search?q=%s",
        }),
      );
    }),
  );

  it.effect("removes duplicate hint characters during decoding", () =>
    Effect.sync(() => {
      // A duplicate makes two hints answer to the same string.
      const parsed = pipe(
        defaultSettings(),
        Struct.assign({ linkHintCharacters: "aabbcc" }),
        decodeSettings,
      );
      assert.isTrue(Result.isSuccess(parsed));
      const linkHintCharacters = pipe(
        parsed,
        Result.map((settings) => settings.linkHintCharacters),
      );
      assert.deepEqual(linkHintCharacters, Result.succeed("abc"));
    }),
  );

  it.effect("repairs hint number characters during decoding", () =>
    Effect.sync(() => {
      const parsed = pipe(
        defaultSettings(),
        Struct.assign({ linkHintNumbers: "012\ufe0f3" }),
        decodeSettings,
      );
      assert.isTrue(Result.isSuccess(parsed));
      const linkHintNumbers = pipe(
        parsed,
        Result.map((settings) => settings.linkHintNumbers),
      );
      assert.deepEqual(linkHintNumbers, Result.succeed("0123"));
    }),
  );

  it.effect("falls back on a search URL that has no %s", () =>
    Effect.sync(() => {
      const parsed = pipe(
        defaultSettings(),
        Struct.assign({ searchUrl: "https://example.com/search" }),
        decodeSettings,
      );
      assert.isTrue(Result.isSuccess(parsed));
      const searchUrl = pipe(
        parsed,
        Result.map((settings) => settings.searchUrl),
      );
      assert.deepEqual(searchUrl, Result.succeed("https://www.google.com/search?q=%s"));
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

      assert.lengthOf(Record.keys(pruned.local), LOCAL_MARK_URL_LIMIT);
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
      assert.deepEqual(Record.keys(pruned.local), ["https://fresh.test/"]);
      // The user names a global mark, so it is never expired.
      assert.deepEqual(Record.keys(pruned.global), ["A"]);
    }),
  );
});
