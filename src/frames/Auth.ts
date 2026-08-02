/**
 * The manager-private credential that admits a frame to the session.
 *
 * A frame proves that it can read the private storage of the userscript
 * manager. Page code cannot read that storage, so the proof separates our own
 * frames from the frames that the page controls. Window identity cannot do
 * that: a `srcdoc` frame of the page is in the frames tree by right.
 *
 * The top frame creates the secret, and a child frame reads it. Only the top
 * frame creates it, because two frames that create one at the same time would
 * write two different values, and the frame that wrote last would lock the
 * other frames out.
 *
 * The secret never travels. What travels is an HMAC over a one-shot token, the
 * id of the handshake attempt and the id of the frame. A page can read those
 * three values, and it still cannot produce the HMAC.
 *
 * `crypto.subtle` is absent in a context that is not secure, which means a
 * plain `http:` page. There is no route around that, and there is no
 * unauthenticated join. A page without HTTPS keeps its frames apart, which is
 * the safe result.
 */

import { Context, Effect, Layer, Option, Ref, Schema } from "effect";
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

const encoder = new TextEncoder();

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

/** A signature that is not base64 is a rejection, and not a failure of ours. */
const decodeSignature = (
  value: string,
): Option.Option<Uint8Array<ArrayBuffer>> => {
  try {
    return Option.some(fromBase64Url(value));
  } catch {
    return Option.none();
  }
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

  /** Sign the payload of a handshake. */
  readonly sign: (payload: string) => Effect.Effect<string, FrameAuthError>;

  /**
   * Check a signature.
   *
   * A signature that is not readable gives `false`, because a bad signature is
   * the fault of the peer and not of this frame. The error channel reports the
   * failures of this frame only.
   */
  readonly verify: (
    payload: string,
    signature: string,
  ) => Effect.Effect<boolean, FrameAuthError>;
}>()("vimium/frames/FrameAuth") {
  static readonly layer: Layer.Layer<FrameAuth, never, Storage | Realm> = Layer
    .effect(
      FrameAuth,
      Effect.gen(function*() {
        const storage = yield* Storage;
        const realm = yield* Realm;
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

        const sign = Effect.fn("FrameAuth.sign")(function*(payload: string) {
          const value = yield* secret();
          const key = yield* keyFor(value);
          const api = yield* subtle;
          const signature = yield* Effect.tryPromise({
            try: () => api.sign(ALGORITHM, key, encoder.encode(payload)),
            catch: (cause) =>
              new FrameAuthError({
                reason: "failed",
                detail: `could not sign: ${describe(cause)}`,
              }),
          });
          return toBase64Url(new Uint8Array(signature));
        });

        const verify = Effect.fn("FrameAuth.verify")(function*(
          payload: string,
          signature: string,
        ) {
          const value = yield* secret();
          const key = yield* keyFor(value);
          const api = yield* subtle;
          const bytes = decodeSignature(signature);
          if (Option.isNone(bytes)) return false;

          return yield* Effect.tryPromise({
            try: () =>
              api.verify(
                ALGORITHM,
                key,
                bytes.value,
                encoder.encode(payload),
              ),
            catch: (cause) =>
              new FrameAuthError({
                reason: "failed",
                detail: `could not verify: ${describe(cause)}`,
              }),
          });
        });

        return FrameAuth.of({ secret: secret(), sign, verify });
      }),
    );
}
