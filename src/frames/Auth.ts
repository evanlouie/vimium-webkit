/**
 * The manager-private credential that admits a frame to the session, and the
 * cipher that protects one port.
 *
 * A frame proves that it can read the private storage of the userscript
 * manager. Page code cannot read that storage, so the proof separates our own
 * frames from the frames that the page controls. Window identity cannot do
 * that: a `srcdoc` frame of the page is in the frames tree by right.
 *
 * The top frame creates the secret, and a child frame reads it. Only the top
 * frame creates it, because two frames that create one at the same time would
 * write two different values, and the frame that wrote last would lock the
 * other frames out. The top frame creates it when this layer is built, which is
 * before any handshake listener exists. A child that starts on a clean
 * installation therefore finds a credential when it needs one.
 *
 * The secret never travels. What travels is an HMAC over a one-shot token, the
 * id of the handshake attempt and the id of the frame. A page can read those
 * three values, and it still cannot produce the HMAC.
 *
 * The service holds the credential in a closure, and it gives no method that
 * returns it. A caller can ask for a proof, for a check of a proof and for the
 * cipher of one link, and each of those builds its own payload.
 *
 * The credential also has a group of its own in the value store, and this
 * module is the only one that builds that group. `Storage` does not expose it,
 * and the type of every group that `Storage` does expose holds no field for
 * it. A feature therefore has no name for the credential. Read issue #3.
 *
 * ## The cipher of one link
 *
 * A page reads every `message` event that a window of the page receives, so it
 * takes a copy of the `MessagePort` that a `JOIN` transfers. The port alone is
 * therefore not a capability. Both ends derive one AES-GCM key from the secret
 * and from the three values of the handshake, and every message on the port is
 * sealed with it. The direction and the counter of a message go into the
 * associated data and into the initialisation vector, so a message cannot be
 * sent back, moved to another link or played again.
 *
 * The key is derived with `linkKeyPayload`, and the join proof is made with
 * `joinProofPayload`. The two texts can never be the same, and the service
 * gives no way to sign a text of the caller's choice. A page that makes a child
 * answer a false challenge therefore learns one proof, and never a key.
 *
 * One HMAC-SHA256 over a labelled text is the whole key schedule. That is
 * HKDF-Expand with one block, and the extract step is not necessary here: the
 * credential is 256 uniform bits from `crypto.getRandomValues`. Read it as a
 * pseudo-random function with domain separation, and not as an ad-hoc hash.
 *
 * ## Where the credential may live
 *
 * The credential goes into the value store of the userscript manager, and
 * nowhere else. A store that the page can read, or a store that one frame
 * cannot share with another, gives no admission at all. Every operation here
 * then fails with `unavailable`, and the frames of the page stay apart. That is
 * the safe result, because a page that can read the credential can join the
 * session and drive a click inside a document of another origin.
 *
 * A manager with no value store therefore has no cross-frame session, and the
 * top frame does not give a credential of its own to a child. There is no safe
 * route for that gift. A userscript shares its realm with the page, so the page
 * reads every `message` event of a window and it holds a copy of every port
 * that a `JOIN` transfers. A credential that travelled on either one would be
 * public. A key agreement over the port does not help either: the page is not a
 * silent listener. It runs in the realm of the top frame, it can answer as the
 * other end, and it can put a frame of its own in the tree. Admission needs one
 * value that the page cannot read, and only the manager has such a store.
 * `ARCHITECTURE.md` section 5.1 gives the same reason at more length.
 *
 * `crypto.subtle` is absent in a context that is not secure, which means a
 * plain `http:` page. There is no route around that, and there is no
 * unauthenticated join. A page without HTTPS keeps its frames apart, which is
 * the safe result as well.
 */

import {
  Boolean,
  Context,
  Effect,
  flow,
  Iterable,
  Layer,
  Match,
  Option,
  Predicate,
  Queue,
  Ref,
  Result,
  Schema,
  String as Str,
  Struct,
  pipe,
} from "effect";
import {
  joinProofPayload,
  linkKeyPayload,
  type SealDirection,
  sealedAad,
  sealedMessage,
  type SealedMessage,
} from "~/domain/FrameMessage.ts";
import { type FrameCredential, frameCredentialGroup } from "~/domain/Persisted.ts";
import { KeyValueStore } from "~/platform/KeyValueStore.ts";
import { Realm } from "~/platform/Realm.ts";
import { makeGroup, type StorageError } from "~/platform/Storage.ts";

