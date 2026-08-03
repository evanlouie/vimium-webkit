/**
 * The button fields of the synthetic click sequence.
 *
 * A true mouse holds the primary button down for `mousedown` only. It is up
 * again before `mouseup` and before `click`. A control that reads `buttons`
 * refuses a click that says that the button is still down, or it stays in the
 * pressed state. The table below is the table of a native click.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { buttonStateFor } from "~/features/hints/Hints.ts";

describe("buttonStateFor", () => {
  it.effect("holds the primary button down for the two press events only", () =>
    Effect.sync(() => {
      assert.strictEqual(buttonStateFor("pointerdown").buttons, 1);
      assert.strictEqual(buttonStateFor("mousedown").buttons, 1);

      for (
        const type of [
          "pointerover",
          "mouseover",
          "pointerup",
          "mouseup",
          "click",
          "pointerout",
          "mouseout",
        ]
      ) {
        assert.strictEqual(
          buttonStateFor(type).buttons,
          0,
          `${type} must report no button down`,
        );
      }
    }));

  it.effect("names the primary button on every event that changes it", () =>
    Effect.sync(() => {
      for (
        const type of [
          "pointerdown",
          "mousedown",
          "pointerup",
          "mouseup",
          "click",
        ]
      ) {
        assert.strictEqual(
          buttonStateFor(type).button,
          0,
          `${type} must name the primary button`,
        );
      }
    }));

  it.effect("gives a pointer event that changes no button `button: -1`", () =>
    Effect.sync(() => {
      assert.strictEqual(buttonStateFor("pointerover").button, -1);
      assert.strictEqual(buttonStateFor("pointerout").button, -1);
      assert.strictEqual(buttonStateFor("pointermove").button, -1);
      // A mouse event of the same name carries `0`, which is what the
      // specification says. The two families differ here.
      assert.strictEqual(buttonStateFor("mouseover").button, 0);
      assert.strictEqual(buttonStateFor("mouseout").button, 0);
    }));
});
