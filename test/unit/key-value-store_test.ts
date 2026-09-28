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
import { Effect, Layer, MutableRef, Option, Record, Stream, pipe } from "effect";
import { Gm, GmError, GmValueApi } from "~/platform/Gm.ts";
import { KeyValueStore } from "~/platform/KeyValueStore.ts";

/** A manager that gives the value API that the test names, and nothing else. */
const gmLayer = (values: Option.Option<GmValueApi>): Layer.Layer<Gm> => {
  const refuse = <A>(api: string): Effect.Effect<A, GmError> =>
    Effect.fail(new GmError({ reason: "unavailable", api, detail: "not in this test" }));
  return Layer.succeed(
    Gm,
    Gm.of({
      identity: {
        handler: Option.none(),
        handlerVersion: Option.none(),
        scriptVersion: Option.none(),
        injectInto: Option.none(),
        sandboxMode: Option.none(),
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
  const stored = MutableRef.make<Record.ReadonlyRecord<string, string>>({});
  const put = (key: string, value: string): void => {
    pipe(stored, MutableRef.update(Record.set(key, value)));
  };
  return GmValueApi.Sync({
    get: (key) => Effect.sync(() => pipe(MutableRef.get(stored), Record.get(key))),
    set: (key, value) => Effect.sync(() => put(key, value)),
    remove: (key) =>
      Effect.sync(() => {
        pipe(stored, MutableRef.update(Record.remove(key)));
      }),
    setUnsafe: put,
    changes: Option.none(),
  });
};

/** The real layer, over a manager that gives `values`. */
const storeOver = (values: Option.Option<GmValueApi>): Layer.Layer<KeyValueStore> =>
  pipe(KeyValueStore.layer, Layer.provide(gmLayer(values)));

describe("KeyValueStore", () => {
  it.effect("falls back to memory when the manager has no value API", () =>
    Effect.gen(function* () {
      const kv = yield* pipe(KeyValueStore, Effect.provide(storeOver(Option.none())));

      assert.strictEqual(kv.kind, "memory");
      assert.isFalse(kv.durable);
      assert.isFalse(kv.watchable);
      // The whole cross-frame session hangs on this field. A memory map belongs
      // to one frame, so it cannot carry a credential that two frames share.
      assert.isFalse(kv.managerPrivate);

      // The store still works. The application stays alive with no manager.
      yield* kv.set("k", "v");
      assert.deepEqual(yield* kv.get("k"), Option.some("v"));
      assert.deepEqual(yield* pipe(kv.changes("k"), Stream.runCollect), []);
    }),
  );

  it.effect("uses the manager value store when there is one", () =>
    Effect.gen(function* () {
      const kv = yield* pipe(KeyValueStore, Effect.provide(storeOver(Option.some(valueApi()))));

      assert.strictEqual(kv.kind, "gm-sync");
      assert.isTrue(kv.durable);
      assert.isTrue(kv.managerPrivate);
    }),
  );
});
