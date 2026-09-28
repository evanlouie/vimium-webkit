/**
 * The focus trap of the dialogs.
 *
 * Both dialogs say `aria-modal="true"`, which tells a screen reader that
 * everything outside the dialog is unavailable. The keyboard must agree with
 * that claim, so the dialog mode takes Tab and moves the focus by hand.
 *
 * This is the pure part of that trap: which control takes the focus next.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { nextFocusIndex } from "~/ui/Dialog.ts";

describe("the focus trap of a dialog", () => {
  it.effect("goes to the first control from the dialog box", () =>
    Effect.sync(() => {
      // `None` is the dialog box itself, which takes the focus when the
      // dialog opens. Without the trap the first Tab left the overlay, and the
      // focus landed on `document.body`.
      assert.deepEqual(nextFocusIndex(3, Option.none(), "forward"), Option.some(0));
      assert.deepEqual(nextFocusIndex(3, Option.none(), "backward"), Option.some(2));
    }),
  );

  it.effect("walks the controls in order", () =>
    Effect.sync(() => {
      assert.deepEqual(nextFocusIndex(3, Option.some(0), "forward"), Option.some(1));
      assert.deepEqual(nextFocusIndex(3, Option.some(1), "forward"), Option.some(2));
      assert.deepEqual(nextFocusIndex(3, Option.some(2), "backward"), Option.some(1));
    }),
  );

  it.effect("wraps at both ends, and never leaves the dialog", () =>
    Effect.sync(() => {
      assert.deepEqual(nextFocusIndex(3, Option.some(2), "forward"), Option.some(0));
      assert.deepEqual(nextFocusIndex(3, Option.some(0), "backward"), Option.some(2));
      assert.deepEqual(nextFocusIndex(1, Option.some(0), "forward"), Option.some(0));
      assert.deepEqual(nextFocusIndex(1, Option.some(0), "backward"), Option.some(0));
    }),
  );

  it.effect("keeps the focus on a dialog that holds no control", () =>
    Effect.sync(() => {
      // `None` means the dialog box. The box carries `tabindex="-1"`, so it can
      // hold the focus while the trap has nothing else to give it.
      assert.deepEqual(nextFocusIndex(0, Option.none(), "forward"), Option.none());
      assert.deepEqual(nextFocusIndex(0, Option.some(2), "backward"), Option.none());
    }),
  );
});
