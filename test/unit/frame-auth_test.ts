/**
 * The credential of a frame, and the cipher of one port.
 *
 * Three properties are checked here, and each one is a defect that a review
 * found:
 *
 * 1. The top frame creates the credential when its layer is built, and not
 *    when it verifies the first join. A child that starts on a clean
 *    installation would otherwise find nothing to sign with.
 * 2. A store that the page can read, or a store that one frame cannot share
 *    with another, gives no credential at all.
 * 3. A message on a port is sealed. A holder of a copy of the port reads
 *    nothing, forges nothing, and cannot send a message again or send it back.
 *
 * Every test builds its own store. Nothing here touches a global, and the two
 * frames of a test share one store, which is what the value store of a
 * userscript manager is.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Result, Stream } from "effect";
import { FrameAuth, type FrameHandshake } from "~/frames/Auth.ts";
import { KeyValueStore, STORAGE_PREFIX } from "~/platform/KeyValueStore.ts";
import { type FrameId, Realm } from "~/platform/Realm.ts";
import { Storage } from "~/platform/Storage.ts";

const SESSION_KEY = `${STORAGE_PREFIX}session`;

const TOP_FRAME = "1111111111111111";
const CHILD_FRAME = "2222222222222222";

/** The three values of one handshake attempt, as a `JOIN` carries them. */
const HANDSHAKE: FrameHandshake = {
  token: "0123456789abcdef",
  helloId: "fedcba9876543210",
  frameId: CHILD_FRAME,
};

interface Store {
  readonly service: KeyValueStore["Service"];
  readonly map: Map<string, string>;
}

/**
 * One store for every frame of the page.
 *
 * `managerPrivate` is the property that decides everything here: the value
 * store of the manager has it, and no other store does.
 */
const makeStore = (managerPrivate: boolean): Store => {
  const map = new Map<string, string>();
  return {
    map,
    service: KeyValueStore.of({
      kind: managerPrivate ? "gm-sync" : "memory",
      durable: managerPrivate,
      watchable: false,
      managerPrivate,
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
      const store = makeStore(true);

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
      const store = makeStore(true);

      yield* Effect.gen(function*() {
        const top = yield* FrameAuth;

        yield* Effect.gen(function*() {
          const child = yield* FrameAuth;
          const proof = yield* child.joinProof(HANDSHAKE);
          assert.isTrue(yield* top.verifyJoin(HANDSHAKE, proof));

          // The proof names one attempt and one identity, and nothing else.
          assert.isFalse(
            yield* top.verifyJoin(
              { ...HANDSHAKE, frameId: TOP_FRAME },
              proof,
            ),
          );
          assert.isFalse(
            yield* top.verifyJoin(
              { ...HANDSHAKE, token: "abcdefabcdefabcd" },
              proof,
            ),
          );
          assert.isFalse(yield* top.verifyJoin(HANDSHAKE, "bm90LWEtcHJvb2Y"));
        }).pipe(Effect.provide(frameLayer(store, false, CHILD_FRAME)));
      }).pipe(Effect.provide(frameLayer(store, true, TOP_FRAME)));
    }));

  it.effect("refuses a child that has no credential", () =>
    Effect.gen(function*() {
      const store = makeStore(true);

      yield* Effect.gen(function*() {
        const child = yield* FrameAuth;
        const outcome = yield* Effect.result(child.joinProof(HANDSHAKE));
        assert.isTrue(Result.isFailure(outcome));
        if (Result.isSuccess(outcome)) return;
        assert.strictEqual(outcome.failure.reason, "unauthenticated");
      }).pipe(Effect.provide(frameLayer(store, false, CHILD_FRAME)));

      assert.strictEqual(storedSecret(store), "");
    }));

  it.effect("keeps no credential in a store that the page can read", () =>
    Effect.gen(function*() {
      const store = makeStore(false);

      yield* Effect.gen(function*() {
        const top = yield* FrameAuth;
        const outcome = yield* Effect.result(top.secret);
        assert.isTrue(Result.isFailure(outcome));
        if (Result.isSuccess(outcome)) return;
        assert.strictEqual(outcome.failure.reason, "unavailable");
      }).pipe(Effect.provide(frameLayer(store, true, TOP_FRAME)));

      // Nothing was written, so a same-origin child of a hostile page has
      // nothing to read and cannot calculate a proof.
      assert.strictEqual(storedSecret(store), "");

      yield* Effect.gen(function*() {
        const child = yield* FrameAuth;
        const outcome = yield* Effect.result(child.joinProof(HANDSHAKE));
        assert.isTrue(Result.isFailure(outcome));
      }).pipe(Effect.provide(frameLayer(store, false, CHILD_FRAME)));
    }));

  it.effect("seals a message that only the other end of the link opens", () =>
    Effect.gen(function*() {
      const store = makeStore(true);

      yield* Effect.gen(function*() {
        const top = yield* FrameAuth;
        const topCipher = yield* top.cipher(HANDSHAKE);

        yield* Effect.gen(function*() {
          const child = yield* FrameAuth;
          const childCipher = yield* child.cipher(HANDSHAKE);

          const text = JSON.stringify({ kind: "HINTS", linkText: "Buy now" });
          const sealed = yield* childCipher.seal("up", 0, text);

          // The page reads the port. It must read nothing.
          assert.notInclude(sealed.data, "HINTS");
          assert.notInclude(sealed.data, "Buy now");

          assert.deepEqual(
            yield* topCipher.open("up", sealed),
            Option.some(text),
          );

          // A message that is sent back to its sender.
          assert.isTrue(Option.isNone(yield* topCipher.open("down", sealed)));
          // A message that is played again with another counter.
          assert.isTrue(
            Option.isNone(yield* topCipher.open("up", { ...sealed, seq: 1 })),
          );
          // A message whose ciphertext was changed.
          assert.isTrue(
            Option.isNone(
              yield* topCipher.open("up", {
                ...sealed,
                data: `${sealed.data.slice(0, -1)}A`,
              }),
            ),
          );

          // The key belongs to one attempt, so a message of one link never
          // opens on another.
          const other = yield* top.cipher({
            ...HANDSHAKE,
            helloId: "abcdefabcdefabcd",
          });
          assert.isTrue(Option.isNone(yield* other.open("up", sealed)));
        }).pipe(Effect.provide(frameLayer(store, false, CHILD_FRAME)));
      }).pipe(Effect.provide(frameLayer(store, true, TOP_FRAME)));
    }));

  it.effect("gives a page with the handshake values no way in", () =>
    Effect.gen(function*() {
      // The page reads the token, the hello id and the frame id out of the
      // `JOIN` that it sees. It does not hold the credential, so it derives
      // another key and it can neither read a message nor forge one.
      const ours = makeStore(true);
      const theirs = makeStore(true);

      yield* Effect.gen(function*() {
        const frame = yield* FrameAuth;
        const cipher = yield* frame.cipher(HANDSHAKE);
        const sealed = yield* cipher.seal("down", 0, "the session nonce");

        yield* Effect.gen(function*() {
          const page = yield* FrameAuth;
          const forger = yield* page.cipher(HANDSHAKE);
          assert.isTrue(Option.isNone(yield* forger.open("down", sealed)));

          const forged = yield* forger.seal("down", 0, "a false welcome");
          assert.isTrue(Option.isNone(yield* cipher.open("down", forged)));
        }).pipe(Effect.provide(frameLayer(theirs, true, TOP_FRAME)));
      }).pipe(Effect.provide(frameLayer(ours, true, TOP_FRAME)));
    }));
});
