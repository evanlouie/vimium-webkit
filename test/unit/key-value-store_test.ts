/**
 * The backend that the application gets from a manager.
 *
 * One property decides what the frames of a page may do: the kind of the
 * store. The value store of the manager is private to the manager, because the
 * page cannot read that store and every frame of the page reads the same
 * values. No other store is.
 *
 * A manager with no value API is the configuration that issue #3 names. This
 * test builds the real layer over such a manager, and it holds the kind that
 * the rest of the application reads.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream, pipe } from "effect";
import { Gm, GmError, StoreKind } from "~/platform/Gm.ts";
import { KeyValueStore } from "~/platform/KeyValueStore.ts";

const refuse = <A>(api: string): Effect.Effect<A, GmError> =>
  Effect.fail(new GmError({ reason: "unavailable", api, detail: "not in this test" }));

/** A manager that gives no value store, and nothing else. */
const noValueStore: Layer.Layer<Gm> = Layer.succeed(
  Gm,
  Gm.of({
    identity: {
      handler: Option.none(),
      handlerVersion: Option.none(),
      scriptVersion: Option.none(),
      injectInto: Option.none(),
    },
    values: Option.none(),
    hasUnsafeWindow: false,
    canOpenInTab: false,
    canSetClipboard: false,
    canRequest: false,
    canCloseWindow: false,
    openInTab: () => refuse("GM.openInTab"),
    setClipboard: () => refuse("GM.setClipboard"),
    request: () => refuse("GM.xmlHttpRequest"),
    closeWindow: refuse("window.close"),
  }),
);

describe("KeyValueStore", () => {
  it.effect("falls back to memory when the manager has no value API", () =>
    Effect.gen(function* () {
      const kv = yield* pipe(
        KeyValueStore,
        Effect.provide(pipe(KeyValueStore.layer, Layer.provide(noValueStore))),
      );

      // The whole cross-frame session hangs on this kind. A memory map belongs
      // to one frame, so it cannot carry a credential that two frames share.
      // It does not survive a page load, and it sees no write of another tab.
      assert.deepEqual(kv.kind, StoreKind.Memory());

      // The store still works. The application stays alive with no manager.
      yield* kv.set("k", "v");
      assert.deepEqual(yield* kv.get("k"), Option.some("v"));
      assert.deepEqual(yield* pipe(kv.changes("k"), Stream.runCollect), []);
    }),
  );
});
