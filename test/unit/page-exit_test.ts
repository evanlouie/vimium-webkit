/**
 * What this frame does when its page goes away.
 *
 * Two rules are under test, and each one has cost a defect somewhere:
 *
 * 1. The release comes after the last write. A release closes the scope that
 *    the storage actor lives in, so a release before the flush would drop the
 *    write that the exit hook exists to save.
 * 2. A page that the browser keeps is not released. `pagehide` with
 *    `persisted === true` means that the page may come back, and a restored
 *    page never runs its scripts again. A released runtime cannot be used
 *    again: `dispose` replaces its context with a defect and closes its scope.
 *    A frame that released there would come back dead.
 *
 * The test uses a true `ManagedRuntime` over a layer that counts what it
 * acquires and what it releases, so the answers come from Effect and not from a
 * model of it.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, ManagedRuntime, Ref } from "effect";
import { makeOwnedRuntime, onPageExit } from "~/boot/Bootstrap.ts";

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
  Layer.effectDiscard(Effect.acquireRelease(
    Effect.sync(() => {
      log.push("acquire");
    }),
    () =>
      Effect.sync(() => {
        log.push("release");
      }),
  ));

/** Build a runtime for one frame, and give back what the exit hook needs. */
const startFrame = (log: string[]) =>
  makeOwnedRuntime((owner) =>
    ManagedRuntime.make(Layer.merge(countedLayer(log), owner))
  );

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe("the runtime of a frame", () => {
  it.effect(
    "acquires and releases in step over repeated starts and exits",
    () =>
      Effect.gen(function*() {
        const log: string[] = [];

        for (let round = 0; round < 3; round++) {
          const frame = startFrame(log);
          // The layer is lazy. Running one effect builds it, exactly as the
          // first run of the application does.
          yield* Effect.promise(() => frame.runtime.runPromise(Effect.void));
          yield* onPageExit({
            forgetSuppressed: Effect.void,
            flushAll: Effect.void,
            release: frame.release,
          })({ final: true });
        }

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

  it.effect(
    "keeps everything when the browser keeps the page",
    () =>
      Effect.gen(function*() {
        const log: string[] = [];
        const frame = startFrame(log);
        yield* Effect.promise(() => frame.runtime.runPromise(Effect.void));

        yield* onPageExit({
          forgetSuppressed: Effect.void,
          flushAll: Effect.void,
          release: frame.release,
        })({ final: false });

        assert.deepStrictEqual(log, ["acquire"]);

        // The proof that matters for the back/forward cache: the frame still
        // works. A restored page never runs its scripts again, so this runtime
        // is the only one that it will ever have.
        const answer = yield* Effect.promise(() =>
          frame.runtime.runPromise(Effect.succeed("alive"))
        );
        assert.strictEqual(answer, "alive");
      }),
  );

  it.effect(
    "cannot be used again after a final exit",
    () =>
      Effect.gen(function*() {
        const log: string[] = [];
        const frame = startFrame(log);
        yield* Effect.promise(() => frame.runtime.runPromise(Effect.void));

        yield* onPageExit({
          forgetSuppressed: Effect.void,
          flushAll: Effect.void,
          release: frame.release,
        })({ final: true });

        assert.deepStrictEqual(log, ["acquire", "release"]);

        // This is why a persisted exit must not release. `dispose` puts a
        // defect in the place of the context.
        const outcome = yield* Effect.promise(() =>
          frame.runtime.runPromiseExit(Effect.succeed("alive"))
        );
        assert.isTrue(
          Exit.isFailure(outcome),
          "a released runtime must refuse work",
        );
      }),
  );

  it.effect(
    "releases only what this frame built",
    () =>
      Effect.gen(function*() {
        const top: string[] = [];
        const child: string[] = [];
        const topFrame = startFrame(top);
        const childFrame = startFrame(child);
        yield* Effect.promise(() => topFrame.runtime.runPromise(Effect.void));
        yield* Effect.promise(() => childFrame.runtime.runPromise(Effect.void));

        // The child document goes away. Each frame has its own realm, its own
        // window and its own runtime, so `pagehide` reaches the child only.
        yield* onPageExit({
          forgetSuppressed: Effect.void,
          flushAll: Effect.void,
          release: childFrame.release,
        })({ final: true });

        assert.deepStrictEqual(child, ["acquire", "release"]);
        assert.deepStrictEqual(top, ["acquire"]);

        const answer = yield* Effect.promise(() =>
          topFrame.runtime.runPromise(Effect.succeed("alive"))
        );
        assert.strictEqual(answer, "alive");
      }),
  );
});

describe("the order of the exit", () => {
  it.effect(
    "releases the runtime only after the last write",
    () =>
      Effect.gen(function*() {
        const order = yield* Ref.make<ReadonlyArray<string>>([]);
        const note = (step: string): Effect.Effect<void> =>
          Ref.update(order, (current) => [...current, step]);

        yield* onPageExit({
          forgetSuppressed: note("forget"),
          // The true flush suspends: it hands the value to the storage actor,
          // and the answer comes back on another fiber.
          flushAll: Effect.andThen(Effect.yieldNow, note("write")),
          release: note("release"),
        })({ final: true });

        assert.deepStrictEqual(yield* Ref.get(order), [
          "forget",
          "write",
          "release",
        ]);
      }),
  );

  it.effect(
    "starts the work that cannot suspend first",
    () =>
      Effect.gen(function*() {
        const order = yield* Ref.make<ReadonlyArray<string>>([]);
        const note = (step: string): Effect.Effect<void> =>
          Ref.update(order, (current) => [...current, step]);

        // A hidden tab, and not an exit. Nothing may be released.
        yield* onPageExit({
          forgetSuppressed: note("forget"),
          flushAll: note("write"),
          release: note("release"),
        })({ final: false });

        assert.deepStrictEqual(yield* Ref.get(order), ["forget", "write"]);
      }),
  );
});
