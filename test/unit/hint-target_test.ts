/**
 * The check that a hint target is still the element that the user saw.
 *
 * A marker is drawn for an element, and the user then presses a key. Between
 * those two moments a container can scroll, the page can reflow, and the page
 * can put another element on top. The click must not land somewhere else.
 *
 * The two decisions of that check are pure: how far the target may move, and
 * what the hit stack of one point must hold.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  hintHasMoved,
  type HintShift,
  hitAccepts,
  MAX_HINT_DRIFT_PX,
  shiftedRect,
} from "~/features/hints/Hints.ts";

const rect = (left: number, top: number) => ({
  left,
  top,
  width: 40,
  height: 12,
});

const NO_SHIFT: HintShift = { dx: 0, dy: 0 };

describe("shiftedRect", () => {
  it.effect("moves a rect with its target and keeps its size", () =>
    Effect.sync(() => {
      assert.deepEqual(shiftedRect(rect(10, 20), { dx: 5, dy: -7 }), {
        left: 15,
        top: 13,
        width: 40,
        height: 12,
      });
    }));
});

describe("hintHasMoved", () => {
  it.effect("accepts a target that has not moved", () =>
    Effect.sync(() => {
      assert.isFalse(hintHasMoved(rect(10, 20), rect(10, 20), NO_SHIFT));
    }));

  it.effect("accepts the movement that the last draw followed", () =>
    Effect.sync(() => {
      // The container scrolled by 300 pixels, and the marker went with it.
      assert.isFalse(
        hintHasMoved(rect(10, 320), rect(10, 20), { dx: 0, dy: -300 }),
      );
    }));

  it.effect("refuses a target that moved after the last draw", () =>
    Effect.sync(() => {
      // The same scroll, and no draw followed it. The user aimed at the old
      // place, where the page now shows something else.
      assert.isTrue(hintHasMoved(rect(10, 320), rect(10, 20), NO_SHIFT));
      assert.isTrue(hintHasMoved(rect(10, 20), rect(90, 20), NO_SHIFT));
    }));

  it.effect("refuses five pixels of drift on a wide target", () =>
    Effect.sync(() => {
      const wide = { left: 10, top: 20, width: 400, height: 40 };
      const moved = { ...wide, left: 15 };
      assert.isTrue(hintHasMoved(wide, moved, NO_SHIFT));
    }));

  it.effect("allows a fraction of a pixel, and no more", () =>
    Effect.sync(() => {
      const inside = MAX_HINT_DRIFT_PX - 0.5;
      const outside = MAX_HINT_DRIFT_PX + 0.5;
      assert.isFalse(
        hintHasMoved(rect(10, 20), rect(10 + inside, 20), NO_SHIFT),
      );
      assert.isTrue(
        hintHasMoved(rect(10, 20), rect(10, 20 + outside), NO_SHIFT),
      );
    }));
});

describe("hitAccepts", () => {
  const isOverlay = (candidate: string): boolean => candidate === "overlay";
  const isOurs = (candidate: string): boolean =>
    candidate === "target" || candidate === "inside-target";

  it.effect("accepts the target at the front of the stack", () =>
    Effect.sync(() => {
      assert.isTrue(hitAccepts(["target", "body"], isOverlay, isOurs));
    }));

  it.effect("accepts something inside the target", () =>
    Effect.sync(() => {
      assert.isTrue(
        hitAccepts(["inside-target", "target"], isOverlay, isOurs),
      );
    }));

  it.effect("steps over our own overlay", () =>
    Effect.sync(() => {
      assert.isTrue(hitAccepts(["overlay", "target"], isOverlay, isOurs));
    }));

  it.effect("refuses a point that the page covered", () =>
    Effect.sync(() => {
      assert.isFalse(
        hitAccepts(["banner", "target", "body"], isOverlay, isOurs),
      );
    }));

  it.effect("refuses a point that hits nothing", () =>
    Effect.sync(() => {
      assert.isFalse(hitAccepts([], isOverlay, isOurs));
    }));
});
