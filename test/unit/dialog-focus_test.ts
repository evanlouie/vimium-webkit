/**
 * The focus trap of the dialogs.
 *
 * Both dialogs say `aria-modal="true"`, which tells a screen reader that
 * everything outside the dialog is unavailable. The keyboard must agree with
 * that claim, so the dialog mode takes Tab and moves the focus by hand.
 *
 * This is the pure part of that trap: which control takes the focus next. The
 * behaviour in a browser is in `test/e2e/a11y.spec.ts`.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { nextFocusIndex } from "~/ui/Dialog.ts";

describe("the focus trap of a dialog", () => {
  it.effect("goes to the first control from the dialog box", () =>
    Effect.sync(() => {
      // -1 is the dialog box itself, which takes the focus when the dialog
      // opens. Without the trap the first Tab left the overlay, and the focus
      // landed on `document.body`.
      assert.strictEqual(nextFocusIndex(3, -1, false), 0);
      assert.strictEqual(nextFocusIndex(3, -1, true), 2);
    }));

  it.effect("walks the controls in order", () =>
    Effect.sync(() => {
      assert.strictEqual(nextFocusIndex(3, 0, false), 1);
      assert.strictEqual(nextFocusIndex(3, 1, false), 2);
      assert.strictEqual(nextFocusIndex(3, 2, true), 1);
    }));

  it.effect("wraps at both ends, and never leaves the dialog", () =>
    Effect.sync(() => {
      assert.strictEqual(nextFocusIndex(3, 2, false), 0);
      assert.strictEqual(nextFocusIndex(3, 0, true), 2);
      assert.strictEqual(nextFocusIndex(1, 0, false), 0);
      assert.strictEqual(nextFocusIndex(1, 0, true), 0);
    }));

  it.effect("keeps the focus on a dialog that holds no control", () =>
    Effect.sync(() => {
      // -1 means the dialog box. The box carries `tabindex="-1"`, so it can
      // hold the focus while the trap has nothing else to give it.
      assert.strictEqual(nextFocusIndex(0, -1, false), -1);
      assert.strictEqual(nextFocusIndex(0, 2, true), -1);
    }));
});
