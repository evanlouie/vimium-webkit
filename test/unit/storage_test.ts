/**
 * Persistence, as one serial actor per group.
 *
 * Storage is untrusted input. A user can edit it in the interface of the
 * manager, an older build may have written it, and a newer build in another
 * tab may have written it. Every read is decoded, and every failure gives the
 * defaults and one message.
 *
 * Every test builds its own backend layer. Nothing here touches a global, and
 * the debounce is driven by `TestClock`, so no test waits for real time.
 */

import { assert, describe, it } from "@effect/vitest";
import {
  Array,
  Boolean,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  MutableRef,
  Option,
  Queue,
  Record,
  Result,
  Stream,
  Struct,
  pipe,
} from "effect";
import { TestClock } from "effect/testing";
import { defaultSettings } from "~/domain/Persisted.ts";
import { GmError, StoreKind } from "~/platform/Gm.ts";
import { KeyValueStore, STORAGE_PREFIX } from "~/platform/KeyValueStore.ts";
import { Storage, type StorageError } from "~/platform/Storage.ts";

const SETTINGS_KEY = `${STORAGE_PREFIX}settings`;
const SESSION_KEY = `${STORAGE_PREFIX}session`;

/** A backend that a test can seed, watch and make fail. */
interface Backend {
  readonly layer: Layer.Layer<KeyValueStore>;
  /** Put a raw value in the store, as another build would have left it. */
  readonly seed: (key: string, raw: string) => Effect.Effect<void>;
  /** The raw value in the store, if there is one. */
  readonly read: (key: string) => Effect.Effect<Option.Option<string>>;
  /** Every value that reached the backend, in commit order. */
  readonly writes: Effect.Effect<readonly string[]>;
  /** The same list, read with no effect. For an assertion inside a dispatch. */
  readonly writesNow: () => readonly string[];
  /** How many writes of the actor have started, held or not. */
  readonly startedNow: () => number;
  /** Make every later read fail with a transport error. */
  readonly breakReads: Effect.Effect<void>;
  /** Make the next direct write throw, as a full quota does. */
  readonly breakNextDirectWrite: Effect.Effect<void>;
  /** Hold every later write of the actor, until `releaseWrites` runs. */
  readonly holdWrites: Effect.Effect<void>;
  readonly releaseWrites: Effect.Effect<void>;
  /** Make the next actor write fail like a rejected manager promise. */
  readonly breakNextActorWrite: Effect.Effect<void>;
}

/**
 * The state is in references, and not in `Ref`s.
 *
 * The exit path writes with a direct call, and a test must read what it wrote
 * without taking a turn of its own. A `Ref` would need an effect for that.
 */
