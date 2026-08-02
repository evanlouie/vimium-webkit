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
 * ## Where the credential may live
 *
 * The credential goes into the value store of the userscript manager, and
 * nowhere else. A store that the page can read, or a store that one frame
 * cannot share with another, gives no admission at all. Every operation here
 * then fails with `unavailable`, and the frames of the page stay apart. That is
 * the safe result, because a page that can read the credential can join the
 * session and drive a click inside a document of another origin.
 *
 * `crypto.subtle` is absent in a context that is not secure, which means a
 * plain `http:` page. There is no route around that, and there is no
 * unauthenticated join. A page without HTTPS keeps its frames apart, which is
 * the safe result as well.
 */

import { Context, Effect, Layer, Option, Ref, Schema } from "effect";
import {
  ENVELOPE,
  joinProofPayload,
  linkKeyPayload,
  type SealDirection,
  sealedAad,
  type SealedMessage,
} from "~/domain/FrameMessage.ts";
import { KeyValueStore } from "~/platform/KeyValueStore.ts";
import { Realm } from "~/platform/Realm.ts";
import { Storage } from "~/platform/Storage.ts";

export const FrameAuthFailureReason = Schema.Literals([
  /** This realm has no Web Crypto, or storage is not reachable. */
  "unavailable",
  /** There is no credential in this frame, so it cannot join. */
  "unauthenticated",
  /** Web Crypto is present, and the call failed. */
  "failed",
]);

export type FrameAuthFailureReason = typeof FrameAuthFailureReason.Type;

export class FrameAuthError extends Schema.TaggedErrorClass<FrameAuthError>()(
  "FrameAuthError",
  {
    reason: FrameAuthFailureReason,
    detail: Schema.String,
  },
) {}

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

const describe = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
};

/** Base64, in the alphabet that a URL accepts, with no padding. */
const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
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
const readSubtle = (): Option.Option<SubtleCrypto> => {
  try {
    const api: SubtleCrypto | undefined = crypto.subtle;
    return api === undefined ? Option.none() : Option.some(api);
  } catch {
    return Option.none();
  }
};

/** A value that is not base64 is a rejection, and not a failure of ours. */
const decodeBase64Url = (
  value: string,
): Option.Option<Uint8Array<ArrayBuffer>> => {
  try {
    return Option.some(fromBase64Url(value));
  } catch {
    return Option.none();
  }
};

/**
 * The initialisation vector of one message.
 *
 * It is derived, and it does not travel. A link key belongs to one attempt, and
 * a counter rises by one for each message in one direction, so the pair of the
 * direction and the counter is used once. That is exactly what AES-GCM needs.
 */
const ivFor = (
  direction: SealDirection,
  seq: number,
): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(IV_BYTES);
  bytes[0] = direction === "up" ? 1 : 2;
  new DataView(bytes.buffer).setUint32(IV_BYTES - 4, seq, false);
  return bytes;
};

interface CachedKey {
  readonly secret: string;
  readonly key: CryptoKey;
}

export class FrameAuth extends Context.Service<FrameAuth, {
  /**
   * The shared credential.
   *
   * The top frame creates one when storage holds none. A child frame reads
   * storage again on each call, because the top frame may have written the
   * value after this frame started.
   */
  readonly secret: Effect.Effect<string, FrameAuthError>;