export const FrameAuthFailureReason = Schema.Literals([
  /** This realm has no Web Crypto, or storage is not reachable. */
  "unavailable",
  /** There is no credential in this frame, so it cannot join. */
  "unauthenticated",
  /** Web Crypto is present, and the call failed. */
  "failed",
]);

export type FrameAuthFailureReason = typeof FrameAuthFailureReason.Type;

export class FrameAuthError extends Schema.TaggedError<FrameAuthError>()("FrameAuthError", {
  reason: FrameAuthFailureReason,
  detail: Schema.String,
}) {}

const ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;

/** 256 bits from the random source of the platform. */
const SECRET_BYTES = 32;

/** AES-GCM takes 96 bits, which is the size that every engine accelerates. */
const IV_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The three values that name one handshake attempt, and one link. */
export interface FrameHandshake {
  readonly token: string;
  readonly helloId: string;
  readonly frameId: string;
}

/** The two ends of one port. Each one seals and opens with the same key. */
export interface FrameCipher {
  /** Seal one message. The counter must rise by one for each message. */
  readonly seal: (
    direction: SealDirection,
    seq: number,
    plaintext: string,
  ) => Effect.Effect<SealedMessage, FrameAuthError>;

  /**
   * Open one message that arrived in the given direction.
   *
   * `None` means that the message is not ours: a wrong key, a wrong direction,
   * a wrong counter or a changed byte all give the same answer. The error
   * channel reports the failures of this frame only.
   */
  readonly open: (
    direction: SealDirection,
    sealed: SealedMessage,
  ) => Effect.Effect<Option.Option<string>, FrameAuthError>;
}

const describe = (cause: unknown): string =>
  pipe(
    Match.value(cause),
    Match.when(Predicate.isError, (error) => error.message),
    Match.when(Predicate.isString, (text) => text),
    Match.orElse((other) => String(other)),
  );

/** One character for each byte, which is the text that `btoa` takes. */
const binaryText: (bytes: Uint8Array) => string = Iterable.reduce(
  "",
  (binary: string, byte: number) => binary + String.fromCharCode(byte),
);

/** Base64, in the alphabet that a URL accepts, with no padding. */
const toBase64Url: (bytes: Uint8Array) => string = flow(binaryText, btoa, (base64) =>
  base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
);

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const base64 =
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

/**
 * Read `crypto.subtle`, which a hostile realm can replace with an accessor.
 *
 * A userscript shares its realm with the page, so a read of a global can
 * throw. Only a `try` survives that. The result is `None` in a context that is
 * not secure, where the API is absent.
 */
const readSubtle = (): Option.Option<SubtleCrypto> =>
  pipe(
    Result.try((): SubtleCrypto | undefined => crypto.subtle),
    Result.getSuccess,
    Option.flatMap(Option.fromNullishOr),
  );

/** A value that is not base64 is a rejection, and not a failure of ours. */
const decodeBase64Url = (value: string): Option.Option<Uint8Array<ArrayBuffer>> =>
  pipe(
    Result.try(() => fromBase64Url(value)),
    Result.getSuccess,
  );

/** The first byte of an initialisation vector names the direction. */
const directionByte = (direction: SealDirection): number =>
  pipe(
    Match.value(direction),
    Match.when("up", () => 1),
    Match.when("down", () => 2),
    Match.exhaustive,
  );

/**
 * The initialisation vector of one message.
 *
 * It is derived, and it does not travel. A link key belongs to one attempt, and
 * a counter rises by one for each message in one direction, so the pair of the
 * direction and the counter is used once. That is exactly what AES-GCM needs.
 */
const ivFor = (direction: SealDirection, seq: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(IV_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, directionByte(direction));
  view.setUint32(IV_BYTES - 4, seq, false);
  return bytes;
};

/** The credential that the group holds. An empty text is no credential. */
const presentSecret: (secret: string) => Option.Option<string> = Option.liftPredicate(
  Str.isNonEmpty,
);

