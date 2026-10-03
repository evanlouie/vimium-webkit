/**
 * Cooperative scheduling, for work that is too large for one frame.
 *
 * Safari still does not have `requestIdleCallback` (true at 26.5), so idle
 * work — hint detection above all — is cut into slices by hand against a time
 * budget. Do not call `requestIdleCallback`.
 */

import { Array, Boolean, Effect, Iterable, type Option, Ref, pipe } from "effect";
import { Dom } from "~/platform/Dom.ts";

/** The length of one slice. Chosen to stay inside one 60 Hz frame. */
export const CHUNK_BUDGET_MS = 8;

/** How many items `mapChunked` maps before it reads the clock again. */
const CHECK_EVERY = 32;

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

/**
 * Map over `items` in time-boxed slices.
 *
 * The result holds one value for every `Option.some` that `transform` gave, in
 * the order of `items`. A `None` drops the item.
 *
 * Control goes back to the browser between two slices, and that point is also
 * where interruption takes effect. Interrupt the fiber to stop the work.
 *
 * The items are mapped in batches, because `performance.now()` is itself
 * measurable when it is read once for each of many thousands of elements. The
 * batches are cut lazily, as the work reaches them. `Array.chunksOf` copies
 * the rest of the array at each cut, and on a large page that copy alone takes
 * longer than many slices.
 */
export const mapChunked = <A, B>(
  transform: (item: A) => Option.Option<B>,
): ((items: ReadonlyArray<A>) => Effect.Effect<ReadonlyArray<B>, never, Dom>) =>
  Effect.fnUntraced(function* (items: ReadonlyArray<A>) {
    const slices = yield* startSlices(CHUNK_BUDGET_MS);
    const mapBatch = (batch: ReadonlyArray<A>, index: number): Effect.Effect<ReadonlyArray<B>> =>
      pipe(
        // The slice check runs between two batches, and never after the last.
        index > 0,
        Boolean.match({ onFalse: () => Effect.void, onTrue: () => slices.check }),
        Effect.andThen(Effect.sync(() => pipe(batch, Array.map(transform), Array.getSomes))),
      );
    const mapped = yield* pipe(items, Iterable.chunksOf(CHECK_EVERY), Effect.forEach(mapBatch));
    return Array.flatten(mapped);
  });
