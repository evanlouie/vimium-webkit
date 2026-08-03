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
 *    with another, gives no credential at all. The service also gives no way
 *    to read the credential, so no caller can carry it out of the module. The
 *    credential has a group of its own, so no feature can read it through
 *    `Storage` either.
 * 3. A message on a port is sealed. A holder of a copy of the port reads
 *    nothing, forges nothing, and cannot send a message again or send it back.
 * 4. A frame keeps the credential that storage holds. Two top frames of one
 *    site can create one at the same moment, and the frame that wrote last
 *    would otherwise break the links of the other.
 *
 * Every test builds its own store. Nothing here touches a global, and the two
 * frames of a test share one store, which is what the value store of a
 * userscript manager is.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Result, Stream } from "effect";
import { frameCredentialGroup, sessionGroup } from "~/domain/Persisted.ts";
import { FrameAuth, type FrameHandshake } from "~/frames/Auth.ts";
import { KeyValueStore, STORAGE_PREFIX } from "~/platform/KeyValueStore.ts";
import { type FrameId, Realm } from "~/platform/Realm.ts";
import { Storage } from "~/platform/Storage.ts";

/** The key of the group that only `frames/Auth.ts` builds. */
const CREDENTIAL_KEY = `${STORAGE_PREFIX}${frameCredentialGroup.name}`;

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
      setUnsafe: null,
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

/** One frame: its own credential store and its own realm, over one store. */
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
    Layer.provide(Layer.mergeAll(kv, realmLayer(isTop, frameId))),
  );
};

/**
 * The credential that the store holds, wherever it holds it.
 *
 * The scan covers every group and both field names, because the subject of
 * these tests is where the credential is not.
 */
const storedSecret = (store: Store): string => {
  for (const raw of store.map.values()) {
    const parsed = JSON.parse(raw) as { readonly data?: unknown };
    const data = parsed.data as Record<string, unknown> | undefined;
    if (data === undefined) continue;
    for (const name of ["secret", "frameSecret"]) {
      const value = data[name];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return "";
};

/** The raw value of the credential group, as the store holds it. */
const credentialValue = (secret: string): string =>
  JSON.stringify({
    schemaVersion: frameCredentialGroup.schemaVersion,
    data: { ...frameCredentialGroup.defaults(), secret },
  });

/**
 * A store in which another tab writes the credential first.
 *
 * The first read of the credential key gives nothing, and the value of the
 * other tab lands in the map at that moment. That is the race that two top
 * frames of one site run: both read an empty store, and both create a
 * credential. A frame must keep the credential that storage holds, because a
 * live link of the other tab already derived its key from it.
 */
const makeRacingStore = (rival: string): Store => {
  const map = new Map<string, string>();
  let firstRead = true;
  return {
    map,
    service: KeyValueStore.of({
      setUnsafe: null,
      kind: "gm-sync",
      durable: true,
      watchable: false,
      managerPrivate: true,
      get: (key) =>
        Effect.sync(() => {
          if (key === CREDENTIAL_KEY && firstRead) {
            firstRead = false;
            // The other tab writes here: after this read, and before our own
            // write.
            map.set(key, credentialValue(rival));
            return Option.none<string>();
          }
          return Option.fromNullishOr(map.get(key) ?? null);
        }),
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
        // Every route to the credential must fail. The service also gives no
        // way to read the credential itself: a caller can ask for a proof, for
        // a check of a proof and for a cipher, and for nothing else.
        assert.isFalse(
          Object.hasOwn(top, "secret"),
          "the service publishes the credential",
        );
        const outcome = yield* Effect.result(top.joinProof(HANDSHAKE));
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

  it.effect("keeps the credential that another frame wrote first", () =>
    Effect.gen(function*() {
      const rival = "cml2YWwtY3JlZGVudGlhbA";
      const store = makeRacingStore(rival);

      yield* Effect.gen(function*() {
        yield* FrameAuth;
      }).pipe(Effect.provide(frameLayer(store, true, TOP_FRAME)));

      // The credential of the other frame is still there. To replace it would
      // break every link that already derived a key from it.
      assert.strictEqual(storedSecret(store), rival);

      // The frames of this tab use the credential that storage holds.
      yield* Effect.gen(function*() {
        const top = yield* FrameAuth;

        yield* Effect.gen(function*() {
          const child = yield* FrameAuth;
          const proof = yield* child.joinProof(HANDSHAKE);
          assert.isTrue(yield* top.verifyJoin(HANDSHAKE, proof));
        }).pipe(Effect.provide(frameLayer(store, false, CHILD_FRAME)));
      }).pipe(Effect.provide(frameLayer(store, true, TOP_FRAME)));
    }));

  it.effect("keeps the credential out of every group that a feature reads", () =>
    Effect.gen(function*() {
      const store = makeStore(true);

      yield* Effect.gen(function*() {
        yield* FrameAuth;
      }).pipe(Effect.provide(frameLayer(store, true, TOP_FRAME)));

      const secret = storedSecret(store);
      assert.isAbove(secret.length, 0, "no credential was created");

      // A feature holds `Storage`, and nothing else. Every group that a
      // feature can name is read here, and none of them carries the
      // credential.
      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        const readable = [
          yield* storage.settings.hydrate,
          yield* storage.marks.hydrate,
          yield* storage.findHistory.hydrate,
          yield* storage.history.hydrate,
          yield* storage.session.hydrate,
        ];
        for (const group of readable) {
          assert.notInclude(
            JSON.stringify(group),
            secret,
            "a feature can read the frame credential",
          );
        }
      }).pipe(
        Effect.provide(
          Layer.fresh(Storage.layer).pipe(
            Layer.provide(Layer.succeed(KeyValueStore, store.service)),
          ),
        ),
      );

      // The type of the session group holds no field for a credential, so a
      // feature cannot even name one.
      assert.notProperty(sessionGroup.defaults(), "frameSecret");

      // The credential is in the store, under a key of its own. Only
      // `frames/Auth.ts` builds that group.
      assert.isTrue(
        store.map.has(CREDENTIAL_KEY),
        "the credential has no group of its own",
      );
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
          // A message whose ciphertext was changed. The first character of
          // base64 carries six bits of the first byte, so a change there is
          // always a change of the bytes. The last character can carry two
          // bits only, and a change there can decode to the same bytes.
          assert.isTrue(
            Option.isNone(
              yield* topCipher.open("up", {
                ...sealed,
                data: `${sealed.data.startsWith("A") ? "B" : "A"}${
                  sealed.data.slice(1)
                }`,
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
