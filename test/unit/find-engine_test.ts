/**
 * The find engine's DOM-independent half.
 *
 * The walk itself needs a browser, but everything that can silently produce a
 * *wrong* result does not: whitespace folding must not change string lengths
 * (offsets stop mapping back to text nodes if it does), span collection must
 * terminate on zero-width patterns, and offset → chunk mapping must put a
 * match's end on the closing side of a node boundary rather than the opening
 * one.
 */

import { assertEquals } from "@std/assert";
import {
  chunkStarts,
  collectSpans,
  firstMatchInView,
  locateOffset,
  normaliseHaystack,
  wordAt,
} from "~/features/find/engine.ts";

// ---------------------------------------------------------------------------
// Whitespace folding
// ---------------------------------------------------------------------------

Deno.test("normaliseHaystack folds whitespace without changing length", () => {
  const source = "sign\n\tin\u00a0now\u2003please";
  const folded = normaliseHaystack(source);
  assertEquals(folded, "sign  in now please");
  // Load-bearing: every offset in the folded string has to name the same
  // character in the original.
  assertEquals(folded.length, source.length);
});

Deno.test("normaliseHaystack leaves ordinary text alone", () => {
  assertEquals(normaliseHaystack("hello world"), "hello world");
  assertEquals(normaliseHaystack(""), "");
});

// ---------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------

Deno.test("collectSpans finds every non-overlapping match", () => {
  assertEquals(collectSpans("abcabc", /abc/g), [
    { start: 0, end: 3 },
    { start: 3, end: 6 },
  ]);
});

Deno.test("collectSpans works with a non-global regex", () => {
  // Callers should not have to remember the `g` flag; the engine clones.
  assertEquals(collectSpans("aXaXa", /a/), [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
    { start: 4, end: 5 },
  ]);
});

Deno.test("collectSpans never mutates the caller's regex", () => {
  const pattern = /a/g;
  pattern.lastIndex = 3;
  collectSpans("aaaa", pattern);
  assertEquals(pattern.lastIndex, 3);
});

Deno.test("collectSpans ignores zero-width matches instead of hanging", () => {
  // `x*` matches the empty string at every position; without the guard this
  // never advances and the tab locks up.
  assertEquals(collectSpans("aaa", /x*/g), []);
  assertEquals(collectSpans("axa", /x*/g), [{ start: 1, end: 2 }]);
  assertEquals(collectSpans("abc", /^/g), []);
});

Deno.test("collectSpans honours the limit", () => {
  assertEquals(collectSpans("aaaaa", /a/g, 2).length, 2);
  assertEquals(collectSpans("aaaaa", /a/g, 0).length, 0);
});

Deno.test("collectSpans on an empty haystack finds nothing", () => {
  assertEquals(collectSpans("", /a/g), []);
});

// ---------------------------------------------------------------------------
// Offsets
// ---------------------------------------------------------------------------

Deno.test("chunkStarts is the exclusive prefix sum", () => {
  assertEquals(chunkStarts([3, 0, 4, 2]), [0, 3, 3, 7]);
  assertEquals(chunkStarts([]), []);
});

Deno.test("locateOffset maps into the owning chunk", () => {
  const lengths = [3, 4, 2];
  const starts = chunkStarts(lengths);

  assertEquals(locateOffset(starts, lengths, 0), { index: 0, offset: 0 });
  assertEquals(locateOffset(starts, lengths, 2), { index: 0, offset: 2 });
  assertEquals(locateOffset(starts, lengths, 4), { index: 1, offset: 1 });
  assertEquals(locateOffset(starts, lengths, 8), { index: 2, offset: 1 });
});

Deno.test("locateOffset puts a boundary on the opening chunk by default", () => {
  const lengths = [3, 4];
  const starts = chunkStarts(lengths);
  // Offset 3 is both "end of chunk 0" and "start of chunk 1". A match *start*
  // wants the latter.
  assertEquals(locateOffset(starts, lengths, 3), { index: 1, offset: 0 });
});

Deno.test("locateOffset puts a boundary on the closing chunk when asked", () => {
  const lengths = [3, 4];
  const starts = chunkStarts(lengths);
  // A match *end* wants the former, or the range gets a boundary in the next
  // node and renders no client rects.
  assertEquals(locateOffset(starts, lengths, 3, true), { index: 0, offset: 3 });
  assertEquals(locateOffset(starts, lengths, 7, true), { index: 1, offset: 4 });
});

Deno.test("locateOffset rejects out-of-range offsets", () => {
  const lengths = [3];
  const starts = chunkStarts(lengths);
  assertEquals(locateOffset(starts, lengths, -1), null);
  assertEquals(locateOffset(starts, lengths, 4), null);
  assertEquals(locateOffset([], [], 0), null);
});

Deno.test("a match spanning two chunks maps to both ends", () => {
  // "sig" + "n in" — the shape produced by `<b>sig</b>n in`.
  const lengths = [3, 4];
  const starts = chunkStarts(lengths);
  const haystack = "sign in";
  const [span] = collectSpans(haystack, /sign/g);
  assertEquals(span, { start: 0, end: 4 });

  assertEquals(locateOffset(starts, lengths, 0), { index: 0, offset: 0 });
  assertEquals(locateOffset(starts, lengths, 4, true), { index: 1, offset: 1 });
});

// ---------------------------------------------------------------------------
// Word extraction
// ---------------------------------------------------------------------------

Deno.test("wordAt returns the word under the offset", () => {
  const text = "the quick brown fox";
  assertEquals(wordAt(text, 0), "the");
  assertEquals(wordAt(text, 2), "the");
  assertEquals(wordAt(text, 6), "quick");
  assertEquals(wordAt(text, 16), "fox");
});

Deno.test("wordAt looks left when the caret sits just past a word", () => {
  // Where a click usually leaves the caret; Vim does the same.
  assertEquals(wordAt("the quick", 3), "the");
  assertEquals(wordAt("the quick", 9), "quick");
});

Deno.test("wordAt returns nothing in open whitespace", () => {
  // One space past the word still looks left; two do not.
  assertEquals(wordAt("a  b", 1), "a");
  assertEquals(wordAt("a  b", 2), "");
  assertEquals(wordAt("   ", 1), "");
  assertEquals(wordAt("", 0), "");
});

Deno.test("wordAt treats digits and underscores as word characters", () => {
  assertEquals(wordAt("foo_bar42 baz", 4), "foo_bar42");
});

Deno.test("wordAt is not limited to ASCII", () => {
  assertEquals(wordAt("привет мир", 2), "привет");
  assertEquals(wordAt("naïve café", 7), "café");
});

Deno.test("wordAt clamps an out-of-range offset", () => {
  assertEquals(wordAt("word", 99), "word");
  assertEquals(wordAt("word", -5), "word");
});

// ---------------------------------------------------------------------------
// Initial match selection
// ---------------------------------------------------------------------------

Deno.test("firstMatchInView skips matches above the fold", () => {
  assertEquals(
    firstMatchInView([
      { rect: { bottom: -120 } },
      { rect: { bottom: -1 } },
      { rect: { bottom: 40 } },
      { rect: { bottom: 900 } },
    ]),
    2,
  );
});

Deno.test("firstMatchInView falls back to the first match", () => {
  assertEquals(firstMatchInView([{ rect: { bottom: -50 } }]), 0);
  assertEquals(firstMatchInView([{ rect: null }]), 0);
  assertEquals(firstMatchInView([]), 0);
});
