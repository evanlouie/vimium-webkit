import { Effect, Result } from "effect";
import { test } from "vitest";
import {
  clipboardReader,
  clipboardWriter,
  probe,
  storageManager,
  userAgent,
} from "~/platform/ambient.ts";
import { writeClipboard } from "~/platform/clipboard.ts";
import { detectGmSurface, type GmSurface } from "~/platform/gm.ts";
import { assert, assertEquals } from "./support/assert.ts";
import {
  type GlobalScope,
  poisonGlobals,
  withGlobals,
} from "./support/globals.ts";

const hostile = (): never => {
  throw new TypeError("undefined is not an object (evaluating 'x')");
};

/** Install accessors that throw on read, and undo it afterwards. */
const poison = (...names: readonly string[]): GlobalScope =>
  poisonGlobals(...names);

const define = (name: string, value: unknown): GlobalScope =>
  withGlobals({ [name]: value });

test("probe answers with the fallback instead of throwing", () => {
  assertEquals(probe(() => "read", "fallback"), "read");
  assertEquals(probe<string>(hostile, "fallback"), "fallback");
});

test("navigator accessors degrade to absent when the read throws", () => {
  const navigator = poison("navigator");
  try {
    assertEquals(userAgent(), "");
    assertEquals(clipboardWriter(), null);
    assertEquals(clipboardReader(), null);
    assertEquals(storageManager(), null);
  } finally {
    navigator.restore();
  }
});

test("a hostile GM binding costs one API, not the whole surface", () => {
  const poisoned = poison("GM_getValue");
  const healthy = define("GM_setValue", () => {});
  try {
    const surface = detectGmSurface();
    assertEquals(surface.getValueSync, null);
    assert(surface.setValueSync !== null);
  } finally {
    healthy.restore();
    poisoned.restore();
  }
});

/**
 * The fallback chain documented in `clipboard.ts` has to survive a hostile
 * `navigator`, not just an absent one \u2014 otherwise copying throws where it was
 * supposed to degrade to the manager's clipboard API.
 */
test("writeClipboard falls back to the manager when navigator throws", () => {
  const navigator = poison("navigator");
  const copied: string[] = [];
  const surface: GmSurface = {
    ...detectGmSurface(),
    setClipboardSync: (data: string) => {
      copied.push(data);
    },
  };

  try {
    // `runSync`, deliberately. The clipboard write has to reach the manager
    // inside the browser's transient-activation window, so nothing on this
    // path may suspend — and `runSync` throws if anything does. This assertion
    // is therefore also a guard on that property.
    const result = Effect.runSync(
      Effect.result(writeClipboard(surface, "hello")),
    );
    assert(Result.isSuccess(result));
    assertEquals(result.success.method, "gm-set-clipboard");
    assertEquals(copied, ["hello"]);
  } finally {
    navigator.restore();
  }
});
