/**
 * Where `*` and `#` start, and which match they land on.
 *
 * The rules are exercised through a caret and a set of matches on one line of
 * text. `comparePoint` is the only part of a `Range` that the anchor reads, so
 * the whole rule can be tested in Node, where there is no DOM.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { indexAtSelection } from "~/features/find/Engine.ts";

/**
 * A caret and a set of matches on one line of text.
 *
 * `comparePoint` answers exactly as a `Range` does: -1 when the point is before
 * the range, 0 when it is inside it or on one of its edges, and 1 when it is
 * after it.
 */
const caret = (offset: number): { focusNode: Node; focusOffset: number } => ({
  focusNode: { nodeType: 3 } as unknown as Node,
  focusOffset: offset,
});

const matchesAt = (
  ranges: ReadonlyArray<readonly [number, number]>,
): ReadonlyArray<
  { readonly range: { comparePoint: (node: Node, offset: number) => number } }
> =>
  ranges.map(([start, end]) => ({
    range: {
      comparePoint: (_node: Node, offset: number): number =>
        offset < start ? -1 : offset > end ? 1 : 0,
    },
  }));

/** The wrap of `Find.stepBy`, so the test asserts the match that the user sees. */
const step = (index: number, delta: number, count: number): number =>
  (((index + delta) % count) + count) % count;

/** Three occurrences on one line: `[10,15]`, `[30,35]` and `[50,55]`. */
const THREE = [[10, 15], [30, 35], [50, 55]] as const;

const landing = (point: number, direction: 1 | -1): number => {
  const matches = matchesAt(THREE);
  const anchor = indexAtSelection(caret(point), matches, direction);
  assert.isTrue(Option.isSome(anchor), "the anchor gave no opinion");
  return step(
    Option.getOrElse(anchor, () => 0),
    direction,
    THREE.length,
  );
};

describe("the anchor of `*` and `#`", () => {
  it.effect("leaves the match that holds the caret", () =>
    Effect.sync(() => {
      // The caret is inside the second occurrence. `*` goes to the third, and
      // `#` to the first. Vim does the same.
      assert.strictEqual(landing(32, 1), 2);
      assert.strictEqual(landing(32, -1), 0);
    }));

  it.effect("counts the edges of a match as inside it", () =>
    Effect.sync(() => {
      // A click at the end of a word leaves the caret on the edge.
      assert.strictEqual(landing(30, 1), 2);
      assert.strictEqual(landing(35, 1), 2);
      assert.strictEqual(landing(30, -1), 0);
      assert.strictEqual(landing(35, -1), 0);
    }));

  it.effect("takes the nearest match in the direction of the search", () =>
    Effect.sync(() => {
      // The caret sits between the first and the second occurrence. Forward
      // must give the second, and backward the first — and not the first
      // match of the page, whichever way the user went.
      assert.strictEqual(landing(20, 1), 1);
      assert.strictEqual(landing(20, -1), 0);
      assert.strictEqual(landing(40, 1), 2);
      assert.strictEqual(landing(40, -1), 1);
    }));

  it.effect("wraps when there is no match on that side", () =>
    Effect.sync(() => {
      // Before the first occurrence: forward gives the first, and backward
      // wraps to the last.
      assert.strictEqual(landing(0, 1), 0);
      assert.strictEqual(landing(0, -1), 2);
      // After the last occurrence: backward gives the last, and forward wraps
      // to the first.
      assert.strictEqual(landing(80, 1), 0);
      assert.strictEqual(landing(80, -1), 2);
    }));

  it.effect("gives no opinion when no match can be compared", () =>
    Effect.sync(() => {
      // `comparePoint` throws when the point is in another node tree, which is
      // usual once a shadow root is involved.
      const matches = [{
        range: {
          comparePoint: (): number => {
            throw new Error("wrong document");
          },
        },
      }];
      assert.isTrue(
        Option.isNone(indexAtSelection(caret(5), matches, 1)),
        "a match in another tree must hold no opinion",
      );
      assert.isTrue(
        Option.isNone(indexAtSelection(caret(5), [], 1)),
        "no match is no opinion",
      );
    }));

  it.effect("gives no opinion when the selection has no focus node", () =>
    Effect.sync(() => {
      const matches = matchesAt(THREE);
      assert.isTrue(
        Option.isNone(
          indexAtSelection({ focusNode: null, focusOffset: 0 }, matches, 1),
        ),
      );
    }));
});