/**
 * Put a credential into a group that holds none.
 *
 * The caller has already looked, and this is the same test again, against the
 * value that the group holds. Another tab can reach the group through the
 * change stream of the manager between the read and the write.
 */
const withSecret =
  (created: string) =>
  (current: FrameCredential): FrameCredential =>
    pipe(
      current.secret,
      presentSecret,
      Option.match({
        onSome: () => current,
        onNone: () => pipe(current, Struct.assign({ secret: created })),
      }),
    );

interface CachedKey {
  readonly secret: string;
  readonly key: CryptoKey;
}

export class FrameAuth extends Context.Service<
  FrameAuth,
  {
    /** The proof that a `JOIN` must carry. */
    readonly joinProof: (handshake: FrameHandshake) => Effect.Effect<string, FrameAuthError>;

    /**
     * Check the proof of a `JOIN`.
     *
     * A proof that is not readable gives `false`, because a bad proof is the
     * fault of the peer and not of this frame. The error channel reports the
     * failures of this frame only.
     */
    readonly verifyJoin: (
      handshake: FrameHandshake,
      proof: string,
    ) => Effect.Effect<boolean, FrameAuthError>;

    /** The cipher of one port. Both ends derive the same one. */
    readonly cipher: (handshake: FrameHandshake) => Effect.Effect<FrameCipher, FrameAuthError>;
  }
