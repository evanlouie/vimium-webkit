/**
 * Vocabulary that every directory shares.
 *
 * The repeated pieces of Effect idiom, named once. Nothing here touches the
 * DOM or a global, so every directory may import it.
 */

import { Effect, Option, type Record, pipe } from "effect";

/**
 * The fields of a variant that carries no data of its own.
 *
 * The type `{}` would mean any value that is not nullish.
 */
export type NoFields = Record.ReadonlyRecord<never, never>;

/**
 * Run `f` on a value that is present. Absence does nothing.
 *
 * `Effect.transposeOption` runs an effect for a present value as well, but it
 * keeps the absence as its result. A caller that wants nothing back would
 * then need `Effect.asVoid` after it.
 */
export const whenSome =
  <A, E = never, R = never>(f: (value: A) => Effect.Effect<void, E, R>) =>
  (option: Option.Option<A>): Effect.Effect<void, E, R> =>
    pipe(option, Option.match({ onNone: () => Effect.void, onSome: f }));
