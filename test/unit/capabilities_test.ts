/**
 * The capability report, and the one capability that changes a key.
 *
 * A capability that disappears without a message is worse than the loss itself.
 * A manager with no value store loses the most: the settings, the marks and the
 * history go when the page unloads, and the frames of the page cannot form a
 * session at all. The warning must name every one of those losses.
 *
 * `applePlatform` decides how a chord with Alt is read. Every other flag in the
 * report turns a feature off, and the probes for those need a browser, so they
 * belong in `test/e2e/`.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  type CapabilityReport,
  degradationWarnings,
  isApplePlatform,
  probeCapabilities,
} from "~/platform/Capabilities.ts";
import { Dom } from "~/platform/Dom.ts";
import { Gm } from "~/platform/Gm.ts";
import { KeyValueStore } from "~/platform/KeyValueStore.ts";
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
  applePlatform: false,
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

const AGENTS: readonly {
  readonly name: string;
  readonly userAgent: string;
  readonly platform: string;
  readonly apple: boolean;
}[] = [
  {
    name: "Safari on macOS",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    platform: "MacIntel",
    apple: true,
  },
  {
    name: "Safari on iPhone",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) " +
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 " +
      "Safari/604.1",
    platform: "iPhone",
    apple: true,
  },
  {
    name: "Safari on iPad, which reports a Macintosh",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    platform: "MacIntel",
    apple: true,
  },
  {
    name: "Chrome on Windows",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, " +
      "like Gecko) Chrome/124.0.0.0 Safari/537.36",
    platform: "Win32",
    apple: false,
  },
  {
    name: "Firefox on Linux",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
    platform: "Linux x86_64",
    apple: false,
  },
  {
    name: "Chrome on Android",
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, " +
      "like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
    apple: false,
  },
  {
    name: "the platform identifies macOS when the user agent says nothing",
    userAgent: "",
    platform: "MacIntel",
    apple: true,
  },
  {
    name: "Playwright WebKit on Linux reports a Macintosh user agent",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/18.5 Safari/605.1.15",
    platform: "Linux x86_64",
    // This is a known false positive. No feature test can identify Option.
    apple: true,
  },
  {
    name: "a browser that says nothing",
    userAgent: "",
    platform: "",
    apple: false,
  },
];

/** Supply a navigator without a change to the global test window. */
const domWithNavigator = (
  userAgent: string,
  platform: string,
): Layer.Layer<Dom> =>
  Layer.effect(
    Dom,
    Effect.map(Dom, (dom) => {
      const win = Object.create(dom.window) as Window & typeof globalThis;
      Object.defineProperty(win, "navigator", {
        value: { userAgent, platform },
      });
      return Dom.of({ ...dom, window: win });
    }),
  ).pipe(Layer.provide(Dom.layer));

describe("Capabilities", () => {
  for (const row of AGENTS) {
    it.effect(`names the platform: ${row.name}`, () =>
      Effect.sync(() => {
        assert.strictEqual(
          isApplePlatform(row.userAgent, row.platform),
          row.apple,
        );
      }));
  }

  it.effect("reads the Apple platform flag from the navigator probe", () => {
    const dom = domWithNavigator("", "MacIntel");
    const support = Layer.mergeAll(
      dom,
      Layer.provide(Gm.layer, dom),
      KeyValueStore.layerMemory,
    );
    return Effect.gen(function*() {
      const report = yield* probeCapabilities;
      assert.isTrue(report.applePlatform);
    }).pipe(Effect.provide(support));
  });
});
