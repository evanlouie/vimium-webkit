/**
 * The `@std/assert` surface this suite uses, on Node's assertion library.
 *
 * The suite moved from `deno test` to Vitest during the Effect migration. The
 * tests here are the safety net for that migration, so rewriting 736
 * assertions into `expect(...)` form was the one change most likely to weaken
 * the net while appearing to be a tidy-up. Six functions is a smaller surface
 * to get right, and it leaves every call site — and therefore every reviewed
 * assertion — byte-for-byte as it was.
 *
 * The semantics follow `@std/assert`: `assertEquals` is structural, and
 * compares prototypes, which is what `deepStrictEqual` does.
 */

import {
  deepStrictEqual,
  notDeepStrictEqual,
  throws as nodeThrows,
} from "node:assert/strict";

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

export function assert(expression: unknown, message = ""): asserts expression {
  if (!expression) {
    throw new AssertionError(
      message === "" ? "expected a truthy value" : message,
    );
  }
}

export const assertFalse = (expression: unknown, message = ""): void => {
  if (expression) {
    throw new AssertionError(
      message === "" ? "expected a falsy value" : message,
    );
  }
};

export const assertEquals = <T>(
  actual: T,
  expected: T,
  message?: string,
): void => {
  // Not `deepStrictEqual(actual, expected, message)`. Passing an explicit
  // `undefined` message is rejected outright by Node 26 with "The "message"
  // argument must be one of type string or function" — which replaces the
  // actual/expected diff, the entire reason to use this assertion, with a
  // phantom complaint about the assertion itself.
  if (message === undefined) deepStrictEqual(actual, expected);
  else deepStrictEqual(actual, expected, message);
};

export const assertNotEquals = <T>(
  actual: T,
  expected: T,
  message?: string,
): void => {
  if (message === undefined) notDeepStrictEqual(actual, expected);
  else notDeepStrictEqual(actual, expected, message);
};

/**
 * Tolerance follows `@std/assert`, which is *relative* to `expected`.
 *
 * An absolute `1e-7` looks equivalent and is not: against `expected = 1000` it
 * is a thousand times stricter, and against `expected = 0.001` a hundred times
 * looser. Every current call site compares against a small integer, where the
 * two agree — which is exactly how a wrong default survives unnoticed until
 * somebody asserts on a small number.
 */
export const assertAlmostEquals = (
  actual: number,
  expected: number,
  tolerance?: number,
  message?: string,
): void => {
  if (Object.is(actual, expected)) return;
  const limit = tolerance ??
    (Number.isFinite(expected) ? Math.abs(expected * 1e-7) : 1e-7);
  const delta = Math.abs(actual - expected);
  if (delta <= limit) return;
  throw new AssertionError(
    message ??
      `expected ${actual} to be within ${limit} of ${expected} (delta ${delta})`,
  );
};

export const assertThrows = (
  fn: () => unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ErrorClass?: new(...args: any[]) => Error,
  messageIncludes?: string,
  message?: string,
): void => {
  if (ErrorClass === undefined) {
    // Same care as `assertEquals`: never hand Node an explicit `undefined`.
    if (message === undefined) nodeThrows(fn);
    else nodeThrows(fn, message);
    return;
  }
  nodeThrows(
    fn,
    (thrown: unknown) => {
      if (!(thrown instanceof ErrorClass)) {
        throw new AssertionError(
          message ??
            `expected ${ErrorClass.name}, got ${
              thrown instanceof Error ? thrown.name : typeof thrown
            }`,
        );
      }
      if (
        messageIncludes !== undefined &&
        !thrown.message.includes(messageIncludes)
      ) {
        throw new AssertionError(
          message ??
            `expected message to include ${messageIncludes}, got ${thrown.message}`,
        );
      }
      return true;
    },
  );
};
