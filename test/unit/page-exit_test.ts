/**
 * What this frame does when its page goes away.
 *
 * Three rules are under test, and each one has cost a defect somewhere:
 *
 * 1. The direct write comes first. `pagehide` gives one synchronous run, and a
 *    value that waits for a fiber never reaches the backend.
 * 2. The release comes after the last write. A release closes the scope that
 *    the storage actor lives in, so a release before the flush would drop the
 *    write that the exit hook exists to save.
 * 3. A page that the browser keeps is not released. `pagehide` with
 *    `persisted === true` means that the page may come back, and a restored
 *    page never runs its scripts again. A released application cannot be used
 *    again: its scope is closed, and every listener of it is gone. A frame that
 *    released there would come back dead.
 *
 * The test launches a true layer that counts what it acquires and what it
 * releases, so the answers come from Effect and not from a model of it.
 */

import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Layer, pipe } from "effect";
import { constVoid } from "effect/Function";
import { type ExitParts, launch, onPageExit, RuntimeOwner } from "~/boot/Bootstrap.ts";
import { PageExit } from "~/boot/Lifecycle.ts";

// ---------------------------------------------------------------------------
// A frame, in miniature
// ---------------------------------------------------------------------------

/**
 * One resource of the kind that a page realm holds.
 *
 * A listener, a port, a manager callback and a stylesheet all have this shape:
 * the layer takes them, and the scope gives them back.
 */
const countedLayer = (log: string[]): Layer.Layer<never> =>
  Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.sync(() => {
        log.push("acquire");
      }),
      () =>
        Effect.sync(() => {
          log.push("release");
        }),
    ),
  );

/** Launch a frame, and keep the release that it gives its application. */
const startFrame = (log: string[]): Effect.Effect<Effect.Effect<void>> =>
  Effect.gen(function* () {
    const owner = yield* Deferred.make<Effect.Effect<void>>();
    const keepRelease = Layer.effectDiscard(
      pipe(
        RuntimeOwner,
        Effect.flatMap(({ release }) => pipe(owner, Deferred.succeed(release))),
      ),
    );
    yield* launch(Layer.mergeAll(countedLayer(log), keepRelease));
    return yield* Deferred.await(owner);
  });

/** The parts of an exit hook that write nothing, around one release. */
const releaseOnly = (release: Effect.Effect<void>): ExitParts => ({
  flushAllUnsafe: constVoid,
  forgetSuppressed: Effect.void,
  flushAll: Effect.void,
  release,
});

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe("the application of a frame", () => {
  it.effect("acquires and releases in step over repeated starts and exits", () =>
    Effect.gen(function* () {
      const log: string[] = [];

      const startAndExit = Effect.gen(function* () {
        const release = yield* startFrame(log);
        yield* onPageExit(releaseOnly(release))(PageExit.Final());
      });

      yield* pipe(startAndExit, Effect.replicateEffect(3, { discard: true }));

      assert.deepStrictEqual(log, [
        "acquire",
        "release",
        "acquire",
        "release",
        "acquire",
        "release",
      ]);
    }),
  );

  it.effect("keeps everything when the browser keeps the page", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      const release = yield* startFrame(log);

      yield* onPageExit(releaseOnly(release))(PageExit.Resumable());

      assert.deepStrictEqual(log, ["acquire"]);

      // A restored page never runs its scripts again, so this application is
      // the only one that it will ever have. It is still there to release.
      yield* onPageExit(releaseOnly(release))(PageExit.Final());
      assert.deepStrictEqual(log, ["acquire", "release"]);
    }),
  );

  it.effect("releases once, however often it is asked", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      const release = yield* startFrame(log);

      yield* onPageExit(releaseOnly(release))(PageExit.Final());
      yield* onPageExit(releaseOnly(release))(PageExit.Final());

      assert.deepStrictEqual(log, ["acquire", "release"]);
    }),
  );

  it.effect("releases only what this frame built", () =>
    Effect.gen(function* () {
      const top: string[] = [];
      const child: string[] = [];
      yield* startFrame(top);
      const releaseChild = yield* startFrame(child);

      // The child document goes away. Each frame has its own realm, its own
      // window and its own application, so `pagehide` reaches the child only.
      yield* onPageExit(releaseOnly(releaseChild))(PageExit.Final());

      assert.deepStrictEqual(child, ["acquire", "release"]);
      assert.deepStrictEqual(top, ["acquire"]);
    }),
  );
});

describe("the order of the exit", () => {
  it.effect("releases the runtime only after the last write", () =>
    Effect.gen(function* () {
      // A plain array, because one of the steps is not an effect at all.
      const order: string[] = [];
      const note = (step: string): Effect.Effect<void> =>
        Effect.sync(() => {
          order.push(step);
        });

      yield* onPageExit({
        flushAllUnsafe: () => {
          order.push("direct write");
        },
        forgetSuppressed: note("forget"),
        // The true flush suspends: it hands the value to the storage actor,
        // and the answer comes back on another fiber.
        flushAll: pipe(Effect.yieldNow, Effect.andThen(note("write"))),
        release: note("release"),
      })(PageExit.Final());

      assert.deepStrictEqual(order, ["direct write", "forget", "write", "release"]);
    }),
  );

  it.effect("starts the work that cannot suspend first", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const note = (step: string): Effect.Effect<void> =>
        Effect.sync(() => {
          order.push(step);
        });

      // A hidden tab, and not an exit. Nothing may be released.
      yield* onPageExit({
        flushAllUnsafe: () => {
          order.push("direct write");
        },
        forgetSuppressed: note("forget"),
        flushAll: note("write"),
        release: note("release"),
      })(PageExit.Resumable());

      assert.deepStrictEqual(order, ["direct write", "forget", "write"]);
    }),
  );
});
