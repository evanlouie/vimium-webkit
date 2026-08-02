/**
 * The overlay host under a page that fights it.
 *
 * These are the pure parts of `ui/Ui.ts`. A unit test runs in Node with no
 * DOM, so the guard takes a reader as an argument instead of an element. The
 * behaviour that needs a browser is in `test/e2e/overlay.spec.ts`.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { HOST_STYLE, outOfDateHostProperties } from "~/ui/Ui.ts";

/** A style that holds exactly what the overlay wrote. */
const intact = (
  property: string,
): readonly [string, string] => [
  HOST_STYLE.find(([name]) => name === property)?.[1] ?? "",
  "important",
];

describe("the overlay host style", () => {
  it.effect("writes every critical property", () =>
    Effect.sync(() => {
      const written = HOST_STYLE.map(([property]) => property);
      for (
        const property of [
          "all",
          "position",
          "top",
          "right",
          "bottom",
          "left",
          "pointer-events",
          "z-index",
          "display",
          // `all` does not cover these in every engine. WebKit leaves
          // `transform` out of the expansion, and a page rule of
          // `transform: scale(0) !important` then collapses the overlay.
          "transform",
          "visibility",
          "opacity",
          "clip-path",
          "filter",
        ]
      ) {
        assert.include(written, property);
      }
    }));

  it.effect("writes longhands, so that the guard can compare them", () =>
    Effect.sync(() => {
      // `inset` is a shorthand. An engine gives back an empty string for a
      // shorthand whose longhands disagree, and a later `position` declaration
      // makes them disagree, so the guard would rewrite the style for ever.
      const written = HOST_STYLE.map(([property]) => property);
      assert.notInclude(written, "inset");
    }));

  it.effect("finds nothing to do while the style is intact", () =>
    Effect.sync(() => {
      assert.deepEqual(outOfDateHostProperties(intact), []);
    }));

  it.effect("finds a property that the page overwrote", () =>
    Effect.sync(() => {
      const stale = outOfDateHostProperties((property) =>
        property === "display" ? ["none", "important"] : intact(property)
      );
      assert.deepEqual(stale, ["display"]);
    }));

  it.effect("finds a property that lost the important priority", () =>
    Effect.sync(() => {
      // A declaration without the priority loses to `vimium-webkit-overlay {
      // position: static !important }` in the stylesheet of the page.
      const stale = outOfDateHostProperties((property) =>
        property === "position" ? ["fixed", ""] : intact(property)
      );
      assert.deepEqual(stale, ["position"]);
    }));

  it.effect("finds every property when the style attribute is gone", () =>
    Effect.sync(() => {
      const stale = outOfDateHostProperties(() => ["", ""]);
      assert.isAbove(stale.length, 4);
    }));
});
