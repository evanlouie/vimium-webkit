/**
 * Does a changed value reach the backend when the page goes away?
 *
 * This is the acceptance test of issue #11, and it uses the real parts: the
 * real `Storage`, the real `Lifecycle`, the real exit hook of
 * `boot/Bootstrap.ts`, and a key-value backend whose write is synchronous. The
 * stub has the `gm-sync` shape of a real manager.
 *
 * The test does what the browser does. It takes the `pagehide` listener that
 * the layer registered, and it runs that listener with `runSyncExit`, exactly
 * as `platform/Dom.ts` does. What the backend holds when that run returns is
 * everything that a dying page can save. A macrotask that starts inside
 * `pagehide` never runs, in WebKit, in Chromium and in Firefox.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Ref, Stream } from "effect";
import { onPageExit } from "~/boot/Bootstrap.ts";
import { Lifecycle } from "~/boot/Lifecycle.ts";
import { defaultSettings } from "~/domain/Persisted.ts";
import { Dom } from "~/platform/Dom.ts";
import { KeyValueStore, STORAGE_PREFIX } from "~/platform/KeyValueStore.ts";
import { Storage } from "~/platform/Storage.ts";

const SETTINGS_KEY = `${STORAGE_PREFIX}settings`;

// ---------------------------------------------------------------------------
// The stubs
// ---------------------------------------------------------------------------

interface Attached {
  readonly type: string;
  readonly run: (event: Event) => Effect.Effect<void>;
}

/** `Dom`, with `listen` recording and a visible document. */
const recordingDom = (
  attached: Ref.Ref<ReadonlyArray<Attached>>,
): Layer.Layer<Dom> =>
  Layer.effect(
    Dom,
    Effect.map(Dom, (dom) =>
      Dom.of({
        ...dom,
        document: { visibilityState: "visible" } as unknown as Document,
        href: Effect.succeed("https://example.test/one"),
        // The cast says what the stub already is: every listener of the
        // lifecycle needs no service, so a recorded body is an `Effect<void>`.
        listen: ((
          _target: unknown,
          type: unknown,
          handler: (event: Event) => Effect.Effect<void>,
        ) =>
          Ref.update(attached, (current) => [
            ...current,
            { type: String(type), run: handler },
          ])) as unknown as Dom["Service"]["listen"],
      })),
  ).pipe(Layer.provide(Dom.layer));

/** What the backend saw, and when. */
interface Backend {
  readonly layer: Layer.Layer<KeyValueStore>;
  /** Every value that reached the backend, read with no effect. */
  readonly writesNow: () => readonly string[];
  /** The raw value under one key, read with no effect. */
  readonly readNow: (key: string) => string | undefined;
}

/**
 * A backend with a synchronous write.
 *
 * This is the shape of the durable `gm-sync` backend. Its direct write uses
 * the synchronous `GM_setValue` surface.
 */
const makeBackend = (): Backend => {
  const map = new Map<string, string>();
  const writes: string[] = [];
  const record = (key: string, value: string): void => {
    map.set(key, value);
    writes.push(value);
  };
  return {
    layer: Layer.succeed(
      KeyValueStore,
      KeyValueStore.of({
        managerPrivate: true,
        kind: "gm-sync",
        durable: true,
        watchable: false,
        get: (key) =>
          Effect.sync(() => Option.fromNullishOr(map.get(key) ?? null)),
        set: (key, value) => Effect.sync(() => record(key, value)),
        remove: (key) =>
          Effect.sync(() => {
            map.delete(key);
          }),
        setUnsafe: record,
        changes: () => Stream.empty,
      }),
    ),
    writesNow: () => [...writes],
    readNow: (key) => map.get(key),
  };
};

/** A `pagehide` event, with the one field that the code reads. */
const pageHide = (persisted: boolean): Event =>
  ({ type: "pagehide", persisted }) as unknown as Event;

/**
 * Give the turn away until a condition holds.
 *
 * The group fiber needs a turn to take a command. The loop has a limit, so a
 * condition that never holds fails the test and does not hang it.
 */
const yieldUntil = (ready: () => boolean, steps = 50): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (ready()) return Effect.void;
    if (steps <= 0) return Effect.die(new Error("the condition never held"));
    return Effect.andThen(Effect.yieldNow, yieldUntil(ready, steps - 1));
  });

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe("a value that changed just before the page went away", () => {
  it.effect("is at the backend when the pagehide listener returns", () =>
    Effect.gen(function*() {
      const attached = yield* Ref.make<ReadonlyArray<Attached>>([]);
      const backend = makeBackend();

      yield* Effect.provide(
        Effect.scoped(Effect.gen(function*() {
          const lifecycle = yield* Lifecycle;
          const storage = yield* Storage;

          // The hook that ships, with the parts that ship.
          yield* lifecycle.onExit(onPageExit({
            flushAllUnsafe: storage.flushAllUnsafe,
            forgetSuppressed: Effect.void,
            flushAll: storage.flushAll,
            release: Effect.void,
          }));

          // The user changes a setting. The settings group joins writes for
          // 250 ms, so the value is in memory and not at the backend.
          yield* Effect.forkChild(
            storage.settings.write({
              ...defaultSettings(),
              scrollStepSize: 120,
            }),
            { startImmediately: true },
          );
          yield* yieldUntil(() =>
            storage.settings.currentUnsafe().scrollStepSize === 120
          );
          assert.deepEqual(
            backend.writesNow(),
            [],
            "the debounce window must still hold the value",
          );

          // The page goes away. One synchronous run, and no other.
          const listener = (yield* Ref.get(attached))
            .find((entry) => entry.type === "pagehide");
          assert.isDefined(listener, "the layer must register `pagehide`");
          const outcome = yield* Effect.sync(() =>
            Effect.runSyncExit(listener.run(pageHide(false)))
          );

          const written = backend.writesNow();
          assert.lengthOf(
            written,
            1,
            "the backend call must start before the dispatch returns",
          );
          assert.include(written[0] ?? "", '"scrollStepSize":120');
          assert.isTrue(
            Exit.isSuccess(outcome),
            "the pagehide listener must not fail",
          );

          // And the same bytes are under the key of the group, ready for the
          // next page load.
          assert.include(
            backend.readNow(SETTINGS_KEY) ?? "",
            '"scrollStepSize":120',
          );
          const reread = yield* storage.settings.hydrate;
          assert.strictEqual(reread.scrollStepSize, 120);
        })),
        Layer.mergeAll(
          Lifecycle.layer.pipe(Layer.provide(recordingDom(attached))),
          Storage.layer.pipe(Layer.provide(backend.layer)),
        ),
      );
    }));
});