const makeBackendFor = (kind: StoreKind): Effect.Effect<Backend> =>
  Effect.gen(function* () {
    const stored = MutableRef.make<Record.ReadonlyRecord<string, string>>({});
    const writes = MutableRef.make<readonly string[]>([]);
    const started = MutableRef.make(0);
    const gate = yield* Deferred.make<void>();
    const readsFail = MutableRef.make(false);
    const writesHeld = MutableRef.make(false);
    // One-shot faults. Taking one disarms it.
    const directWriteFails = MutableRef.make(false);
    const actorWriteFails = MutableRef.make(false);

    const put = (key: string, value: string): void => {
      pipe(stored, MutableRef.update(Record.set(key, value)));
    };

    const record = (key: string, value: string): void => {
      put(key, value);
      pipe(writes, MutableRef.update(Array.append(value)));
    };

    const current = (key: string): Option.Option<string> =>
      pipe(MutableRef.get(stored), Record.get(key));

    const awaitRelease = Effect.suspend(() =>
      pipe(
        MutableRef.get(writesHeld),
        Boolean.match({
          onFalse: () => Effect.void,
          onTrue: () => Deferred.await(gate),
        }),
      ),
    );

    const directWrite = (key: string, value: string): void =>
      pipe(
        directWriteFails,
        MutableRef.getAndSet(false),
        Boolean.match({
          onFalse: () => record(key, value),
          // The double throws, as a backend with a full quota does. That throw
          // is the behaviour under test, and a direct call has no other channel.
          onTrue: () => {
            throw new Error("the quota of the backend is full");
          },
        }),
      );

    const service = KeyValueStore.of({
      kind,
      get: (key) =>
        Effect.suspend(() =>
          pipe(
            MutableRef.get(readsFail),
            Boolean.match({
              onFalse: () => Effect.succeed(current(key)),
              onTrue: () =>
                Effect.fail(
                  new GmError({
                    reason: "failed",
                    api: "test.get",
                    detail: "the backend is unavailable",
                  }),
                ),
            }),
          ),
        ),
      set: (key, value) =>
        pipe(
          Effect.sync(() => {
            MutableRef.increment(started);
            return pipe(actorWriteFails, MutableRef.getAndSet(false));
          }),
          Effect.flatMap(
            Boolean.match({
              onFalse: () =>
                pipe(awaitRelease, Effect.andThen(Effect.sync(() => record(key, value)))),
              onTrue: () =>
                Effect.fail(
                  new GmError({
                    reason: "failed",
                    api: "test.set",
                    detail: "the manager promise rejected",
                  }),
                ),
            }),
          ),
        ),
      remove: (key) =>
        Effect.sync(() => {
          pipe(stored, MutableRef.update(Record.remove(key)));
        }),
      setUnsafe: pipe(
        kind,
        StoreKind.$match({
          GmAsync: () => Option.none(),
          GmSync: () => Option.some(directWrite),
          Memory: () => Option.some(directWrite),
        }),
      ),
      changes: () => Stream.empty,
    });

    const open = pipe(gate, Deferred.done(Exit.void));

    const arm = (fault: MutableRef.MutableRef<boolean>): Effect.Effect<void> =>
      Effect.sync(() => {
        pipe(fault, MutableRef.set(true));
      });

    return {
      layer: Layer.succeed(KeyValueStore, service),
      seed: (key, raw) => Effect.sync(() => put(key, raw)),
      read: (key) => Effect.sync(() => current(key)),
      writes: Effect.sync(() => MutableRef.get(writes)),
      writesNow: () => MutableRef.get(writes),
      startedNow: () => MutableRef.get(started),
      breakReads: arm(readsFail),
      breakNextDirectWrite: arm(directWriteFails),
      holdWrites: arm(writesHeld),
      releaseWrites: pipe(
        Effect.sync(() => {
          pipe(writesHeld, MutableRef.set(false));
        }),
        Effect.andThen(open),
      ),
      breakNextActorWrite: arm(actorWriteFails),
    };
  });

const makeBackend = makeBackendFor(StoreKind.Memory());

/**
 * Take `step` until `settled` gives a value.
 *
 * A fiber of the group needs turns of its own, so a test gives turns away
 * until the state that it waits for holds. The loop has a limit, so a state
 * that never arrives fails the test and does not hang it.
 */
const stepUntil = <A>(
  settled: () => Option.Option<A>,
  step: Effect.Effect<void>,
  steps: number,
  stuck: string,
): Effect.Effect<A> => {
  const next = pipe(
    step,
    Effect.andThen(Effect.suspend(() => stepUntil(settled, step, steps - 1, stuck))),
  );
  const again = pipe(
    steps > 0,
    Boolean.match({
      onFalse: () => Effect.die(new Error(stuck)),
      onTrue: () => next,
    }),
  );
  return Effect.suspend(() =>
    pipe(
      settled(),
      Option.match({
        onSome: Effect.succeed,
        onNone: () => again,
      }),
    ),
  );
};

/**
 * Move the test clock forward until the fiber settles.
 *
 * A fiber of the group arms the debounce timer, so the arm can happen after
 * the first step of the clock.
 */
