import { assert, assertEquals } from "@std/assert";
import {
  clipboardReader,
  clipboardWriter,
  probe,
  storageManager,
  userAgent,
} from "~/platform/ambient.ts";
import { detectGmSurface, type GmSurface } from "~/platform/gm.ts";
import { writeClipboard } from "~/platform/clipboard.ts";

const hostile = (): never => {
  throw new TypeError("undefined is not an object (evaluating 'x')");
};

/** Install accessors that throw on read, and undo it afterwards. */
const poison = (...names: readonly string[]): { restore(): void } => {
  const saved = names.map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get: hostile,
    });
  }
  return {
    restore: () => {
      for (const [name, descriptor] of saved) {
        if (descriptor === undefined) {
          Reflect.deleteProperty(globalThis, name);
        } else {
          Object.defineProperty(globalThis, name, descriptor);
        }
      }
    },
  };
};

const define = (name: string, value: unknown): { restore(): void } => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return {
    restore: () => {
      if (saved === undefined) {
        Reflect.deleteProperty(globalThis, name);
      } else {
        Object.defineProperty(globalThis, name, saved);
      }
    },
  };
};

Deno.test("probe answers with the fallback instead of throwing", () => {
  assertEquals(probe(() => "read", "fallback"), "read");
  assertEquals(probe<string>(hostile, "fallback"), "fallback");
});

Deno.test("navigator accessors degrade to absent when the read throws", () => {
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

Deno.test("a hostile GM binding costs one API, not the whole surface", () => {
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
Deno.test("writeClipboard falls back to the manager when navigator throws", () => {
  const navigator = poison("navigator");
  const copied: string[] = [];
  const surface: GmSurface = {
    ...detectGmSurface(),
    setClipboardSync: (data: string) => {
      copied.push(data);
    },
  };

  try {
    const result = writeClipboard(surface, "hello");
    assert(result.isOk());
    assertEquals(result.value.method, "gm-set-clipboard");
    assertEquals(copied, ["hello"]);
  } finally {
    navigator.restore();
  }
});
