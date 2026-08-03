/** The userscript manager capability selection. */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { Dom } from "~/platform/Dom.ts";
import { Gm, type GmSurface } from "~/platform/Gm.ts";

describe("Gm value API selection", () => {
  it.effect("prefers a complete synchronous surface when both forms exist", () =>
    Effect.gen(function*() {
      const syncCalls: string[] = [];
      const asyncCalls: string[] = [];
      const surface: GmSurface = {
        namespace: {
          getValue: (key) => {
            asyncCalls.push(`get:${key}`);
            return Promise.resolve("async");
          },
          setValue: (key, value) => {
            asyncCalls.push(`set:${key}:${String(value)}`);
            return Promise.resolve();
          },
          deleteValue: (key) => {
            asyncCalls.push(`delete:${key}`);
            return Promise.resolve();
          },
        },
        info: null,
        getValueSync: (key) => {
          syncCalls.push(`get:${key}`);
          return "sync";
        },
        setValueSync: (key, value) => {
          syncCalls.push(`set:${key}:${String(value)}`);
        },
        deleteValueSync: (key) => {
          syncCalls.push(`delete:${key}`);
        },
        openInTabSync: null,
        setClipboardSync: null,
        xhrSync: null,
        addValueChangeListener: null,
        registerMenuCommand: null,
        addStyle: null,
        hasUnsafeWindow: false,
        windowClose: null,
      };

      yield* Effect.gen(function*() {
        const gm = yield* Gm;
        assert.isTrue(Option.isSome(gm.values));
        if (Option.isNone(gm.values)) return;

        const values = gm.values.value;
        assert.strictEqual(values.kind, "gm-sync");
        assert.deepEqual(yield* values.get("one"), Option.some("sync"));
        yield* values.set("two", "value");
        yield* values.remove("three");

        assert.deepEqual(syncCalls, [
          "get:one",
          "set:two:value",
          "delete:three",
        ]);
        assert.deepEqual(asyncCalls, []);
      }).pipe(
        Effect.provide(Gm.layerFrom(surface)),
        Effect.provide(Dom.layer),
      );
    }));
});