>()("vimium/frames/FrameAuth") {
  static readonly layer: Layer.Layer<FrameAuth, never, Realm | KeyValueStore> = Layer.effect(
    FrameAuth,
    Effect.gen(function* () {
      const realm = yield* Realm;
      const kv = yield* KeyValueStore;
      const cache = yield* Ref.make(Option.none<CachedKey>());

      /**
       * The store of the credential, and of nothing else.
       *
       * This module builds the group, and it keeps it in this closure. No
       * service publishes it, so a feature cannot read the credential. The
       * group gives the same serial mailbox that every other group has, so a
       * read and a write of the credential cannot interleave.
       */
      const issues = yield* Queue.unbounded<StorageError>();
      const store = yield* makeGroup(frameCredentialGroup, kv, issues);

      // A failure of the store also reaches the caller as a
      // `FrameAuthError`, so this line is a record and not the only signal.
      yield* pipe(
        Queue.take(issues),
        Effect.flatMap((issue) => Effect.logDebug(`the credential store failed: ${issue.detail}`)),
        Effect.forever,
        Effect.forkScoped,
      );

      /** Web Crypto, read again for each call, and never held. */
      const subtle: Effect.Effect<SubtleCrypto, FrameAuthError> = pipe(
        Effect.sync(readSubtle),
        Effect.flatMap(
          Effect.fromOption(
            () =>
              new FrameAuthError({
                reason: "unavailable",
                detail: "web crypto is not in this realm",
              }),
          ),
        ),
      );

      /**
       * A store that the page can read is not a store for a credential.
       *
       * The frames of the page then stay apart. A same-origin child of a
       * hostile page could otherwise read the credential out of
       * `localStorage` and calculate a valid proof.
       */
      const privateStore: Effect.Effect<void, FrameAuthError> = pipe(
        kv.managerPrivate,
        Boolean.match({
          onTrue: () => Effect.void,
          onFalse: () =>
            Effect.fail(
              new FrameAuthError({
                reason: "unavailable",
                detail:
                  "the manager has no private value store, so a credential " +
                  "would be readable by the page",
              }),
            ),
        }),
      );

      /**
       * Only the top frame creates the credential.
       *
       * Two frames that created one at the same time would write two values,
       * and the frame that wrote last would lock the other frames out.
       */
      const creator: Effect.Effect<void, FrameAuthError> = pipe(
        realm.isTop,
        Boolean.match({
          onTrue: () => Effect.void,
          onFalse: () =>
            Effect.fail(
              new FrameAuthError({
                reason: "unauthenticated",
                detail: "this frame has no credential in manager storage",
              }),
            ),
        }),
      );

      const createSecret = Effect.try({
        try: (): string => {
          const bytes = new Uint8Array(SECRET_BYTES);
          crypto.getRandomValues(bytes);
          return toBase64Url(bytes);
        },
        catch: (cause) =>
          new FrameAuthError({
            reason: "unavailable",
            detail: `no random source: ${describe(cause)}`,
          }),
      });

      /**
       * The credential that storage holds now.
       *
       * Every read goes to storage again, and does not trust the value in
       * memory: the top frame can write the credential after a child frame has
       * started.
       */
      const stored: Effect.Effect<Option.Option<string>> = pipe(
        store.hydrate,
        Effect.map(({ secret }) => presentSecret(secret)),
      );

      /**
       * Write a credential that this frame made, and give back the one that
       * storage then holds.
       */
      const storeSecret = Effect.fnUntraced(function* (created: string) {
        yield* pipe(
          store.update(withSecret(created)),
          Effect.mapError(
            (cause) =>
              new FrameAuthError({
                reason: "unavailable",
                detail: `could not store the credential: ${cause.detail}`,
              }),
          ),
        );

        // Keep the value that storage holds, and not the value that this
        // frame made. The two differ when another tab wrote last.
        const settled = yield* stored;
        return pipe(
          settled,
          Option.getOrElse(() => created),
        );
      });

      /** Create the credential, unless another frame stores one first. */
      const createShared = Effect.fnUntraced(function* () {
        yield* creator;
        const created = yield* createSecret;

        // Read storage once more, immediately before the write. The top frame
        // of another tab shares this store, and it can create the credential
        // while this frame collects its random bytes. A credential that is
        // already in use must not be replaced: the two ends of a live link
        // derived their key from it, and a new value would break them.
        //
        // The value store gives no compare-and-set, so this makes the window
        // small and does not close it. A frame that loses converges on the
        // next read, and a join inside the window fails and is repeated.
        const again = yield* stored;
        return yield* pipe(
          again,
          Option.match({
            onSome: Effect.succeed,
            onNone: () => storeSecret(created),
          }),
        );
      });

      /**
       * The shared credential, as storage holds it.
       *
       * It is private to this module. The top frame creates one when storage
       * holds none.
       */
      const secret = Effect.fn("FrameAuth.secret")(function* () {
        yield* privateStore;
        const current = yield* stored;
        return yield* pipe(
          current,
          Option.match({
            onSome: Effect.succeed,
            onNone: createShared,
          }),
        );
      });

      const importCredential = Effect.fnUntraced(function* (value: string) {
        const api = yield* subtle;
        const key = yield* Effect.tryPromise({
          try: () =>
            api.importKey(
              "raw",
              encoder.encode(value),
              ALGORITHM,
              // Not extractable. Nothing in this application reads the key
              // back, and the flag removes one route out of the realm.
              false,
              ["sign", "verify"],
            ),
          catch: (cause) =>
            new FrameAuthError({
              reason: "failed",
              detail: `could not import the credential: ${describe(cause)}`,
            }),
        });
        yield* pipe(cache, Ref.set(Option.some({ secret: value, key })));
        return key;
      });

      const keyFor = Effect.fn("FrameAuth.key")(function* (value: string) {
        const cached = yield* Ref.get(cache);
        return yield* pipe(
          cached,
          Option.filter((entry) => entry.secret === value),
          Option.match({
            onSome: ({ key }) => Effect.succeed(key),
            onNone: () => importCredential(value),
          }),
        );
      });

      /**
       * The HMAC over one payload.
       *
       * It is private to this module. A service method that signed a text of
       * the caller's choice would be an oracle: a page that makes a child
       * answer a false challenge could ask for the key of a link.
       */
      const mac = Effect.fn("FrameAuth.mac")(function* (payload: string) {
        const value = yield* secret();
        const key = yield* keyFor(value);
        const api = yield* subtle;
        return yield* Effect.tryPromise({
          try: () => api.sign(ALGORITHM, key, encoder.encode(payload)),
          catch: (cause) =>
            new FrameAuthError({
              reason: "failed",
              detail: `could not sign: ${describe(cause)}`,
            }),
        });
      });

      const joinProof = Effect.fn("FrameAuth.joinProof")(function* (handshake: FrameHandshake) {
        const signature = yield* mac(
          joinProofPayload(handshake.token, handshake.helloId, handshake.frameId),
        );
        return toBase64Url(new Uint8Array(signature));
      });

      const verifyJoin = Effect.fn("FrameAuth.verifyJoin")(function* (
        handshake: FrameHandshake,
        proof: string,
      ) {
        const value = yield* secret();
        const key = yield* keyFor(value);
        const api = yield* subtle;
        return yield* pipe(
          decodeBase64Url(proof),
          Option.match({
            onNone: () => Effect.succeed(false),
            onSome: (bytes) =>
              Effect.tryPromise({
                try: () =>
                  api.verify(
                    ALGORITHM,
                    key,
                    bytes,
                    encoder.encode(
                      joinProofPayload(handshake.token, handshake.helloId, handshake.frameId),
                    ),
                  ),
                catch: (cause) =>
                  new FrameAuthError({
                    reason: "failed",
                    detail: `could not verify: ${describe(cause)}`,
                  }),
              }),
          }),
        );
      });

      const cipher = Effect.fn("FrameAuth.cipher")(function* (handshake: FrameHandshake) {
        const material = yield* mac(
          linkKeyPayload(handshake.token, handshake.helloId, handshake.frameId),
        );
        const api = yield* subtle;
        const key = yield* Effect.tryPromise({
          try: () =>
            api.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
          catch: (cause) =>
            new FrameAuthError({
              reason: "failed",
              detail: `could not import the link key: ${describe(cause)}`,
            }),
        });

        const seal = Effect.fn("FrameCipher.seal")(function* (
          direction: SealDirection,
          seq: number,
          plaintext: string,
        ) {
          const sealed = yield* Effect.tryPromise({
            try: () =>
              api.encrypt(
                {
                  name: "AES-GCM",
                  iv: ivFor(direction, seq),
                  additionalData: encoder.encode(sealedAad(handshake.helloId, direction, seq)),
                },
                key,
                encoder.encode(plaintext),
              ),
            catch: (cause) =>
              new FrameAuthError({
                reason: "failed",
                detail: `could not seal the message: ${describe(cause)}`,
              }),
          });
          return sealedMessage(seq, toBase64Url(new Uint8Array(sealed)));
        });

        // Every failure of `decrypt` is one answer: this message is not ours.
        // The API gives the same error for a changed byte, a wrong key and a
        // wrong counter, and it must, because a peer that could tell them
        // apart would learn about the key.
        const decrypt = (
          direction: SealDirection,
          sealed: SealedMessage,
          bytes: Uint8Array<ArrayBuffer>,
        ): Effect.Effect<Option.Option<string>> =>
          pipe(
            Effect.tryPromise({
              try: () =>
                api.decrypt(
                  {
                    name: "AES-GCM",
                    iv: ivFor(direction, sealed.seq),
                    additionalData: encoder.encode(
                      sealedAad(handshake.helloId, direction, sealed.seq),
                    ),
                  },
                  key,
                  bytes,
                ),
              catch: () =>
                new FrameAuthError({
                  reason: "unauthenticated",
                  detail: "the message did not open",
                }),
            }),
            Effect.option,
            Effect.map(Option.map((buffer) => decoder.decode(new Uint8Array(buffer)))),
          );

        const open = Effect.fn("FrameCipher.open")(function* (
          direction: SealDirection,
          sealed: SealedMessage,
        ) {
          return yield* pipe(
            decodeBase64Url(sealed.data),
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (bytes) => decrypt(direction, sealed, bytes),
            }),
          );
        });

        return { seal, open } satisfies FrameCipher;
      });

      // The credential must exist before the first child asks to join. Only
      // the top frame can create it, and a child cannot wait for a value that
      // nobody writes. A clean installation would otherwise keep every frame
      // outside the session for the life of the page.
      yield* pipe(
        realm.isTop,
        Boolean.match({
          onFalse: () => Effect.void,
          onTrue: () =>
            pipe(
              secret(),
              Effect.asVoid,
              Effect.catch((error) =>
                Effect.logDebug(`no frame credential in this realm: ${error.detail}`),
              ),
            ),
        }),
      );

      return FrameAuth.of({
        joinProof,
        verifyJoin,
        cipher,
      });
    }),
  );
}
