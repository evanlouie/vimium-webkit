import { assert, assertEquals, assertFalse } from "@std/assert";
import { bootStage0, isLiveRealm, isTopFrame } from "~/boot/stage0.ts";

const GUARD = Symbol.for("vimium-webkit.stage0");

const GLOBALS = ["navigator", "document", "self", "top"] as const;

type GlobalName = (typeof GLOBALS)[number];

type Realm = "live-top" | "absent" | "hostile";

/**
 * Stand in for the globals of a realm we do not control.
 *
 * `hostile` is the one observed in the wild: reading the binding throws instead
 * of answering `undefined`, which is what a sandboxing manager's proxy or an
 * anti-fingerprinting shim does. `typeof` does not survive it either — it
 * performs the same read.
 */
const withRealm = (realm: Realm): { restore(): void } => {
  const saved = GLOBALS.map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );

  const values: Record<GlobalName, unknown> = realm === "live-top"
    ? {
      navigator: { userAgent: "test" },
      document: {},
      self: globalThis,
      top: globalThis,
    }
    : {
      navigator: undefined,
      document: undefined,
      self: undefined,
      top: undefined,
    };

  for (const name of GLOBALS) {
    if (realm === "hostile") {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get: () => {
          throw new TypeError(
            `undefined is not an object (evaluating '${name}')`,
          );
        },
      });
      continue;
    }
    Object.defineProperty(globalThis, name, {
      value: values[name],
      configurable: true,
      writable: true,
    });
  }

  return {
    restore: () => {
      Reflect.deleteProperty(globalThis, GUARD);
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

Deno.test("stage0 installs in a live realm", () => {
  const realm = withRealm("live-top");
  try {
    assert(isLiveRealm());
    assert(isTopFrame());

    const stage0 = bootStage0({ onActivate: () => {} });
    assert(stage0 !== null);
    // `dispose` also clears the top-frame idle timer, so no op leaks.
    stage0.dispose();
  } finally {
    realm.restore();
  }
});

Deno.test("stage0 stays out of a realm with no globals", () => {
  const realm = withRealm("absent");
  try {
    // The trap this guards against: with the bindings gone, the obvious
    // top-frame test reads `undefined === undefined` and says yes.
    assertEquals(globalThis.top, globalThis.self);
    assertFalse(isLiveRealm());
    assertFalse(isTopFrame());

    assertEquals(bootStage0({ onActivate: () => {} }), null);
  } finally {
    realm.restore();
  }
});

Deno.test("stage0 never throws into a hostile realm", () => {
  const realm = withRealm("hostile");
  try {
    assertFalse(isLiveRealm());
    assertFalse(isTopFrame());

    // The contract is the absence of a throw: at `document-start` an exception
    // escaping here is an exception thrown into the page.
    assertEquals(bootStage0({ onActivate: () => {} }), null);
  } finally {
    realm.restore();
  }
});

Deno.test("stage0 does not activate if its realm dies after boot", () => {
  const live = withRealm("live-top");
  let activations = 0;
  const stage0 = bootStage0({ onActivate: () => activations++ });
  assert(stage0 !== null);

  const dead = withRealm("absent");
  try {
    globalThis.dispatchEvent(
      new MessageEvent("message", {
        data: "vimium-webkit:wake",
      }),
    );
    assertEquals(activations, 0);
  } finally {
    stage0.dispose();
    dead.restore();
    live.restore();
  }
});
