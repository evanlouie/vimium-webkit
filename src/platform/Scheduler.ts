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

import { Array, Boolean, Effect, Option, Predicate, Ref, flow, pipe } from "effect";
import { Dom } from "~/platform/Dom.ts";

/** The length of one slice. Chosen to stay inside one 60 Hz frame. */
export const CHUNK_BUDGET_MS = 8;

/** How many items are mapped before the clock is read again. */
const DEFAULT_CHECK_EVERY = 32;

/**
 * True when this realm has a native `requestIdleCallback`.
 *
 * `Capabilities` reports it. Nothing else may use it, because the answer is
 * `false` on the browser that this application targets first.
 *
 * The read can throw, because a userscript does not own its globals. Call this
 * inside `Dom.probeOr`.
 */
export const hasNativeIdleCallback = (window: Window & typeof globalThis): boolean =>
  Predicate.isFunction(window.requestIdleCallback);

export interface ChunkedOptions {
  /** The time budget for one slice, in milliseconds. */
  readonly budgetMs?: number;
  /** How many items to map before the clock is read again. */
  readonly checkEvery?: number;
}

/** The slices of one piece of work, from the moment that the first one started. */
interface Slices {
  /**
   * Read the clock, and end the slice when it has spent its budget.
   *
   * The end of a slice gives control back to the browser, and the next slice
   * starts when control comes back. That turn is also where interruption takes
   * effect. Run the check only between two batches, so that the last batch
   * never gives a turn that nothing uses.
   */
  readonly check: Effect.Effect<void>;
}

/** Start the first slice of work that may spend `budgetMs` in each slice. */
const startSlices = Effect.fnUntraced(function* (budgetMs: number) {
  const dom = yield* Dom;
  const sliceStart = yield* pipe(dom.now, Effect.flatMap(Ref.make));
  // Sequential by design. The browser gets a turn between two slices.
  const nextSlice = pipe(
    dom.yieldToBrowser,
    Effect.andThen(dom.now),
    Effect.flatMap((now) => pipe(sliceStart, Ref.set(now))),
  );
  const slices: Slices = {
    check: pipe(
      dom.now,
      Effect.zipWith(Ref.get(sliceStart), (now, start) => now - start >= budgetMs),
      Effect.flatMap(Boolean.match({ onFalse: () => Effect.void, onTrue: () => nextSlice })),
    ),
  };
  return slices;
});

/**
 * Run `batch` again and again in time-boxed slices, until it gives `false`.
 *
 * `batch` does a bounded amount of synchronous work, and it gives `true` while
 * work is left. The clock is read after each batch that leaves work, so a
 * batch must be small enough that its cost stays well under the budget.
 */
export const repeatInSlices = Effect.fnUntraced(function* (
  batch: Effect.Effect<boolean>,
  budgetMs: number,
) {
  const slices = yield* startSlices(budgetMs);
  const run: Effect.Effect<void> = pipe(
    batch,
    Effect.flatMap(
      Boolean.match({
        onFalse: () => Effect.void,
        onTrue: () => pipe(slices.check, Effect.andThen(run)),
      }),
    ),
  );
  yield* run;
});

/** `items` cut into consecutive batches of `size`, without a copy of the rest at each cut. */
const batchesOf = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> =>
  Array.unfold(
    0,
    flow(
      Option.liftPredicate((offset: number) => offset < items.length),
      Option.map((offset) => [items.slice(offset, offset + size), offset + size] as const),
    ),
  );

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
export const mapChunked = <A, B>(
  transform: (item: A) => Option.Option<B>,
  options: ChunkedOptions = {},
): ((items: ReadonlyArray<A>) => Effect.Effect<ReadonlyArray<B>, never, Dom>) =>
  Effect.fnUntraced(function* (items: ReadonlyArray<A>) {
    const slices = yield* startSlices(options.budgetMs ?? CHUNK_BUDGET_MS);
    const mapBatch = (batch: ReadonlyArray<A>, index: number): Effect.Effect<ReadonlyArray<B>> =>
      pipe(
        // The slice check runs between two batches, and never after the last.
        index > 0,
        Boolean.match({ onFalse: () => Effect.void, onTrue: () => slices.check }),
        Effect.andThen(Effect.sync(() => pipe(batch, Array.map(transform), Array.getSomes))),
      );
    const mapped = yield* pipe(
      batchesOf(items, options.checkEvery ?? DEFAULT_CHECK_EVERY),
      Effect.forEach(mapBatch),
    );
    return Array.flatten(mapped);
  });
