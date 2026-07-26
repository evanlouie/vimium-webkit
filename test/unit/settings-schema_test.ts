/**
 * The shipped configuration.
 *
 * Two properties this file exists to defend, both of which were broken:
 *
 * 1. **Adding a field is safe.** The module header said so; the schema made
 *    every field required and `#decode` returned the defaults for the *whole*
 *    group on any validation failure, so the first release that added a setting
 *    would have erased every user's configuration.
 * 2. **The defaults are the defaults.** There is exactly one list of them, and
 *    it is the schema. The e2e harness's hand-copied `BASE` had already drifted
 *    to one search engine against the five shipped here.
 */

import { assert, assertEquals } from "@std/assert";
import {
  defaultSettings,
  findHistoryGroup,
  historyGroup,
  LOCAL_MARK_TTL_MS,
  LOCAL_MARK_URL_LIMIT,
  type Marks,
  marksGroup,
  pruneMarks,
  sessionGroup,
  type Settings,
  settingsGroup,
  settingsSchema,
} from "~/settings/schema.ts";

const GROUPS = [
  settingsGroup,
  marksGroup,
  findHistoryGroup,
  historyGroup,
  sessionGroup,
];

Deno.test("every group's defaults satisfy its own schema", () => {
  // `defaultSettings()` is `settingsSchema.parse({})`, so a field added without
  // a fallback would throw here rather than at a user's `document-start`.
  for (const group of GROUPS) {
    const result = group.schema.safeParse(group.defaults());
    assert(result.success, `${group.name} defaults failed its own schema`);
  }
});

Deno.test("a payload missing a field keeps the other twenty-four", () => {
  const full = defaultSettings();
  const keys = Object.keys(full) as (keyof Settings)[];
  assert(keys.length > 20, "the point of this test is that there are many");

  for (const missing of keys) {
    const partial: Record<string, unknown> = { ...full };
    delete partial[missing];

    const parsed = settingsSchema.safeParse(partial);
    assert(parsed.success, `dropping ${missing} rejected the whole object`);
    assertEquals(
      parsed.data[missing],
      full[missing],
      `${missing} did not fall back to its default`,
    );

    for (const other of keys) {
      if (other === missing) continue;
      assertEquals(
        parsed.data[other],
        full[other],
        `dropping ${missing} disturbed ${other}`,
      );
    }
  }
});

Deno.test("one corrupt field costs exactly that field", () => {
  const parsed = settingsSchema.safeParse({
    ...defaultSettings(),
    scrollStepSize: "sixty",
    keyMappings: 42,
    exclusionRules: "not an array",
  });

  assert(parsed.success);
  assertEquals(parsed.data.scrollStepSize, 60);
  assertEquals(parsed.data.keyMappings, "");
  assertEquals(parsed.data.exclusionRules, []);
  // Untouched neighbours stay untouched.
  assertEquals(parsed.data.smoothScroll, true);
  assertEquals(parsed.data.searchUrl, "https://www.google.com/search?q=%s");
});

Deno.test("unknown keys from a newer build are dropped, not fatal", () => {
  const parsed = settingsSchema.safeParse({
    ...defaultSettings(),
    somethingFromTheFuture: { nested: true },
  });
  assert(parsed.success);
  assertEquals("somethingFromTheFuture" in parsed.data, false);
});

Deno.test("hint characters must be distinct", () => {
  // Duplicates silently make two hints answer to the same string.
  const parsed = settingsSchema.safeParse({
    ...defaultSettings(),
    linkHintCharacters: "aabbcc",
  });
  assert(parsed.success);
  assertEquals(parsed.data.linkHintCharacters, "sadfjklewcmpgh");
});

Deno.test("a search URL without %s falls back rather than discarding the query", () => {
  const parsed = settingsSchema.safeParse({
    ...defaultSettings(),
    searchUrl: "https://example.com/search",
  });
  assert(parsed.success);
  assertEquals(parsed.data.searchUrl, "https://www.google.com/search?q=%s");
});

Deno.test("the shipped defaults are the ones documented", () => {
  const settings = defaultSettings();
  // The two that decide which code path every other test exercises.
  assertEquals(settings.filterLinkHints, false);
  assertEquals(settings.smoothScroll, true);
  // The two privacy switches, both off.
  assertEquals(settings.enableHistoryIndex, false);
  assertEquals(settings.enableSearchSuggestions, false);
  assertEquals(settings.searchEngines.split("\n").length, 5);
});

// ---------------------------------------------------------------------------
// Mark growth
// ---------------------------------------------------------------------------

const markTable = (urls: number, at: (index: number) => number): Marks => {
  const local: Marks["local"] = {};
  for (let index = 0; index < urls; index++) {
    local[`https://example.com/${index}`] = {
      a: { scrollX: 0, scrollY: index, savedAt: at(index) },
    };
  }
  return { local, global: {} };
};

Deno.test("pruneMarks caps the number of URLs, keeping the newest", () => {
  const now = Date.now();
  const marks = markTable(LOCAL_MARK_URL_LIMIT + 50, (index) => now - index);
  const pruned = pruneMarks(marks, now);

  assertEquals(Object.keys(pruned.local).length, LOCAL_MARK_URL_LIMIT);
  assert("https://example.com/0" in pruned.local, "the newest is kept");
  assert(
    !(`https://example.com/${LOCAL_MARK_URL_LIMIT + 49}` in pruned.local),
    "the oldest is evicted",
  );
});

Deno.test("pruneMarks expires stale marks", () => {
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
  assertEquals(Object.keys(pruned.local), ["https://fresh.test/"]);
  // Global marks are explicitly named by the user and are never expired.
  assertEquals(Object.keys(pruned.global), ["A"]);
});
