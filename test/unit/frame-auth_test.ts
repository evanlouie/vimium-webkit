/**
 * The credential of a frame.
 *
 * The top frame creates the credential when its layer is built, and not when it
 * verifies the first join. A child that starts on a clean installation would
 * otherwise find nothing to sign with, and it would never join.
 *
 * Every test builds its own store. Nothing here touches a global, and the two
 * frames of a test share one store, which is what the value store of a
 * userscript manager is.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Result, Stream } from "effect";
import { joinProofPayload } from "~/domain/FrameMessage.ts";
import { FrameAuth } from "~/frames/Auth.ts";
import { KeyValueStore, STORAGE_PREFIX } from "~/platform/KeyValueStore.ts";
import { type FrameId, Realm } from "~/platform/Realm.ts";
import { Storage } from "~/platform/Storage.ts";

const SESSION_KEY = `${STORAGE_PREFIX}session`;

const TOP_FRAME = "1111111111111111";
const CHILD_FRAME = "2222222222222222";

/** The three values of one handshake attempt, as a `JOIN` carries them. */
const HANDSHAKE = {
  token: "0123456789abcdef",
  helloId: "fedcba9876543210",
  frameId: CHILD_FRAME,
};

interface Store {
  readonly service: KeyValueStore["Service"];
  readonly map: Map<string, string>;
}

/** One store for every frame of the page, as a manager gives it. */
const makeStore = (): Store => {
  const map = new Map<string, string>();
  return {
    map,
    service: KeyValueStore.of({
      kind: "gm-sync",
      durable: true,
      watchable: false,
      get: (key) =>
        Effect.sync(() => Option.fromNullishOr(map.get(key) ?? null)),
      set: (key, value) =>
        Effect.sync(() => {
          map.set(key, value);
        }),
      remove: (key) =>
        Effect.sync(() => {
          map.delete(key);
        }),
      changes: () => Stream.empty,
    }),
  };
};

/** A realm, without a DOM. A unit test provides a layer instead of a global. */
const realmLayer = (isTop: boolean, frameId: string): Layer.Layer<Realm> =>
  Layer.succeed(
    Realm,
    Realm.of({
      frameId: frameId as FrameId,
      isTop,
      isLive: true,
      wakeDescendants: Effect.void,
      askDescendantsToAnnounce: Effect.void,
      isAncestor: () => Effect.succeed(false),
    }),
  );

/** One frame: its own storage and its own realm, over the shared store. */
const frameLayer = (
  store: Store,
  isTop: boolean,
  frameId: string,
): Layer.Layer<FrameAuth> => {
  const kv = Layer.succeed(KeyValueStore, store.service);
  // `Layer.fresh`, because a test builds two frames in one fiber and the layer
  // of a service is otherwise built once and shared. Two frames of a page each
  // hold their own instance.
  return Layer.fresh(FrameAuth.layer).pipe(
    Layer.provide(Layer.mergeAll(
      Layer.fresh(Storage.layer).pipe(Layer.provide(kv)),
      kv,
      realmLayer(isTop, frameId),
    )),
  );
};

/** The credential that the store holds, if it holds one. */
const storedSecret = (store: Store): string => {
  const raw = store.map.get(SESSION_KEY);
  if (raw === undefined) return "";
  const parsed = JSON.parse(raw) as { readonly data?: unknown };
  const data = parsed.data as { readonly frameSecret?: unknown } | undefined;
  return typeof data?.frameSecret === "string" ? data.frameSecret : "";
};

describe("FrameAuth", () => {
  it.effect("creates the credential when the top layer is built", () =>
    Effect.gen(function*() {
      const store = makeStore();

      yield* Effect.gen(function*() {
        // Nothing is asked of the service. The layer alone must be enough,
        // because a child needs the credential before the first handshake and
        // only the top frame may write it.
        yield* FrameAuth;
      }).pipe(Effect.provide(frameLayer(store, true, TOP_FRAME)));

      assert.isAbove(storedSecret(store).length, 0);
    }));

  it.effect("admits a child that starts with an empty store", () =>
    Effect.gen(function*() {
      const store = makeStore();

      yield* Effect.gen(function*() {
        const top = yield* FrameAuth;

        yield* Effect.gen(function*() {
          const child = yield* FrameAuth;
          const payload = joinProofPayload(
            HANDSHAKE.token,
            HANDSHAKE.helloId,
            HANDSHAKE.frameId,
          );
          const proof = yield* child.sign(payload);
          assert.isTrue(yield* top.verify(payload, proof));

          // The proof names one attempt and one identity, and nothing else.
          assert.isFalse(
            yield* top.verify(
              joinProofPayload(HANDSHAKE.token, HANDSHAKE.helloId, TOP_FRAME),
              proof,
            ),
          );
          assert.isFalse(yield* top.verify(payload, "bm90LWEtcHJvb2Y"));
        }).pipe(Effect.provide(frameLayer(store, false, CHILD_FRAME)));
      }).pipe(Effect.provide(frameLayer(store, true, TOP_FRAME)));
    }));

  it.effect("refuses a child that has no credential", () =>
    Effect.gen(function*() {
      const store = makeStore();

      yield* Effect.gen(function*() {
        const child = yield* FrameAuth;
        const outcome = yield* Effect.result(
          child.sign(
            joinProofPayload(
              HANDSHAKE.token,
              HANDSHAKE.helloId,
              HANDSHAKE.frameId,
            ),
          ),
        );
        assert.isTrue(Result.isFailure(outcome));
        if (Result.isSuccess(outcome)) return;
        assert.strictEqual(outcome.failure.reason, "unauthenticated");
      }).pipe(Effect.provide(frameLayer(store, false, CHILD_FRAME)));

      assert.strictEqual(storedSecret(store), "");
    }));
});
