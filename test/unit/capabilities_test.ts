import { assert, assertEquals, assertFalse } from "@std/assert";
import { probeCapabilities } from "~/platform/capabilities.ts";

const withNavigator = (
  descriptor: PropertyDescriptor,
): { restore(): void } => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    ...descriptor,
  });
  return {
    restore: () => {
      if (saved === undefined) {
        Reflect.deleteProperty(globalThis, "navigator");
      } else {
        Object.defineProperty(globalThis, "navigator", saved);
      }
    },
  };
};

const throwing = (): never => {
  // The shape reported from Safari, verbatim.
  throw new TypeError("undefined is not an object (evaluating 'navigator')");
};

Deno.test("probeCapabilities reports honestly with no DOM at all", () => {
  const caps = probeCapabilities();

  assertEquals(caps.manager, "unknown");
  assertFalse(caps.checkVisibility);
  assertFalse(caps.adoptedStyleSheets);
  assertFalse(caps.composedRanges);
});

Deno.test("probeCapabilities survives a navigator that throws when read", () => {
  const navigator = withNavigator({ get: throwing });
  try {
    const caps = probeCapabilities();
    assertFalse(caps.webkitLike);
    assertFalse(caps.clipboardWrite);
    assertFalse(caps.clipboardRead);
  } finally {
    navigator.restore();
  }
});

/**
 * The field report this file exists for.
 *
 * `navigator` answered `typeof "object"`, so every guard short of a `try`
 * passed it through \u2014 and then the `userAgent` getter threw, taking the whole
 * of Stage 1 with it. A `typeof` guard and `?.` both still perform the read.
 */
Deno.test("probeCapabilities survives a userAgent getter that throws", () => {
  const navigator = withNavigator({
    value: {
      get userAgent(): string {
        return throwing();
      },
      get clipboard(): unknown {
        return throwing();
      },
    },
  });
  try {
    assertEquals(typeof globalThis.navigator, "object");

    const caps = probeCapabilities();
    assertFalse(caps.webkitLike);
    assertFalse(caps.clipboardWrite);

    // Still a complete, usable answer rather than a half-built object.
    assert(Object.keys(caps).length > 20);
  } finally {
    navigator.restore();
  }
});
