/**
 * The warnings that a user must see.
 *
 * A capability that disappears without a message is worse than the loss itself.
 * A manager with no value store loses the most: the settings, the marks and the
 * history go when the page unloads, and the frames of the page cannot form a
 * session at all. The warning must name every one of those losses.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  type CapabilityReport,
  degradationWarnings,
} from "~/platform/Capabilities.ts";

/** A report in which everything works, so one test changes one field. */
const healthy: CapabilityReport = {
  manager: "unknown",
  managerVersion: null,
  scriptVersion: null,
  world: "unknown",

  value: "gm-sync",
  valueChangeListener: true,
  openInTab: true,
  openInTabBackground: true,
  setClipboard: true,
  xhr: true,
  menuCommand: true,
  windowClose: true,

  adoptedStyleSheets: true,
  constructableStyleSheets: true,
  checkVisibility: true,
  composedRanges: true,
  caretPositionFromPoint: true,
  caretRangeFromPoint: true,
  selectionModify: true,
  clipboardWrite: true,
  clipboardRead: true,
  idleCallback: true,
  visualViewport: true,
  secureContext: true,
  webkitLike: true,
};

/** The one warning that the memory backend raises. */
const memoryWarning = (): string => {
  const warnings = degradationWarnings({ ...healthy, value: "memory" });
  return warnings.find((line) => line.includes("durable storage")) ?? "";
};

describe("degradationWarnings", () => {
  it.effect("names every loss of a manager with no value store", () =>
    Effect.sync(() => {
      const warning = memoryWarning();
      assert.notStrictEqual(warning, "", "there is no warning at all");

      // What the user loses when the page unloads.
      for (const loss of ["settings", "marks", "history"]) {
        assert.include(warning, loss, `the warning does not name ${loss}`);
      }

      // The cross-frame session goes as well, and with it the commands that
      // need it. `frames/Auth.ts` keeps no credential in a store that one
      // frame cannot share with another.
      for (const loss of ["frames", "frame focus", "excluded"]) {
        assert.include(warning, loss, `the warning does not name ${loss}`);
      }
    }));

  it.effect("says nothing about storage when the manager has a store", () =>
    Effect.sync(() => {
      const warnings = degradationWarnings(healthy);
      assert.deepEqual(warnings, []);
    }));
});