const advanceUntilDone = <A, E>(fiber: Fiber.Fiber<A, E>): Effect.Effect<Exit.Exit<A, E>> =>
  stepUntil(
    () => Option.fromNullishOr(fiber.pollUnsafe()),
    TestClock.adjust("100 millis"),
    20,
    "the fiber never settled",
  );

/** Give the turn away until a condition holds. The group fiber needs a turn to take a command. */
const yieldUntil = (ready: () => boolean): Effect.Effect<void> =>
  stepUntil(
    () =>
      pipe(
        ready(),
        Option.liftPredicate((holds: boolean) => holds),
      ),
    Effect.yieldNow,
    50,
    "the condition never held",
  );

/** Give the turn away a fixed number of times. */
const yieldTurns = (turns: number): Effect.Effect<void> =>
  pipe(
    Array.range(1, turns),
    Effect.forEach(() => Effect.yieldNow, { discard: true }),
  );

/** The envelope that the store writes around a group value. */
const envelope = (schemaVersion: number, data: unknown): string =>
  JSON.stringify({ schemaVersion, data });

/** The write at `index`, or nothing, which no assertion includes. */
const nth = (writes: readonly string[], index: number): string =>
  pipe(
    writes,
    Array.get(index),
    Option.getOrElse(() => ""),
  );

/** The raw value, or nothing, which no assertion includes. */
const orEmpty = (raw: Option.Option<string>): string =>
  pipe(
    raw,
    Option.getOrElse(() => ""),
  );

/**
 * Leave a settings value inside its debounce window.
 *
 * The group publishes the value and then holds it, so a published value is the
 * proof that the group fiber took the command. The write itself completes only
 * when it reaches the backend, so the caller gets the fiber that waits.
 */
