/**
 * Recovery from defects: one way, with two policies for interruption.
 *
 * A body with an empty error channel can still die. A handler on the key path,
 * an exit body of a mode, the body of a command and the fiber of a scroll
 * animation must not take the rest of the application with them when they do.
 * Each of those places recovers with one of the two combinators here, and the
 * name of the combinator says what happens when the work interrupts itself.
 * Interruption from outside the fiber never reaches either one.
 *
 * The recovery writes one fixed line to the log, annotated with the operation
 * and with the text of the failure. It never logs the `Cause` itself: a cause
 * can carry a value that the page or the manager made.
 */

import { Boolean, Cause, Effect, flow, pipe } from "effect";
import { describeCause } from "~/domain/Failure.ts";

/** The fixed line that a recovery logs. */
const recoveryLine: (cause: Cause.Cause<never>) => string = flow(
  Cause.hasDies,
  Boolean.match({
    onFalse: () => "recovered from an interruption",
    onTrue: () => "recovered from a defect",
  }),
);

/** Log the recovery, and then run what takes the place of the work. */
const logged =
  <B, E, R>(operation: string, completion: Effect.Effect<B, E, R>) =>
  (cause: Cause.Cause<never>): Effect.Effect<B, E, R> =>
    pipe(
      Effect.logError(recoveryLine(cause)),
      Effect.annotateLogs({ operation, failure: describeCause(cause) }),
      Effect.andThen(completion),
    );

/** A defect, and no interruption. */
const holdsNoInterruption = (cause: Cause.Cause<never>): boolean => !Cause.hasInterrupts(cause);

/**
 * Replace a defect of the work with `completion`.
 *
 * Work that interrupts itself stops, and the interruption goes on to the
 * caller.
 */
export const recoverUnlessInterrupted =
  <B, E, R2>(operation: string, completion: Effect.Effect<B, E, R2>) =>
  <A, R>(work: Effect.Effect<A, never, R>): Effect.Effect<A | B, E, R | R2> =>
    pipe(work, Effect.catchCauseIf(holdsNoInterruption, logged(operation, completion)));

/**
 * Replace a defect of the work with `completion`, and an interruption that the
 * work gave itself as well.
 *
 * For work whose caller must go on whatever happens: the next handler of the
 * stack, the next exit body of a mode, or the one reply that the caller of a
 * command waits for.
 */
export const recoverEvenIfInterrupted =
  <B, E, R2>(operation: string, completion: Effect.Effect<B, E, R2>) =>
  <A, R>(work: Effect.Effect<A, never, R>): Effect.Effect<A | B, E, R | R2> =>
    pipe(work, Effect.catchCause(logged(operation, completion)));
