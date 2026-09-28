/**
 * Decode untrusted input without losing the reason that it failed.
 *
 * Effect gives `Schema.decodeUnknownOption`, which takes `unknown` and answers
 * `None`, and so throws the diagnosis away. Everything that this application
 * decodes here — the value store — is `unknown` *and* needs the diagnosis,
 * because that text is what the user reads when the settings will not load.
 * `Schema.decodeUnknownResult` takes `unknown` and keeps the diagnosis.
 *
 * Neither function suspends, so both are safe on the key path.
 */

import { type Result, Schema } from "effect";

export type DecodeResult<A> = Result.Result<A, Schema.SchemaError>;

/** Decode `unknown`, and keep the detail of a failure. It never throws. */
export const decodeUnknown =
  <A, E>(schema: Schema.Codec<A, E>) =>
  (input: unknown): DecodeResult<A> =>
    Schema.decodeUnknownResult(schema)(input);

/** The readable half of a decode failure, for a HUD line or a log. */
export const describeSchemaError = (error: Schema.SchemaError): string => error.message;
