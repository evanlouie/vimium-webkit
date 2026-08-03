/**
 * The backend that the application gets from a manager.
 *
 * One property decides what the frames of a page may do: `managerPrivate`. The
 * value store of the manager has it, because the page cannot read that store
 * and every frame of the page reads the same values. No other store has it.
 *
 * A manager with no value API is the configuration that issue #3 names. This
 * test builds the real layer over such a manager, and it holds the three fields
 * that the rest of the application reads.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { Gm, GmError, type GmValueApi } from "~/platform/Gm.ts";
import { KeyValueStore } from "~/platform/KeyValueStore.ts";

/** A manager that gives the value API that the test names, and nothing else. */
const gmLayer = (values: Option.Option<GmValueApi>): Layer.Layer<Gm> => {
  const refuse = <A>(api: string): Effect.Effect<A, GmError> =>
    Effect.fail(
      new GmError({ reason: "unavailable", api, detail: "not in this test" }),
    );
  return Layer.succeed(
    Gm,
    Gm.of({
      identity: {
        handler: null,
        handlerVersion: null,
        scriptVersion: null,
        injectInto: null,
        sandboxMode: null,
      },
      info: null,
      values,
      hasUnsafeWindow: false,
      canOpenInTab: false,
      canSetClipboard: false,
      canRequest: false,
      canRegisterMenuCommand: false,
      canCloseWindow: false,
      canAddStyle: false,
      openInTab: () => refuse("GM.openInTab"),
      setClipboard: () => refuse("GM.setClipboard"),
      request: () => refuse("GM.xmlHttpRequest"),
      registerMenuCommand: () => refuse("GM.registerMenuCommand"),
      closeWindow: refuse("window.close"),
    }),
  );
};

/** The value API of a manager that has one. */
const valueApi = (): GmValueApi => {
  const map = new Map<string, string>();
  return {
    kind: "gm-sync",
    get: (key) => Effect.sync(() => Option.fromNullishOr(map.get(key) ?? null)),
    set: (key, value) =>
      Effect.sync(() => {
        map.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        map.delete(key);
      }),
    setUnsafe: (key, value) => {
      map.set(key, value);
    },
    changes: Option.none(),
  };
};

describe("KeyValueStore", () => {
  it.effect("falls back to memory when the manager has no value API", () =>
    Effect.gen(function*() {
      const kv = yield* Effect.provide(
        KeyValueStore,
        KeyValueStore.layer.pipe(Layer.provide(gmLayer(Option.none()))),
      );

      assert.strictEqual(kv.kind, "memory");
      assert.isFalse(kv.durable);
      assert.isFalse(kv.watchable);
      // The whole cross-frame session hangs on this field. A memory map belongs
      // to one frame, so it cannot carry a credential that two frames share.
      assert.isFalse(kv.managerPrivate);

      // The store still works. The application stays alive with no manager.
      yield* kv.set("k", "v");
      assert.deepEqual(yield* kv.get("k"), Option.some("v"));
      assert.deepEqual(yield* Stream.runCollect(kv.changes("k")), []);
    }));

  it.effect("uses the manager value store when there is one", () =>
    Effect.gen(function*() {
      const kv = yield* Effect.provide(
        KeyValueStore,
        KeyValueStore.layer.pipe(
          Layer.provide(gmLayer(Option.some(valueApi()))),
        ),
      );

      assert.strictEqual(kv.kind, "gm-sync");
      assert.isTrue(kv.durable);
      assert.isTrue(kv.managerPrivate);
    }));
});
