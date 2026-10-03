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
import {
  Array,
  Boolean,
  Effect,
  flow,
  Layer,
  Option,
  Predicate,
  Ref,
  Result,
  Schema,
  Stream,
  String as Str,
  pipe,
  Struct,
} from "effect";
import { FrameId } from "~/domain/FrameId.ts";
import { frameCredentialGroup, sessionGroup } from "~/domain/Persisted.ts";
import { FrameAuth, type FrameHandshake } from "~/frames/Auth.ts";
import { StoreKind } from "~/platform/Gm.ts";
import { KeyValueStore, STORAGE_PREFIX } from "~/platform/KeyValueStore.ts";
import { FrameRole, Realm } from "~/platform/Realm.ts";
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

/** The value store of the manager, which the page cannot read. */
const MANAGER_STORE = StoreKind.GmSync({ watchable: false });

/** A map of one realm, which another frame cannot read. */
const MEMORY_STORE = StoreKind.Memory();

/**
 * One store for every frame of the page.
 *
 * The kind of the store decides everything here: the value store of the
 * manager is private to the manager, and no other store is.
 */
const makeStore = (kind: StoreKind): Store => {
  const map = new Map<string, string>();
  return {
    map,
    service: KeyValueStore.of({
      setUnsafe: Option.none(),
      kind,
      get: (key) => Effect.sync(() => Option.fromNullishOr(map.get(key) ?? null)),
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
const realmLayer = (role: FrameRole, frameId: string): Layer.Layer<Realm> =>
  Layer.succeed(
    Realm,
    Realm.of({
      frameId: FrameId.make(frameId),
      role,
      isLive: Effect.succeed(true),
      wakeDescendants: Effect.void,
      askDescendantsToAnnounce: Effect.void,
      isAncestor: () => Effect.succeed(false),
    }),
  );

/** One frame: its own credential store and its own realm, over one store. */
const frameLayer = (store: Store, role: FrameRole, frameId: string): Layer.Layer<FrameAuth> => {
  const kv = Layer.succeed(KeyValueStore, store.service);
  // `Layer.fresh`, because a test builds two frames in one fiber and the layer
  // of a service is otherwise built once and shared. Two frames of a page each
  // hold their own instance.
  return pipe(
    FrameAuth.layer,
    Layer.fresh,
    Layer.provide(Layer.mergeAll(kv, realmLayer(role, frameId))),
  );
};

/** The two fields of a stored group that could hold a credential. */
const decodeStoredGroup = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        secret: Schema.optionalKey(Schema.Unknown),
        frameSecret: Schema.optionalKey(Schema.Unknown),
      }),
    }),
  ),
);

/** The values of one stored group that could be the credential, in the order of the scan. */
const candidateSecrets: (raw: string) => ReadonlyArray<unknown> = flow(
  decodeStoredGroup,
  Option.match({
    onNone: () => Array.empty<unknown>(),
    onSome: ({ data }) => [data.secret, data.frameSecret],
  }),
);

/**
 * The credential that the store holds, wherever it holds it.
 *
 * The scan covers every group and both field names, because the subject of
 * these tests is where the credential is not.
 */
const storedSecret = (store: Store): string =>
  pipe(
    store.map.values(),
    Array.fromIterable,
    Array.flatMap(candidateSecrets),
    Array.filter(Predicate.isString),
    Array.findFirst(Str.isNonEmpty),
    Option.getOrElse(() => ""),
  );

/** The reason of a failed outcome. */
const reasonOf: (
  outcome: Result.Result<unknown, { readonly reason: string }>,
) => Option.Option<string> = flow(
  Result.getFailure,
  Option.map(({ reason }) => reason),
);

