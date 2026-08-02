/**
 * Decode untrusted input without losing the reason that it failed.
 *
 * Effect gives `Schema.decodeUnknownOption`, which takes `unknown` and answers
 * `None`, and so throws the diagnosis away. It also gives `Schema.decodeResult`,
 * which keeps the diagnosis but is typed to take the schema's `Encoded` type.
 * Everything that this application decodes — the value store and the frame wire
 * — is `unknown` *and* needs the diagnosis, because that text is what the user
 * reads when the settings will not load.
 *
 * The cast therefore lives here, once, with its argument: the decoder checks
 * the value at run time whatever the type says. The cast buys nothing at run
 * time, and it cannot make a bad value pass.
 *
 * Neither function suspends, so both are safe on the key path.
 */

import { type Result, Schema, type SchemaError } from "effect";

export type DecodeResult<A> = Result.Result<A, SchemaError.SchemaError>;

/** Decode `unknown`, and keep the detail of a failure. It never throws. */
export const decodeUnknown =
  <A, E>(schema: Schema.Codec<A, E>) => (input: unknown): DecodeResult<A> =>
    Schema.decodeResult(schema)(input as E);

/** The readable half of a decode failure, for a HUD line or a log. */
export const describeSchemaError = (error: SchemaError.SchemaError): string =>
  error.message;
