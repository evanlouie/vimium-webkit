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
import { Deferred, Effect, Fiber, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import {
  type HintDescriptor,
  MAX_SESSION_DESCRIPTORS,
  REQUEST_DEADLINE_MS,
} from "~/domain/FrameMessage.ts";
import {
  abortAfterSafety,
  COLLECT_DEADLINE_MS,
  collectFrameDescriptors,
  KEY_BUFFER_SAFETY_MS,
  raceUntilAbort,
} from "~/features/hints/Hints.ts";
import type { FrameId } from "~/platform/Realm.ts";

const SAFETY_MS = 1000;

const frameId = (value: string): FrameId => value as FrameId;

const descriptors = (
  owner: FrameId,
  count: number,
): readonly HintDescriptor[] =>
  Array.from({ length: count }, (_, localIndex) => ({
    frameId: owner,
    localIndex,
    linkText: `link ${localIndex}`,
    secondary: false,
  }));

describe("the hint round", () => {
  it.effect("keeps the safety deadline after the collection deadline", () =>
    Effect.sync(() => {
      assert.strictEqual(COLLECT_DEADLINE_MS, REQUEST_DEADLINE_MS + 500);
      assert.strictEqual(KEY_BUFFER_SAFETY_MS, COLLECT_DEADLINE_MS + 500);
    }));

  it.effect("ends the round when the safety time runs out", () =>
    Effect.gen(function*() {
      const abort = yield* Deferred.make<void>();
      const released = yield* Ref.make(false);
      const answered = yield* Ref.make(false);
      const stopped = yield* Ref.make(false);

      // One frame answers long after the timeout.
      const collect = Effect.onInterrupt(
        Effect.andThen(
          Effect.sleep(5000),
          Effect.as(Ref.set(answered, true), Option.some("hints")),
        ),
        () => Ref.set(stopped, true),
      );

      yield* Effect.forkScoped(
        abortAfterSafety(abort, Ref.set(released, true), SAFETY_MS),
      );
      const round = yield* Effect.forkChild(raceUntilAbort(collect, abort));

      yield* TestClock.adjust(SAFETY_MS);
      assert.isTrue(yield* Ref.get(released), "the keyboard stayed captured");
      assert.isTrue(yield* Ref.get(stopped), "the collection went on");

      yield* TestClock.adjust(10_000);
      const outcome = yield* Fiber.join(round);
      assert.isTrue(Option.isNone(outcome), "a late answer built a session");
      assert.isFalse(yield* Ref.get(answered), "the late answer was used");
    }));

  it.effect("keeps the hints of a round that answers in time", () =>
    Effect.gen(function*() {
      const abort = yield* Deferred.make<void>();
      const released = yield* Ref.make(false);

      const collect = Effect.andThen(
        Effect.sleep(100),
        Effect.succeed(Option.some("hints")),
      );

      yield* Effect.forkScoped(
        abortAfterSafety(abort, Ref.set(released, true), SAFETY_MS),
      );
      const round = yield* Effect.forkChild(raceUntilAbort(collect, abort));

      yield* TestClock.adjust(100);
      const outcome = yield* Fiber.join(round);
      assert.deepEqual(outcome, Option.some("hints"));
      assert.isFalse(yield* Ref.get(released), "the safety time ran too early");
    }));

  it.effect("bounds the merged replies before the coordinator sends them", () =>
    Effect.gen(function*() {
      const first = frameId("1111111111111111");
      const second = frameId("2222222222222222");
      const replies = new Map<FrameId, readonly HintDescriptor[]>([
        [first, descriptors(first, 5000)],
        [second, descriptors(second, 5000)],
      ]);

      const result = yield* collectFrameDescriptors(
        [first, second],
        (owner) => Effect.succeed(replies.get(owner) ?? []),
      );
      assert.strictEqual(result.descriptors.length, MAX_SESSION_DESCRIPTORS);
      assert.strictEqual(result.dropped, 2000);
    }));

  it.effect("ends the round when the user presses Escape", () =>
    Effect.gen(function*() {
      const abort = yield* Deferred.make<void>();
      const collect = Effect.andThen(
        Effect.sleep(5000),
        Effect.succeed(Option.some("hints")),
      );
      const round = yield* Effect.forkChild(raceUntilAbort(collect, abort));

      yield* Deferred.succeed(abort, undefined);
      const outcome = yield* Fiber.join(round);
      assert.isTrue(Option.isNone(outcome));
    }));
});
