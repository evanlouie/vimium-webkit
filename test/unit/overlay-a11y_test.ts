/**
 * What assistive technology can reach, and what the HUD line says.
 *
 * These are the pure parts of `ui/Ui.ts` and `ui/Hud.ts`. A unit test runs in
 * Node with no DOM, so each function takes what it needs as an argument. The
 * behaviour that needs a browser is in `test/e2e/a11y.spec.ts`.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  type HudLine,
  type HudState,
  regionText,
  statusText,
  visibleLine,
} from "~/ui/Hud.ts";
import { anyHeld, shiftHold } from "~/ui/Ui.ts";

const EMPTY_STATE: HudState = {
  transient: Option.none(),
  indicator: Option.none(),
  pending: Option.none(),
  prompt: Option.none(),
};

describe("exposure to assistive technology", () => {
  it.effect("hides the host while no layer holds it", () =>
    Effect.sync(() => {
      assert.isFalse(anyHeld(new Map<string, number>()));
      assert.isFalse(anyHeld(new Map([["dialog", 0]])));
      assert.isTrue(anyHeld(new Map([["hints", 0], ["dialog", 1]])));
    }));

  it.effect("keeps a layer open until the last hold goes", () =>
    Effect.sync(() => {
      // The settings dialog opens over the help dialog, so the same layer
      // carries two holds for a moment.
      let holds = shiftHold(new Map<string, number>(), "dialog", 1);
      holds = shiftHold(holds, "dialog", 1);
      holds = shiftHold(holds, "dialog", -1);
      assert.isTrue(anyHeld(holds));
      holds = shiftHold(holds, "dialog", -1);
      assert.isFalse(anyHeld(holds));
    }));

  it.effect("never counts below zero", () =>
    Effect.sync(() => {
      const holds = shiftHold(new Map<string, number>(), "hud", -1);
      assert.strictEqual(holds.get("hud"), 0);
      assert.isFalse(anyHeld(holds));
    }));
});

describe("the two live regions of the HUD", () => {
  const error: HudLine = { text: "No matches", tone: "error" };
  const info: HudLine = { text: "3/17", tone: "info" };

  it.effect("interrupts the user for an error, and waits otherwise", () =>
    Effect.sync(() => {
      // Two regions, and not one region whose politeness changes. Several
      // readers keep the politeness that a region had when it entered the
      // tree, so a region that became assertive with its text would announce
      // an error politely, or not at all.
      assert.deepEqual(regionText(Option.some(error)), {
        polite: "",
        urgent: "No matches",
      });
      assert.deepEqual(regionText(Option.some(info)), {
        polite: "3/17",
        urgent: "",
      });
    }));

  it.effect("clears both regions while the HUD says nothing", () =>
    Effect.sync(() => {
      // A region that kept the last text would hold two lines on screen, and
      // a reader would say the older one again at the next change.
      assert.deepEqual(regionText(Option.none()), { polite: "", urgent: "" });
    }));
});

describe("the HUD line", () => {
  it.effect("says nothing while nothing is on screen", () =>
    Effect.sync(() => {
      assert.isTrue(Option.isNone(visibleLine(EMPTY_STATE)));
      assert.strictEqual(statusText(EMPTY_STATE), "");
    }));

  it.effect("prefers a message, then the keys, then the mode", () =>
    Effect.sync(() => {
      const full: HudState = {
        transient: Option.some({ text: "Saved", tone: "info" }),
        indicator: Option.some("Insert mode"),
        pending: Option.some("g"),
        prompt: Option.none(),
      };
      assert.deepEqual(
        visibleLine(full),
        Option.some({ text: "Saved", tone: "info" }),
      );
      assert.deepEqual(
        visibleLine({ ...full, transient: Option.none() }),
        Option.some({ text: "g", tone: "info" }),
      );
      assert.deepEqual(
        visibleLine({
          ...full,
          transient: Option.none(),
          pending: Option.none(),
        }),
        Option.some({ text: "Insert mode", tone: "info" }),
      );
    }));

  it.effect("puts the keys and the mode beside an open prompt", () =>
    Effect.sync(() => {
      assert.strictEqual(
        statusText({ ...EMPTY_STATE, pending: Option.some("2g") }),
        "2g",
      );
      assert.strictEqual(
        statusText({ ...EMPTY_STATE, indicator: Option.some("3/17") }),
        "3/17",
      );
    }));
});