  /** The proof that a `JOIN` must carry. */
  readonly joinProof: (
    handshake: FrameHandshake,
  ) => Effect.Effect<string, FrameAuthError>;

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
  readonly cipher: (
    handshake: FrameHandshake,
  ) => Effect.Effect<FrameCipher, FrameAuthError>;
}>()("vimium/frames/FrameAuth") {
  static readonly layer: Layer.Layer<
    FrameAuth,
    never,
    Storage | Realm | KeyValueStore
  > = Layer
    .effect(
      FrameAuth,
      Effect.gen(function*() {
        const storage = yield* Storage;
        const realm = yield* Realm;
        const kv = yield* KeyValueStore;
        const cache = yield* Ref.make(Option.none<CachedKey>());

        /** Web Crypto, read again for each call, and never held. */
        const subtle: Effect.Effect<SubtleCrypto, FrameAuthError> = Effect
          .suspend(() => {
            const api = readSubtle();
            return Option.isSome(api) ? Effect.succeed(api.value) : Effect.fail(
              new FrameAuthError({
                reason: "unavailable",
                detail: "web crypto is not in this realm",
              }),
            );
          });

        /**
         * A store that the page can read is not a store for a credential.
         *
         * The frames of the page then stay apart. A same-origin child of a
         * hostile page could otherwise read the credential out of
         * `localStorage` and calculate a valid proof.
         */
        const privateStore: Effect.Effect<void, FrameAuthError> = kv
            .managerPrivate
          ? Effect.void
          : Effect.fail(
            new FrameAuthError({
              reason: "unavailable",
              detail:
                "the manager has no private value store, so a credential " +
                "would be readable by the page",
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

        const secret = Effect.fn("FrameAuth.secret")(function*() {
          yield* privateStore;

          // Read storage again, and do not trust the value in memory. The top
          // frame can write the credential after a child frame has started.
          const stored = yield* storage.session.hydrate;
          if (stored.frameSecret.length > 0) return stored.frameSecret;

          if (!realm.isTop) {
            return yield* new FrameAuthError({
              reason: "unauthenticated",
              detail: "this frame has no credential in manager storage",
            });
          }

          const created = yield* createSecret;
          yield* Effect.mapError(
            storage.session.update((current) => ({
              ...current,
              frameSecret: created,
            })),
            (cause) =>
              new FrameAuthError({
                reason: "unavailable",
                detail: `could not store the credential: ${cause.detail}`,
              }),
          );
          return created;
        });

        const keyFor = Effect.fn("FrameAuth.key")(function*(value: string) {
          const cached = yield* Ref.get(cache);
          if (Option.isSome(cached) && cached.value.secret === value) {
            return cached.value.key;
          }
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
          yield* Ref.set(cache, Option.some({ secret: value, key }));
          return key;
        });

        /**
         * The HMAC over one payload.
         *
         * It is private to this module. A service method that signed a text of
         * the caller's choice would be an oracle: a page that makes a child
         * answer a false challenge could ask for the key of a link.
         */
        const mac = Effect.fn("FrameAuth.mac")(function*(payload: string) {
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

        const joinProof = Effect.fn("FrameAuth.joinProof")(function*(
          handshake: FrameHandshake,
        ) {
          const signature = yield* mac(
            joinProofPayload(
              handshake.token,
              handshake.helloId,
              handshake.frameId,
            ),
          );
          return toBase64Url(new Uint8Array(signature));
        });

        const verifyJoin = Effect.fn("FrameAuth.verifyJoin")(function*(
          handshake: FrameHandshake,
          proof: string,
        ) {
          const value = yield* secret();
          const key = yield* keyFor(value);
          const api = yield* subtle;
          const bytes = decodeBase64Url(proof);
          if (Option.isNone(bytes)) return false;

          return yield* Effect.tryPromise({
            try: () =>
              api.verify(
                ALGORITHM,
                key,
                bytes.value,
                encoder.encode(
                  joinProofPayload(
                    handshake.token,
                    handshake.helloId,
                    handshake.frameId,
                  ),
                ),
              ),
            catch: (cause) =>
              new FrameAuthError({
                reason: "failed",
                detail: `could not verify: ${describe(cause)}`,
              }),
          });
        });

        const cipher = Effect.fn("FrameAuth.cipher")(function*(
          handshake: FrameHandshake,
        ) {
          const material = yield* mac(
            linkKeyPayload(
              handshake.token,
              handshake.helloId,
              handshake.frameId,
            ),
          );
          const api = yield* subtle;
          const key = yield* Effect.tryPromise({
            try: () =>
              api.importKey(
                "raw",
                material,
                { name: "AES-GCM" },
                false,
                ["encrypt", "decrypt"],
              ),
            catch: (cause) =>
              new FrameAuthError({
                reason: "failed",
                detail: `could not import the link key: ${describe(cause)}`,
              }),
          });

          const seal = Effect.fn("FrameCipher.seal")(function*(
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
                    additionalData: encoder.encode(
                      sealedAad(handshake.helloId, direction, seq),
                    ),
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
            return {
              ...ENVELOPE,
              kind: "SEALED",
              seq,
              data: toBase64Url(new Uint8Array(sealed)),
            } satisfies SealedMessage;
          });

          const open = Effect.fn("FrameCipher.open")(function*(
            direction: SealDirection,
            sealed: SealedMessage,
          ) {
            const bytes = decodeBase64Url(sealed.data);
            if (Option.isNone(bytes)) return Option.none<string>();

            // Every failure of `decrypt` is one answer: this message is not
            // ours. The API gives the same error for a changed byte, a wrong
            // key and a wrong counter, and it must, because a peer that could
            // tell them apart would learn about the key.
            const plain = yield* Effect.option(Effect.tryPromise({
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
                  bytes.value,
                ),
              catch: () =>
                new FrameAuthError({
                  reason: "unauthenticated",
                  detail: "the message did not open",
                }),
            }));
            return Option.map(
              plain,
              (buffer) => decoder.decode(new Uint8Array(buffer)),
            );
          });

          return { seal, open } satisfies FrameCipher;
        });

        // The credential must exist before the first child asks to join. Only
        // the top frame can create it, and a child cannot wait for a value that
        // nobody writes. A clean installation would otherwise keep every frame
        // outside the session for the life of the page.
        if (realm.isTop) {
          yield* Effect.catch(
            Effect.asVoid(secret()),
            (error) =>
              Effect.logDebug(
                `no frame credential in this realm: ${error.detail}`,
              ),
          );
        }

        return FrameAuth.of({
          secret: secret(),
          joinProof,
          verifyJoin,
          cipher,
        });
      }),
    );
}
