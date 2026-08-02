import { test } from "vitest";
import {
  bootStage0,
  isLiveRealm,
  isTopFrame,
  WAKE_MESSAGE,
} from "~/boot/stage0.ts";
import { assert, assertEquals, assertFalse } from "./support/assert.ts";
import {
  type GlobalScope,
  poisonGlobals,
  withGlobals,
} from "./support/globals.ts";

const GUARD = Symbol.for("vimium-webkit.stage0");

const GLOBALS = ["navigator", "document", "self", "top", "parent"] as const;

/**
 * The event-target half of a realm.
 *
 * A browser `window` is an `EventTarget`; a Node `globalThis` is not. The Deno
 * runtime this suite used to run under happened to provide one, so these tests
 * silently borrowed the host's. Building it here instead states the dependency,
 * and gives each test a listener set that cannot leak into the next one.
 */
const eventTargetGlobals = (): Readonly<Record<string, unknown>> => {
  const target = new EventTarget();
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
};

type Realm = "live-top" | "absent" | "hostile";

/**
 * Stand in for the globals of a realm we do not control.
 *
 * `hostile` is the one observed in the wild: reading the binding throws instead
 * of answering `undefined`, which is what a sandboxing manager's proxy or an
 * anti-fingerprinting shim does. `typeof` does not survive it either — it
 * performs the same read.
 */
const withRealm = (realm: Realm): GlobalScope => {
  if (realm === "hostile") return poisonGlobals(...GLOBALS);

  const values: Readonly<Record<string, unknown>> = realm === "live-top"
    ? {
      ...eventTargetGlobals(),
      navigator: { userAgent: "test" },
      document: {},
      self: globalThis,
      top: globalThis,
      parent: globalThis,
    }
    : {
      navigator: undefined,
      document: undefined,
      self: undefined,
      top: undefined,
      parent: undefined,
    };

  // The double-injection guard is realm state too: leaving it behind would
  // make the *next* `bootStage0` return `null` for the wrong reason.
  return withGlobals(values, () => {
    Reflect.deleteProperty(globalThis, GUARD);
  });
};

test("stage0 installs in a live realm", () => {
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

test("stage0 stays out of a realm with no globals", () => {
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

test("stage0 never throws into a hostile realm", () => {
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

/**
 * A `message` event whose `source` is a window, as a browser delivers it.
 *
 * Node's `MessageEvent` constructor accepts only a `MessagePort` as `source`,
 * where the DOM also allows a `Window` — and a `Window` is precisely what
 * Stage 0 checks for, since the whole point is that only an ancestor frame may
 * wake it. Defining the property on the instance reproduces the shape the
 * browser delivers without weakening what the test asserts.
 */
const messageEvent = (init: MessageEventInit): MessageEvent => {
  const { source, ...rest } = init;
  const event = new MessageEvent("message", rest);
  if (source !== undefined && source !== null) {
    Object.defineProperty(event, "source", {
      value: source,
      configurable: true,
    });
  }
  return event;
};

test("stage0 does not activate if its realm dies after boot", () => {
  const live = withRealm("live-top");
  let activations = 0;
  const stage0 = bootStage0({ onActivate: () => activations++ });
  assert(stage0 !== null);

  const dead = withRealm("absent");
  try {
    globalThis.dispatchEvent(
      messageEvent({
        data: WAKE_MESSAGE,
        source: globalThis as unknown as MessageEventSource,
      }),
    );
    assertEquals(activations, 0);
  } finally {
    stage0.dispose();
    dead.restore();
    live.restore();
  }
});

test("only an ancestor can wake stage0", () => {
  const realm = withRealm("live-top");
  let activations = 0;
  const stage0 = bootStage0({ onActivate: () => activations++ });
  assert(stage0 !== null);

  const post = (init: MessageEventInit): void => {
    globalThis.dispatchEvent(messageEvent(init));
  };

  try {
    // The shape a page used to be able to forge: the wake was a public string
    // with no source check, so any script could force the whole of Stage 1 into
    // every frame it could reach.
    post({ data: "vimium-webkit:wake" });
    post({ data: WAKE_MESSAGE });
    post({ data: WAKE_MESSAGE, source: new MessageChannel().port1 });
    assertEquals(activations, 0);

    post({
      data: WAKE_MESSAGE,
      source: globalThis as unknown as MessageEventSource,
    });
    assertEquals(activations, 1);
  } finally {
    stage0.dispose();
    realm.restore();
  }
});

test("stage0 publishes a sentinel, never its instance", () => {
  const realm = withRealm("live-top");
  const stage0 = bootStage0({ onActivate: () => {} });
  assert(stage0 !== null);

  try {
    // A live `Stage0` on the global would hand any page `dispose()`,
    // `adopt(handler)` and `drainBuffer()` — permanent disablement, keystroke
    // interception, and a read of everything typed before we booted.
    const published: unknown = (globalThis as Record<symbol, unknown>)[GUARD];
    assertEquals(published, true);

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, GUARD);
    assert(descriptor !== undefined);
    assertFalse(descriptor.writable);
    assertFalse(descriptor.enumerable);

    // Still a guard: a second install into the same realm is refused.
    assertEquals(bootStage0({ onActivate: () => {} }), null);
  } finally {
    stage0.dispose();
    realm.restore();
  }
});
