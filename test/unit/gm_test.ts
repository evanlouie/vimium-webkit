/** The userscript manager capability selection. */

import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, MutableRef, Option, pipe } from "effect";
import { Dom } from "~/platform/Dom.ts";
import { Gm, type GmSurface, StoreKind } from "~/platform/Gm.ts";

/** The calls that one form of the value API received, in order. */
const callLog = () => {
  const calls = MutableRef.make<ReadonlyArray<string>>([]);
  return {
    record: (call: string): void => {
      pipe(calls, MutableRef.update(Array.append(call)));
    },
    calls: (): ReadonlyArray<string> => MutableRef.get(calls),
  };
};

describe("Gm value API selection", () => {
  it.effect("prefers a complete synchronous surface when both forms exist", () =>
    Effect.gen(function* () {
      const sync = callLog();
      const async = callLog();
      const surface: GmSurface = {
        namespace: Option.some({
          getValue: (key) => {
            async.record(`get:${key}`);
            return Promise.resolve("async");
          },
          setValue: (key, value) => {
            async.record(`set:${key}:${String(value)}`);
            return Promise.resolve();
          },
          deleteValue: (key) => {
            async.record(`delete:${key}`);
            return Promise.resolve();
          },
        }),
        info: null,
        getValueSync: Option.some((key) => {
          sync.record(`get:${key}`);
          return "sync";
        }),
        setValueSync: Option.some((key, value) => {
          sync.record(`set:${key}:${String(value)}`);
        }),
        deleteValueSync: Option.some((key) => {
          sync.record(`delete:${key}`);
        }),
        openInTabSync: Option.none(),
        setClipboardSync: Option.none(),
        xhrSync: Option.none(),
        addValueChangeListener: Option.none(),
        removeValueChangeListener: Option.none(),
        hasUnsafeWindow: false,
        windowClose: Option.none(),
      };

      yield* pipe(
        Effect.gen(function* () {
          const gm = yield* Gm;
          assert.isTrue(Option.isSome(gm.values));

          const values = yield* pipe(gm.values, Effect.fromOption);
          // The manager gives no change listener, so the store sees no write of
          // another tab.
          assert.deepEqual(values.kind, StoreKind.GmSync({ watchable: false }));
          assert.deepEqual(yield* values.get("one"), Option.some("sync"));
          yield* values.set("two", "value");
          yield* values.remove("three");

          assert.deepEqual(sync.calls(), ["get:one", "set:two:value", "delete:three"]);
          assert.deepEqual(async.calls(), []);
        }),
        Effect.provide(Gm.layerFrom(surface)),
        Effect.provide(Dom.layer),
      );
    }),
  );
});
