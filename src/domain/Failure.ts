/**
 * What a failure says, as text for a `detail` field.
 *
 * A caught value can be anything: an `Error` of the browser, a string, an
 * error of this application, or a value that the page or the manager made.
 * The text is the field that says what went wrong, and not the whole value, so
 * a stack and a nested cause stay out of it.
 *
 * This module is pure, so every directory may use it.
 */

import { Cause, flow, Option, pipe, Predicate } from "effect";

/** The `detail` of an error of this application, when it says something. */
const detailOf: (thrown: unknown) => Option.Option<string> = flow(
  Option.liftPredicate(Predicate.isObjectOrArray),
  Option.map((object): unknown => Reflect.get(object, "detail")),
  Option.filter(Predicate.isString),
  Option.filter((detail) => detail.length > 0),
);

/** The message of an `Error`, when it says something. */
const messageOf: (thrown: unknown) => Option.Option<string> = flow(
  Option.liftPredicate(Predicate.isError),
  Option.map((error) => error.message),
  Option.filter((message) => message.length > 0),
);

/**
 * What a thrown value says.
 *
 * An error of this application says it in `detail`, because its `message` is
 * empty. Any other `Error` says it in `message`. An empty field is skipped,
 * and then the value gives its own text, as it does when it has neither field.
 */
export const describeThrown = (thrown: unknown): string =>
  pipe(
    detailOf(thrown),
    Option.orElse(() => messageOf(thrown)),
    Option.getOrElse(() => String(thrown)),
  );

/**
 * What a failed effect says: the text of its first failure, or else of its
 * first defect.
 *
 * The text of a whole `Cause` names every nested cause, and this text does
 * not.
 */
export const describeCause: (cause: Cause.Cause<unknown>) => string = flow(
  Cause.squash,
  describeThrown,
);
