/**
 * Cooperative scheduling, for work that is too large for one frame.
 *
 * Safari still does not have `requestIdleCallback` (true at 26.5), so idle
 * work — hint detection above all — is cut into slices by hand against a time
 * budget. Do not call `requestIdleCallback` in any other file.
 *
 * Most of the old module is gone, because Effect already has it:
 *
 * - `yieldToEventLoop` is `Dom.yieldToBrowser`.
 * - `nextFrame` is `Dom.nextFrame`.
 * - `timeout` and `withDeadline` are `Effect.timeout` and `Effect.timeoutTo`,
 *   at the call site. A deadline belongs to the caller, not to a helper.
 * - `AbortedError` and the `signal` option are fiber interruption. The caller
 *   interrupts the fiber, and the slice loop stops at its next yield.
 * - `rafCoalesce` is a stream. Read the events with `Dom.events`, keep one
 *   value per window with `Stream.throttle`, and run the stream in a fiber
 *   that `Effect.forkScoped` owns. The scope removes the listener and stops
 *   the fiber, so there is no `cancel` method for a caller to remember.
 */

import { Effect, Option, Predicate } from "effect";
import { Dom } from "~/platform/Dom.ts";

/** The length of one slice. Chosen to stay inside one 60 Hz frame. */
export const CHUNK_BUDGET_MS = 8;

/** How many items are mapped before the clock is read again. */
const DEFAULT_CHECK_EVERY = 32;

interface IdleWindow {
  readonly requestIdleCallback?: unknown;
}

/**
 * True when this realm has a native `requestIdleCallback`.
 *
 * `Capabilities` reports it. Nothing else may use it, because the answer is
 * `false` on the browser that this application targets first.
 *
 * The read can throw, because a userscript does not own its globals. Call this
 * inside `Dom.probeOr`.
 */
export const hasNativeIdleCallback = (
  window: Window & typeof globalThis,
): boolean => Predicate.isFunction((window as IdleWindow).requestIdleCallback);

export interface ChunkedOptions {
  /** The time budget for one slice, in milliseconds. */
  readonly budgetMs?: number;
  /** How many items to map before the clock is read again. */
  readonly checkEvery?: number;
}

/**
 * Map over `items` in time-boxed slices.
 *
 * The result holds one value for every `Option.some` that `transform` gave, in
 * the order of `items`. A `None` drops the item.
 *
 * Control goes back to the browser between two slices, and that point is also
 * where interruption takes effect. Interrupt the fiber to stop the work; the
 * old `AbortSignal` is gone.
 *
 * `checkEvery` exists because `performance.now()` is itself measurable when it
 * is read once for each of many thousands of elements.
 */
export const mapChunked = <A, B, R = never>(
  items: readonly A[],
  transform: (item: A, index: number) => Option.Option<B>,
  options?: ChunkedOptions,
): Effect.Effect<ReadonlyArray<B>, never, R | Dom> =>
  Effect.gen(function*() {
    const dom = yield* Dom;
    const budget = options?.budgetMs ?? CHUNK_BUDGET_MS;
    const checkEvery = options?.checkEvery ?? DEFAULT_CHECK_EVERY;

    const out: Array<B> = [];
    let index = 0;

    while (index < items.length) {
      const sliceStart = yield* dom.now;
      let sinceCheck = 0;

      while (index < items.length) {
        // `noUncheckedIndexedAccess` makes this read optional. A hole in the
        // array is skipped, exactly as the old loop skipped it.
        const item = items[index];
        if (item !== undefined) {
          const mapped = transform(item, index);
          if (Option.isSome(mapped)) out.push(mapped.value);
        }
        index += 1;
        sinceCheck += 1;
        if (sinceCheck >= checkEvery) {
          sinceCheck = 0;
          const elapsed = (yield* dom.now) - sliceStart;
          if (elapsed >= budget) break;
        }
      }

      // Sequential by design. The purpose of the loop is to give the browser a
      // turn between two slices.
      if (index < items.length) yield* dom.yieldToBrowser;
    }

    return out;
  });
