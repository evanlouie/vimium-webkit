/**
 * The capability report, and the one capability that changes a key.
 *
 * `applePlatform` decides how a chord with Alt is read.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  type CapabilityReport,
  degradationWarnings,
  isApplePlatform,
} from "~/platform/Capabilities.ts";
import { StoreKind } from "~/platform/Gm.ts";

/** A report in which everything works, so one test changes one field. */
const healthy: CapabilityReport = {
  manager: "unknown",
  managerVersion: Option.none(),
  scriptVersion: Option.none(),
  world: "unknown",

  value: StoreKind.GmSync({ watchable: true }),
  openInTab: true,
  openInTabBackground: true,
  setClipboard: true,
  xhr: true,
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

describe("degradationWarnings", () => {
  it.effect("says nothing about storage when the manager has a store", () =>
    Effect.sync(() => {
      const warnings = degradationWarnings(healthy);
      assert.deepEqual(warnings, []);
    }),
  );
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
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) " +
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
    userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
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
    name: "a browser that says nothing",
    userAgent: "",
    platform: "",
    apple: false,
  },
];

describe("Capabilities", () => {
  it.effect.each(AGENTS)("names the platform: $name", ({ userAgent, platform, apple }) =>
    Effect.sync(() => {
      assert.strictEqual(isApplePlatform(userAgent, platform), apple);
    }),
  );
});