const leavePending = (
  storage: Storage["Service"],
  scrollStepSize: number,
): Effect.Effect<Fiber.Fiber<void, StorageError>> =>
  Effect.gen(function* () {
    const writing = yield* pipe(
      defaultSettings(),
      Struct.assign({ scrollStepSize }),
      storage.settings.write,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* yieldUntil(() => storage.settings.currentUnsafe().scrollStepSize === scrollStepSize);
    return writing;
  });

/** The first issue that storage reports, without waiting for a second. */
const firstIssue = (storage: Storage["Service"]): Effect.Effect<Option.Option<StorageError>> =>
  pipe(storage.issues, Stream.take(1), Stream.runCollect, Effect.map(Array.head));

/** The fields of a failure that a test compares, when there is a failure. */
const outline = <const Keys extends ReadonlyArray<keyof StorageError>>(
  failure: Option.Option<StorageError>,
  keys: Keys,
) => pipe(failure, Option.map(Struct.pick(keys)));

/** The failure of an effect, when it fails. */
const failureOf = <A>(
  effect: Effect.Effect<A, StorageError>,
): Effect.Effect<Option.Option<StorageError>> =>
  pipe(effect, Effect.result, Effect.map(Result.getFailure));

describe("Storage", () => {
  it.effect("gives the defaults and one issue for a value that is not JSON", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          yield* backend.seed(SETTINGS_KEY, "{not json");

          const value = yield* storage.settings.hydrate;
          assert.deepEqual(value, defaultSettings());

          const issue = yield* firstIssue(storage);
          assert.deepEqual(
            outline(issue, ["reason", "direction", "group"]),
            Option.some({ reason: "malformed", direction: "read", group: "settings" }),
          );
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("gives the defaults for a value from a newer build, and keeps it", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          // A newer build in another tab wrote this. Do not go backwards, and do
          // not overwrite it.
          const newer = envelope(
            99,
            pipe(defaultSettings(), Struct.assign({ scrollStepSize: 120 })),
          );
          yield* backend.seed(SETTINGS_KEY, newer);

          const value = yield* storage.settings.hydrate;
          assert.deepEqual(value, defaultSettings());

          const issue = yield* firstIssue(storage);
          assert.deepEqual(outline(issue, ["reason"]), Option.some({ reason: "invalid" }));
          const detail = pipe(
            issue,
            Option.map((found) => found.detail),
            orEmpty,
          );
          assert.include(detail, "99");

          // The defaults are no base for a change, so an update is refused and
          // the stored value is left alone.
          const failure = yield* pipe(
            storage.settings.update(Struct.assign({ smoothScroll: false })),
            failureOf,
          );
          assert.deepEqual(
            outline(failure, ["reason", "direction"]),
            Option.some({ reason: "invalid", direction: "read" }),
          );
          assert.deepEqual(yield* backend.read(SETTINGS_KEY), Option.some(newer));
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("gives the defaults for a value that fails its schema", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          // `marks` has no per-field fallback, so the whole group falls back.
          yield* backend.seed(
            `${STORAGE_PREFIX}marks`,
            envelope(1, { local: "not a record", global: {} }),
          );

          const value = yield* storage.marks.hydrate;
          assert.deepEqual(value, { local: {}, global: {} });

          const issue = yield* firstIssue(storage);
          assert.deepEqual(outline(issue, ["reason"]), Option.some({ reason: "invalid" }));
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("completes a debounced write only when it reaches the backend", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          const writing = yield* pipe(
            defaultSettings(),
            Struct.assign({ scrollStepSize: 120 }),
            storage.settings.write,
            Effect.forkChild({ startImmediately: true }),
          );

          // The settings group joins writes for 250 ms, so nothing has reached
          // the backend and the caller is still waiting.
          assert.isUndefined(writing.pollUnsafe());
          assert.deepEqual(yield* backend.writes, []);
          assert.isTrue(Option.isNone(yield* backend.read(SETTINGS_KEY)));

          const outcome = yield* advanceUntilDone(writing);
          assert.isTrue(Exit.isSuccess(outcome));
          assert.strictEqual((yield* storage.settings.current).scrollStepSize, 120);

          const raw = yield* backend.read(SETTINGS_KEY);
          assert.isTrue(Option.isSome(raw));
          assert.include(orEmpty(raw), '"scrollStepSize":120');
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("does not debounce a promise-backed manager", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackendFor(StoreKind.GmAsync());

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          const writing = yield* pipe(
            defaultSettings(),
            Struct.assign({ scrollStepSize: 120 }),
            storage.settings.write,
            Effect.forkChild({ startImmediately: true }),
          );

          yield* yieldUntil(() => backend.startedNow() === 1);
          yield* Fiber.join(writing);
          assert.lengthOf(backend.writesNow(), 1);
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("waits for a manager promise before it starts the next write", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackendFor(StoreKind.GmAsync());

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          const base = yield* storage.session.current;
          yield* backend.holdWrites;

          const first = yield* pipe(
            base,
            Struct.assign({ acknowledged: ["first"] }),
            storage.session.write,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* yieldUntil(() => backend.startedNow() === 1);

          const second = yield* pipe(
            base,
            Struct.assign({ acknowledged: ["second"] }),
            storage.session.write,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* yieldTurns(10);

          assert.strictEqual(backend.startedNow(), 1);
          yield* backend.releaseWrites;
          yield* Fiber.join(first);
          yield* Fiber.join(second);

          const writes = backend.writesNow();
          assert.lengthOf(writes, 2);
          assert.include(nth(writes, 0), "first");
          assert.include(nth(writes, 1), "second");
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("reports a rejected manager promise and fails the caller", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackendFor(StoreKind.GmAsync());

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          const reported = yield* pipe(
            firstIssue(storage),
            Effect.forkChild({ startImmediately: true }),
          );
          yield* backend.breakNextActorWrite;

          const failure = yield* pipe(
            storage.session.currentUnsafe(),
            Struct.assign({ acknowledged: ["rejected"] }),
            storage.session.write,
            failureOf,
          );
          assert.deepEqual(
            outline(failure, ["reason", "direction"]),
            Option.some({ reason: "backend", direction: "write" }),
          );

          yield* yieldUntil(() => reported.pollUnsafe() !== undefined);
          const issue = yield* Fiber.join(reported);
          // The message and the failure describe the same write.
          assert.deepEqual(
            outline(issue, ["reason", "direction", "detail"]),
            outline(failure, ["reason", "direction", "detail"]),
          );
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("commits a waiting write at once on a flush", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          const writing = yield* pipe(
            defaultSettings(),
            Struct.assign({ scrollStepSize: 90 }),
            storage.settings.write,
            Effect.forkChild({ startImmediately: true }),
          );

          yield* storage.settings.flush;
          yield* Fiber.join(writing);
          assert.lengthOf(yield* backend.writes, 1);
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("fails a waiting write with `cancelled` when a reset arrives", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;

          const writing = yield* pipe(
            defaultSettings(),
            Struct.assign({ scrollStepSize: 120 }),
            storage.settings.write,
            Effect.forkChild({ startImmediately: true }),
          );
          // The queue is first in, first out, so the reset runs after the write
          // command, and before the debounce ends.
          yield* storage.settings.reset;

          const outcome = yield* Fiber.await(writing);
          assert.deepEqual(
            outline(Exit.findErrorOption(outcome), ["reason", "direction"]),
            Option.some({ reason: "cancelled", direction: "write" }),
            "the waiting write must fail",
          );

          // The write never reached the backend, and the defaults are in memory.
          assert.deepEqual(yield* backend.writes, []);
          assert.deepEqual(yield* storage.settings.current, defaultSettings());
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("refuses an update after a read failure of the backend", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          yield* backend.breakReads;

          // The defaults are an answer for this caller, and not the state of the
          // world. They must not be written over good data later.
          yield* storage.settings.hydrate;

          const failure = yield* pipe(
            storage.settings.update(Struct.assign({ scrollStepSize: 120 })),
            failureOf,
          );
          assert.deepEqual(
            outline(failure, ["reason", "direction"]),
            Option.some({ reason: "backend", direction: "read" }),
          );
          assert.deepEqual(yield* backend.writes, []);
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("writes in the order of the calls", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          // The session group writes at once, so each write is its own commit.
          const base = yield* storage.session.current;

          const first = yield* pipe(
            base,
            Struct.assign({ acknowledged: ["first"] }),
            storage.session.write,
            Effect.forkChild({ startImmediately: true }),
          );
          const second = yield* pipe(
            base,
            Struct.assign({ acknowledged: ["second"] }),
            storage.session.write,
            Effect.forkChild({ startImmediately: true }),
          );

          yield* Fiber.join(first);
          yield* Fiber.join(second);

          const writes = yield* backend.writes;
          assert.lengthOf(writes, 2);
          assert.include(nth(writes, 0), "first");
          assert.include(nth(writes, 1), "second");

          const raw = yield* backend.read(SESSION_KEY);
          assert.isTrue(Option.isSome(raw));
          assert.include(orEmpty(raw), "second");
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("reads back what it wrote", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          yield* storage.session.write({
            knownTabs: [],
            acknowledged: ["one"],
            zoomByOrigin: {},
          });
          assert.deepEqual(storage.session.currentUnsafe().acknowledged, ["one"]);

          const reread = yield* storage.session.hydrate;
          assert.deepEqual(reread.acknowledged, ["one"]);
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("erases the stored value and goes back to the defaults", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          yield* storage.session.write({
            knownTabs: [],
            acknowledged: ["one"],
            zoomByOrigin: {},
          });
          const stored = yield* backend.read(SESSION_KEY);
          assert.isTrue(Option.isSome(stored));
          assert.include(orEmpty(stored), '"acknowledged":["one"]');

          const defaults = yield* storage.session.reset;
          assert.deepEqual(defaults, {
            knownTabs: [],
            acknowledged: [],
            zoomByOrigin: {},
          });
          assert.deepEqual(storage.session.currentUnsafe(), defaults);
          assert.isTrue(Option.isNone(yield* backend.read(SESSION_KEY)));
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("publishes the value that was stored, not the value offered", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          // The schema removes duplicate characters, so the stored value differs
          // from the offered value. Memory must hold what storage holds.
          const updating = yield* pipe(
            storage.settings.update(Struct.assign({ linkHintCharacters: "aabb" })),
            Effect.forkChild({ startImmediately: true }),
          );
          yield* storage.settings.flush;
          const stored = yield* Fiber.join(updating);
          assert.strictEqual(stored.linkHintCharacters, "aabb");

          const inMemory = yield* storage.settings.current;
          assert.strictEqual(inMemory.linkHintCharacters, "ab");
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("gives the current value first on the change stream", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          const seen = yield* Queue.unbounded<number>();
          yield* pipe(
            storage.settings.changes,
            Stream.runForEach((settings) => pipe(seen, Queue.offer(settings.scrollStepSize))),
            Effect.forkScoped,
          );

          assert.strictEqual(yield* Queue.take(seen), 60);

          const writing = yield* pipe(
            defaultSettings(),
            Struct.assign({ scrollStepSize: 120 }),
            storage.settings.write,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* storage.settings.flush;
          yield* Fiber.join(writing);
          assert.strictEqual(yield* Queue.take(seen), 120);
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("reads every group when the application starts", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          const settings = pipe(defaultSettings(), Struct.assign({ scrollStepSize: 120 }));
          yield* backend.seed(SETTINGS_KEY, envelope(1, settings));
          yield* backend.seed(
            `${STORAGE_PREFIX}find-history`,
            envelope(1, { queries: ["needle"] }),
          );

          yield* storage.hydrateAll;
          assert.strictEqual((yield* storage.settings.current).scrollStepSize, 120);
          assert.deepEqual((yield* storage.findHistory.current).queries, ["needle"]);
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );
});

/**
 * The path that a dying page uses.
 *
 * `pagehide` gives one synchronous run. The Effect scheduler is a macrotask in
 * a page, so a value that waits for the group fiber never reaches the backend.
 * Every test below therefore asserts on what the backend holds *before* the
 * test gives the turn back.
 */
describe("the exit path of Storage", () => {
  it.effect("writes the held value before it gives the turn back", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          const writing = yield* leavePending(storage, 120);
          assert.deepEqual(
            backend.writesNow(),
            [],
            "the debounce window must still hold the value",
          );

          // One synchronous step, exactly like a `pagehide` handler.
          const insideDispatch = yield* Effect.sync(() => {
            storage.flushAllUnsafe();
            return backend.writesNow();
          });

          assert.lengthOf(
            insideDispatch,
            1,
            "the backend call must start before the dispatch returns",
          );
          assert.include(nth(insideDispatch, 0), '"scrollStepSize":120');

          // The actor takes its own turn afterwards, and it finds nothing to do.
          const outcome = yield* advanceUntilDone(writing);
          assert.isTrue(Exit.isSuccess(outcome));
          assert.lengthOf(backend.writesNow(), 1, "the value must not be written a second time");
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("keeps the order of two writes to one key", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          // Both writes are inside one debounce window, so the second replaces
          // the first. The backend must never see the first one after it.
          yield* leavePending(storage, 120);
          const second = yield* leavePending(storage, 90);

          yield* Effect.sync(() => storage.flushAllUnsafe());
          yield* advanceUntilDone(second);

          const third = yield* leavePending(storage, 150);
          yield* advanceUntilDone(third);

          const writes = backend.writesNow();
          assert.lengthOf(writes, 2);
          assert.include(nth(writes, 0), '"scrollStepSize":90');
          assert.include(nth(writes, 1), '"scrollStepSize":150');
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("leaves alone a value that the actor is already writing", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          yield* backend.holdWrites;
          const writing = yield* leavePending(storage, 120);

          // The actor takes the value out of the window and stops inside the
          // backend call. Nothing is owed to the exit path any more.
          const flushing = yield* pipe(
            storage.settings.flush,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* yieldUntil(() => backend.startedNow() === 1);

          yield* Effect.sync(() => storage.flushAllUnsafe());
          assert.deepEqual(
            backend.writesNow(),
            [],
            "the exit path must not write over a call that is in flight",
          );

          yield* backend.releaseWrites;
          yield* Fiber.join(flushing);
          yield* Fiber.join(writing);
          assert.lengthOf(backend.writesNow(), 1);
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("returns when the backend throws, and lets the actor try again", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          yield* backend.breakNextDirectWrite;
          const writing = yield* leavePending(storage, 120);

          // A throw here would be swallowed by the browser, and the rest of the
          // exit hook would never run.
          const returned = yield* Effect.sync(() => Result.try(() => storage.flushAllUnsafe()));
          assert.isTrue(Result.isSuccess(returned), "the pagehide handler must return");
          assert.deepEqual(backend.writesNow(), []);

          const issue = yield* firstIssue(storage);
          assert.deepEqual(
            outline(issue, ["reason", "direction"]),
            Option.some({ reason: "backend", direction: "write" }),
          );

          // The value is still pending, so the actor writes it on its own turn.
          const outcome = yield* advanceUntilDone(writing);
          assert.isTrue(Exit.isSuccess(outcome));
          assert.lengthOf(backend.writesNow(), 1);
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("continues after the first group direct write fails", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          const settingsWrite = yield* leavePending(storage, 120);
          const marksWrite = yield* pipe(
            storage.marks.write({
              local: {
                "https://example.test/": {
                  a: { scrollX: 1, scrollY: 2, savedAt: 3 },
                },
              },
              global: {},
            }),
            Effect.forkChild({ startImmediately: true }),
          );
          yield* yieldUntil(() =>
            pipe(storage.marks.currentUnsafe().local, Record.has("https://example.test/")),
          );
          yield* backend.breakNextDirectWrite;

          yield* Effect.sync(() => storage.flushAllUnsafe());

          const writes = backend.writesNow();
          assert.lengthOf(writes, 1);
          assert.include(nth(writes, 0), '"a"');

          yield* advanceUntilDone(settingsWrite);
          yield* advanceUntilDone(marksWrite);
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );

  it.effect("uses identical bytes after hydration on both write paths", () =>
    Effect.gen(function* () {
      const directBackend = yield* makeBackend;
      const directBytes = yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          yield* directBackend.seed(SETTINGS_KEY, envelope(0, { scrollStepSize: 120 }));
          const hydrated = yield* storage.settings.hydrate;
          assert.strictEqual(hydrated.scrollStepSize, 120);

          yield* leavePending(storage, 90);
          yield* Effect.sync(() => storage.flushAllUnsafe());
          return nth(directBackend.writesNow(), 0);
        }),
        Effect.provide(Storage.layer),
        Effect.provide(directBackend.layer),
      );

      const actorBackend = yield* makeBackend;
      const actorBytes = yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          yield* actorBackend.seed(SETTINGS_KEY, envelope(0, { scrollStepSize: 120 }));
          const hydrated = yield* storage.settings.hydrate;
          const writing = yield* pipe(
            hydrated,
            Struct.assign({ scrollStepSize: 90 }),
            storage.settings.write,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* storage.settings.flush;
          yield* Fiber.join(writing);
          return nth(actorBackend.writesNow(), 0);
        }),
        Effect.provide(Storage.layer),
        Effect.provide(actorBackend.layer),
      );

      assert.strictEqual(directBytes, actorBytes);
      assert.include(directBytes, '"schemaVersion":1');
    }),
  );

  it.effect("writes nothing when no group holds a value", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend;

      yield* pipe(
        Effect.gen(function* () {
          const storage = yield* Storage;
          yield* Effect.sync(() => storage.flushAllUnsafe());
          assert.deepEqual(backend.writesNow(), []);
        }),
        Effect.provide(Storage.layer),
        Effect.provide(backend.layer),
      );
    }),
  );
});