/** The raw value of the credential group, as the store holds it. */
const credentialValue = (secret: string): string =>
  JSON.stringify({
    schemaVersion: frameCredentialGroup.schemaVersion,
    data: pipe(frameCredentialGroup.defaults(), Struct.assign({ secret })),
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
  const firstRead = Ref.makeUnsafe(true);
  const read = (key: string): Effect.Effect<Option.Option<string>> =>
    Effect.sync(() => Option.fromNullishOr(map.get(key)));
  // The other tab writes here: after this read, and before our own write.
  const rivalWrites = Effect.sync(() => {
    map.set(CREDENTIAL_KEY, credentialValue(rival));
    return Option.none<string>();
  });
  const readCredential = pipe(
    firstRead,
    Ref.getAndSet(false),
    Effect.flatMap(
      Boolean.match({
        onTrue: () => rivalWrites,
        onFalse: () => read(CREDENTIAL_KEY),
      }),
    ),
  );
  return {
    map,
    service: KeyValueStore.of({
      setUnsafe: Option.none(),
      kind: MANAGER_STORE,
      get: (key) =>
        pipe(
          key === CREDENTIAL_KEY,
          Boolean.match({
            onTrue: () => readCredential,
            onFalse: () => read(key),
          }),
        ),
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
    Effect.gen(function* () {
      const store = makeStore(MANAGER_STORE);

      yield* pipe(
        Effect.gen(function* () {
          // Nothing is asked of the service. The layer alone must be enough,
          // because a child needs the credential before the first handshake and
          // only the top frame may write it.
          yield* FrameAuth;
        }),
        Effect.provide(frameLayer(store, FrameRole.Top(), TOP_FRAME)),
      );

      assert.isAbove(storedSecret(store).length, 0);
    }),
  );

  it.effect("admits a child that starts with an empty store", () =>
    Effect.gen(function* () {
      const store = makeStore(MANAGER_STORE);

      yield* pipe(
        Effect.gen(function* () {
          const top = yield* FrameAuth;

          yield* pipe(
            Effect.gen(function* () {
              const child = yield* FrameAuth;
              const proof = yield* child.joinProof(HANDSHAKE);
              assert.isTrue(yield* top.verifyJoin(HANDSHAKE, proof));

              // The proof names one attempt and one identity, and nothing else.
              const otherFrame = pipe(HANDSHAKE, Struct.assign({ frameId: TOP_FRAME }));
              const otherToken = pipe(HANDSHAKE, Struct.assign({ token: "abcdefabcdefabcd" }));
              assert.isFalse(yield* top.verifyJoin(otherFrame, proof));
              assert.isFalse(yield* top.verifyJoin(otherToken, proof));
              assert.isFalse(yield* top.verifyJoin(HANDSHAKE, "bm90LWEtcHJvb2Y"));
            }),
            Effect.provide(frameLayer(store, FrameRole.Child(), CHILD_FRAME)),
          );
        }),
        Effect.provide(frameLayer(store, FrameRole.Top(), TOP_FRAME)),
      );
    }),
  );

  it.effect("refuses a child that has no credential", () =>
    Effect.gen(function* () {
      const store = makeStore(MANAGER_STORE);

      yield* pipe(
        Effect.gen(function* () {
          const child = yield* FrameAuth;
          const outcome = yield* Effect.result(child.joinProof(HANDSHAKE));
          assert.isTrue(Result.isFailure(outcome));
          assert.deepEqual(reasonOf(outcome), Option.some("unauthenticated"));
        }),
        Effect.provide(frameLayer(store, FrameRole.Child(), CHILD_FRAME)),
      );

      assert.strictEqual(storedSecret(store), "");
    }),
  );

  it.effect("keeps no credential in a store that the page can read", () =>
    Effect.gen(function* () {
      const store = makeStore(MEMORY_STORE);

      yield* pipe(
        Effect.gen(function* () {
          const top = yield* FrameAuth;
          // Every route to the credential must fail. The service also gives no
          // way to read the credential itself: a caller can ask for a proof, for
          // a check of a proof and for a cipher, and for nothing else.
          const published = pipe(top, Predicate.hasProperty("secret"));
          assert.isFalse(published, "the service publishes the credential");
          const outcome = yield* Effect.result(top.joinProof(HANDSHAKE));
          assert.isTrue(Result.isFailure(outcome));
          assert.deepEqual(reasonOf(outcome), Option.some("unavailable"));
        }),
        Effect.provide(frameLayer(store, FrameRole.Top(), TOP_FRAME)),
      );

      // Nothing was written, so a same-origin child of a hostile page has
      // nothing to read and cannot calculate a proof.
      assert.strictEqual(storedSecret(store), "");

      yield* pipe(
        Effect.gen(function* () {
          const child = yield* FrameAuth;
          const outcome = yield* Effect.result(child.joinProof(HANDSHAKE));
          assert.isTrue(Result.isFailure(outcome));
        }),
        Effect.provide(frameLayer(store, FrameRole.Child(), CHILD_FRAME)),
      );
    }),
  );

  it.effect("keeps the credential that another frame wrote first", () =>
    Effect.gen(function* () {
      const rival = "cml2YWwtY3JlZGVudGlhbA";
      const store = makeRacingStore(rival);

      yield* pipe(
        Effect.gen(function* () {
          yield* FrameAuth;
        }),
        Effect.provide(frameLayer(store, FrameRole.Top(), TOP_FRAME)),
      );

      // The credential of the other frame is still there. To replace it would
      // break every link that already derived a key from it.
      assert.strictEqual(storedSecret(store), rival);

      // The frames of this tab use the credential that storage holds.
      yield* pipe(
        Effect.gen(function* () {
          const top = yield* FrameAuth;

          yield* pipe(
            Effect.gen(function* () {
              const child = yield* FrameAuth;
              const proof = yield* child.joinProof(HANDSHAKE);
              assert.isTrue(yield* top.verifyJoin(HANDSHAKE, proof));
            }),
            Effect.provide(frameLayer(store, FrameRole.Child(), CHILD_FRAME)),
          );
        }),
        Effect.provide(frameLayer(store, FrameRole.Top(), TOP_FRAME)),
      );
    }),
  );

  it.effect("keeps the credential out of every group that a feature reads", () =>
    Effect.gen(function* () {
      const store = makeStore(MANAGER_STORE);

      yield* pipe(
        Effect.gen(function* () {
          yield* FrameAuth;
        }),
        Effect.provide(frameLayer(store, FrameRole.Top(), TOP_FRAME)),
      );

      const secret = storedSecret(store);
      assert.isAbove(secret.length, 0, "no credential was created");

      const storageLayer = pipe(
        Storage.layer,
        Layer.fresh,
        Layer.provide(Layer.succeed(KeyValueStore, store.service)),
      );

      // A feature holds `Storage`, and nothing else. Every group that a
      // feature can name is read here, and none of them carries the
      // credential.
      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          const readable = [
            yield* storage.settings.hydrate,
            yield* storage.marks.hydrate,
            yield* storage.findHistory.hydrate,
            yield* storage.history.hydrate,
            yield* storage.session.hydrate,
          ];
          yield* pipe(
            readable,
            Effect.forEach((group) =>
              Effect.sync(() => {
                assert.notInclude(
                  JSON.stringify(group),
                  secret,
                  "a feature can read the frame credential",
                );
              }),
            ),
          );
        }),
        Effect.provide(storageLayer),
      );

      // The type of the session group holds no field for a credential, so a
      // feature cannot even name one.
      assert.notProperty(sessionGroup.defaults(), "frameSecret");

      // The credential is in the store, under a key of its own. Only
      // `frames/Auth.ts` builds that group.
      assert.isTrue(store.map.has(CREDENTIAL_KEY), "the credential has no group of its own");
    }),
  );

  it.effect("seals a message that only the other end of the link opens", () =>
    Effect.gen(function* () {
      const store = makeStore(MANAGER_STORE);

      yield* pipe(
        Effect.gen(function* () {
          const top = yield* FrameAuth;
          const topCipher = yield* top.cipher(HANDSHAKE);

          yield* pipe(
            Effect.gen(function* () {
              const child = yield* FrameAuth;
              const childCipher = yield* child.cipher(HANDSHAKE);

              const text = JSON.stringify({ kind: "HINTS", linkText: "Buy now" });
              const sealed = yield* childCipher.seal("up", 0, text);

              // The page reads the port. It must read nothing.
              assert.notInclude(sealed.data, "HINTS");
              assert.notInclude(sealed.data, "Buy now");

              assert.deepEqual(yield* topCipher.open("up", sealed), Option.some(text));

              // A message that is sent back to its sender.
              assert.isTrue(Option.isNone(yield* topCipher.open("down", sealed)));
              // A message that is played again with another counter.
              const replayed = pipe(sealed, Struct.assign({ seq: 1 }));
              assert.isTrue(Option.isNone(yield* topCipher.open("up", replayed)));
              // A message whose ciphertext was changed. The first character of
              // base64 carries six bits of the first byte, so a change there is
              // always a change of the bytes. The last character can carry two
              // bits only, and a change there can decode to the same bytes.
              const firstCharacter = pipe(
                sealed.data.startsWith("A"),
                Boolean.match({
                  onTrue: () => "B",
                  onFalse: () => "A",
                }),
              );
              const changed = pipe(
                sealed,
                Struct.assign({ data: `${firstCharacter}${sealed.data.slice(1)}` }),
              );
              assert.isTrue(Option.isNone(yield* topCipher.open("up", changed)));

              // The key belongs to one attempt, so a message of one link never
              // opens on another.
              const otherAttempt = pipe(HANDSHAKE, Struct.assign({ helloId: "abcdefabcdefabcd" }));
              const other = yield* top.cipher(otherAttempt);
              assert.isTrue(Option.isNone(yield* other.open("up", sealed)));
            }),
            Effect.provide(frameLayer(store, FrameRole.Child(), CHILD_FRAME)),
          );
        }),
        Effect.provide(frameLayer(store, FrameRole.Top(), TOP_FRAME)),
      );
    }),
  );

  it.effect("gives a page with the handshake values no way in", () =>
    Effect.gen(function* () {
      // The page reads the token, the hello id and the frame id out of the
      // `JOIN` that it sees. It does not hold the credential, so it derives
      // another key and it can neither read a message nor forge one.
      const ours = makeStore(MANAGER_STORE);
      const theirs = makeStore(MANAGER_STORE);

      yield* pipe(
        Effect.gen(function* () {
          const frame = yield* FrameAuth;
          const cipher = yield* frame.cipher(HANDSHAKE);
          const sealed = yield* cipher.seal("down", 0, "a true welcome");

          yield* pipe(
            Effect.gen(function* () {
              const page = yield* FrameAuth;
              const forger = yield* page.cipher(HANDSHAKE);
              assert.isTrue(Option.isNone(yield* forger.open("down", sealed)));

              const forged = yield* forger.seal("down", 0, "a false welcome");
              assert.isTrue(Option.isNone(yield* cipher.open("down", forged)));
            }),
            Effect.provide(frameLayer(theirs, FrameRole.Top(), TOP_FRAME)),
          );
        }),
        Effect.provide(frameLayer(ours, FrameRole.Top(), TOP_FRAME)),
      );
    }),
  );
});
