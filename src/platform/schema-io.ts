/**
 * Decoding untrusted input without losing the reason it failed.
 *
 * Effect v4 offers `Schema.decodeUnknownOption`, which takes `unknown` but
 * answers `None` and throws the diagnosis away, and `Schema.decodeResult`,
 * which keeps the diagnosis but is typed to take the schema's `Encoded` type.
 * Everything this project decodes — the value store, the frame wire — is
 * `unknown` *and* needs the diagnosis, because that text is what a user sees
 * when their settings will not load.
 *
 * So the cast lives here, once, with the argument for why it is sound: the
 * decoder validates the value at run time regardless of what the type says. The
 * assertion buys nothing at run time and cannot make a bad value pass.
 *
 * Neither of these suspends, so both are safe on the key path.
 */

import { Result, Schema, type SchemaError } from "effect";

export type DecodeResult<T> = Result.Result<T, SchemaError.SchemaError>;

/** Decode `unknown`, keeping the failure detail. Never throws. */
export const decodeUnknownResult =
  <T, E>(schema: Schema.Codec<T, E>) => (input: unknown): DecodeResult<T> =>
    Schema.decodeResult(schema)(input as E);

/** The human-readable half of a decode failure, for a HUD line or a log. */
export const describeDecodeError = (error: SchemaError.SchemaError): string =>
  error.message;
