/**
 * The safety timeout of a hint round.
 *
 * A round buffers the keys of the user while it collects the hints. The buffer
 * has a safety time, because a page whose keyboard is dead costs more than a
 * few keystrokes. The round must end at that moment as well: a frame that
 * answers later would draw markers and take the keyboard from a user who is
 * already typing into the page.
 */

import { assert, describe, it } from "@effect/vitest";
import { Array, Deferred, Effect, Fiber, Option, Ref, pipe } from "effect";
import { TestClock } from "effect/testing";
import { type HintDescriptor, MAX_SESSION_DESCRIPTORS } from "~/domain/FrameMessage.ts";
import {
  abortAfterSafety,
  collectFrameDescriptors,
  raceUntilAbort,
} from "~/features/hints/Hints.ts";
import { FrameId } from "~/domain/FrameId.ts";

const SAFETY_MS = 1000;

const descriptors = (owner: FrameId, count: number): readonly HintDescriptor[] =>
  pipe(
    count,
    Array.makeBy((localIndex) => ({
      frameId: owner,
      localIndex,
      linkText: `link ${localIndex}`,
      secondary: false,
    })),
  );

describe("the hint round", () => {
  it.effect("ends the round when the safety time runs out", () =>
    Effect.gen(function* () {
      const abort = yield* Deferred.make<void>();
      const released = yield* Ref.make(false);
      const answered = yield* Ref.make(false);
      const stopped = yield* Ref.make(false);

      // One frame answers long after the timeout.
      const answer = pipe(answered, Ref.set(true));
      const collect = pipe(
        Effect.sleep(5000),
        Effect.andThen(answer),
        Effect.as(Option.some("hints")),
        Effect.onInterrupt(() => pipe(stopped, Ref.set(true))),
      );
      const release = pipe(released, Ref.set(true));

      yield* pipe(abortAfterSafety(abort, release, SAFETY_MS), Effect.forkScoped);
      const round = yield* pipe(raceUntilAbort(collect, abort), Effect.forkChild);

      yield* TestClock.adjust(SAFETY_MS);
      assert.isTrue(yield* Ref.get(released), "the keyboard stayed captured");
      assert.isTrue(yield* Ref.get(stopped), "the collection went on");

      yield* TestClock.adjust(10_000);
      const outcome = yield* Fiber.join(round);
      assert.isTrue(Option.isNone(outcome), "a late answer built a session");
      assert.isFalse(yield* Ref.get(answered), "the late answer was used");
    }),
  );

  it.effect("keeps the hints of a round that answers in time", () =>
    Effect.gen(function* () {
      const abort = yield* Deferred.make<void>();
      const released = yield* Ref.make(false);

      const collect = pipe(Effect.sleep(100), Effect.as(Option.some("hints")));
      const release = pipe(released, Ref.set(true));

      yield* pipe(abortAfterSafety(abort, release, SAFETY_MS), Effect.forkScoped);
      const round = yield* pipe(raceUntilAbort(collect, abort), Effect.forkChild);

      yield* TestClock.adjust(100);
      const outcome = yield* Fiber.join(round);
      assert.deepEqual(outcome, Option.some("hints"));
      assert.isFalse(yield* Ref.get(released), "the safety time ran too early");
    }),
  );

  it.effect("bounds the merged replies before the coordinator sends them", () =>
    Effect.gen(function* () {
      const first = FrameId.make("1111111111111111");
      const second = FrameId.make("2222222222222222");

      // Each frame answers with 5000 descriptors of its own.
      const result = yield* collectFrameDescriptors([first, second], (owner) =>
        Effect.succeed(descriptors(owner, 5000)),
      );
      assert.strictEqual(result.descriptors.length, MAX_SESSION_DESCRIPTORS);
      assert.strictEqual(result.dropped, 2000);
    }),
  );

  it.effect("ends the round when the user presses Escape", () =>
    Effect.gen(function* () {
      const abort = yield* Deferred.make<void>();
      const collect = pipe(Effect.sleep(5000), Effect.as(Option.some("hints")));
      const round = yield* pipe(raceUntilAbort(collect, abort), Effect.forkChild);

      yield* pipe(abort, Deferred.succeed<void>(undefined));
      const outcome = yield* Fiber.join(round);
      assert.isTrue(Option.isNone(outcome));
    }),
  );
});
