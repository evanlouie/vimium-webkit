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
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Result,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { defaultSettings } from "~/domain/Persisted.ts";
import { GmError } from "~/platform/Gm.ts";
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
 * The state is plain, and not a `Ref`.
 *
 * The exit path writes with a direct call, and a test must read what it wrote
 * without taking a turn of its own. A `Ref` would need an effect for that.
 */
const makeBackendFor = (
  kind: KeyValueStore["Service"]["kind"],
): Effect.Effect<Backend> =>
  Effect.gen(function*() {
    const map = new Map<string, string>();
    const writes: string[] = [];
    const gate = yield* Deferred.make<void>();
    let broken = false;
    let directBroken = false;
    let actorBroken = false;
    let held = false;
    let started = 0;

    const put = (key: string, value: string): void => {
      map.set(key, value);
    };

    const record = (key: string, value: string): void => {
      put(key, value);
      writes.push(value);
    };

    const service = KeyValueStore.of({
      kind,
      durable: false,
      watchable: false,
      managerPrivate: true,
      get: (key) =>
        Effect.suspend(() =>
          broken
            ? Effect.fail(
              new GmError({
                reason: "failed",
                api: "test.get",
                detail: "the backend is unavailable",
              }),
            )
            : Effect.succeed(Option.fromNullishOr(map.get(key) ?? null))
        ),
      set: (key, value) =>
        Effect.gen(function*() {
          started += 1;
          if (actorBroken) {
            actorBroken = false;
            return yield* Effect.fail(
              new GmError({
                reason: "failed",
                api: "test.set",
                detail: "the manager promise rejected",
              }),
            );
          }
          if (held) yield* Deferred.await(gate);
          record(key, value);
        }),
      remove: (key) =>
        Effect.sync(() => {
          map.delete(key);
        }),
      setUnsafe: kind === "gm-async"
        ? null
        : (key, value) => {
          if (directBroken) {
            directBroken = false;
            throw new Error("the quota of the backend is full");
          }
          record(key, value);
        },
      changes: () => Stream.empty,
    });

    return {
      layer: Layer.succeed(KeyValueStore, service),
      seed: (key, raw) => Effect.sync(() => put(key, raw)),
      read: (key) =>
        Effect.sync(() => Option.fromNullishOr(map.get(key) ?? null)),
      writes: Effect.sync(() => [...writes]),
      writesNow: () => [...writes],
      startedNow: () => started,
      breakReads: Effect.sync(() => {
        broken = true;
      }),
      breakNextDirectWrite: Effect.sync(() => {
        directBroken = true;
      }),
      holdWrites: Effect.sync(() => {
        held = true;
      }),
      releaseWrites: Effect.gen(function*() {
        held = false;
        yield* Deferred.succeed(gate, undefined);
      }),
      breakNextActorWrite: Effect.sync(() => {
        actorBroken = true;
      }),
    };
  });

const makeBackend = makeBackendFor("memory");

/**
 * Move the test clock forward until the fiber settles.
 *
 * A fiber of the group arms the debounce timer, so the arm can happen after
 * the first step of the clock. The loop has a limit, so a write that never
 * lands fails the test and does not hang it.
 */
const advanceUntilDone = <A, E>(
  fiber: Fiber.Fiber<A, E>,
  steps = 20,
): Effect.Effect<Exit.Exit<A, E>> =>
  Effect.suspend(() => {
    const settled = fiber.pollUnsafe();
    if (settled !== undefined) return Effect.succeed(settled);
    if (steps <= 0) return Effect.die(new Error("the fiber never settled"));
    return Effect.andThen(
      TestClock.adjust("100 millis"),
      advanceUntilDone(fiber, steps - 1),
    );
  });

/** The envelope that the store writes around a group value. */
const envelope = (schemaVersion: number, data: unknown): string =>
  JSON.stringify({ schemaVersion, data });

/**
 * Give the turn away until a condition holds.
 *
 * The group fiber needs a turn to take a command. The loop has a limit, so a
 * condition that never holds fails the test and does not hang it.
 */
const yieldUntil = (
  ready: () => boolean,
  steps = 50,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (ready()) return Effect.void;
    if (steps <= 0) return Effect.die(new Error("the condition never held"));
    return Effect.andThen(Effect.yieldNow, yieldUntil(ready, steps - 1));
  });

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
  Effect.gen(function*() {
    const writing = yield* Effect.forkChild(
      storage.settings.write({ ...defaultSettings(), scrollStepSize }),
      { startImmediately: true },
    );
    yield* yieldUntil(() =>
      storage.settings.currentUnsafe().scrollStepSize === scrollStepSize
    );
    return writing;
  });

/** The first issue that storage reports, without waiting for a second. */
const firstIssue = (
  storage: Storage["Service"],
): Effect.Effect<Option.Option<StorageError>> =>
  Effect.map(
    Stream.runCollect(Stream.take(storage.issues, 1)),
    (issues) => Option.fromNullishOr(issues[0] ?? null),
  );

describe("Storage", () => {
  it.effect("gives the defaults and one issue for a value that is not JSON", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        yield* backend.seed(SETTINGS_KEY, "{not json");

        const value = yield* storage.settings.hydrate;
        assert.deepEqual(value, defaultSettings());

        const issue = yield* firstIssue(storage);
        assert.isTrue(Option.isSome(issue));
        if (Option.isNone(issue)) return;
        assert.strictEqual(issue.value.reason, "malformed");
        assert.strictEqual(issue.value.direction, "read");
        assert.strictEqual(issue.value.group, "settings");
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("gives the defaults for a value from a newer build", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        // A newer build in another tab wrote this. Do not go backwards, and do
        // not overwrite it.
        yield* backend.seed(
          SETTINGS_KEY,
          envelope(99, { ...defaultSettings(), scrollStepSize: 120 }),
        );

        const value = yield* storage.settings.hydrate;
        assert.deepEqual(value, defaultSettings());

        const issue = yield* firstIssue(storage);
        assert.isTrue(Option.isSome(issue));
        if (Option.isNone(issue)) return;
        assert.strictEqual(issue.value.reason, "invalid");
        assert.include(issue.value.detail, "99");

        // The stored value is left alone.
        const raw = yield* backend.read(SETTINGS_KEY);
        assert.isTrue(Option.isSome(raw));
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("gives the defaults for a value that fails its schema", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        // `marks` has no per-field fallback, so the whole group falls back.
        yield* backend.seed(
          `${STORAGE_PREFIX}marks`,
          envelope(1, { local: "not a record", global: {} }),
        );

        const value = yield* storage.marks.hydrate;
        assert.deepEqual(value, { local: {}, global: {} });

        const issue = yield* firstIssue(storage);
        assert.isTrue(Option.isSome(issue));
        if (Option.isNone(issue)) return;
        assert.strictEqual(issue.value.reason, "invalid");
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("completes a debounced write only when it reaches the backend", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        const next = { ...defaultSettings(), scrollStepSize: 120 };

        const writing = yield* Effect.forkChild(
          storage.settings.write(next),
          { startImmediately: true },
        );

        // The settings group joins writes for 250 ms, so nothing has reached
        // the backend and the caller is still waiting.
        assert.isUndefined(writing.pollUnsafe());
        assert.deepEqual(yield* backend.writes, []);
        assert.isTrue(Option.isNone(yield* backend.read(SETTINGS_KEY)));

        const outcome = yield* advanceUntilDone(writing);
        assert.isTrue(Exit.isSuccess(outcome));
        assert.strictEqual(
          (yield* storage.settings.current).scrollStepSize,
          120,
        );

        const raw = yield* backend.read(SETTINGS_KEY);
        assert.isTrue(Option.isSome(raw));
        if (Option.isNone(raw)) return;
        assert.include(raw.value, '"scrollStepSize":120');
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("does not debounce a promise-backed manager", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackendFor("gm-async");

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        const writing = yield* Effect.forkChild(
          storage.settings.write({
            ...defaultSettings(),
            scrollStepSize: 120,
          }),
          { startImmediately: true },
        );

        yield* yieldUntil(() => backend.startedNow() === 1);
        yield* Fiber.join(writing);
        assert.lengthOf(backend.writesNow(), 1);
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("waits for a manager promise before it starts the next write", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackendFor("gm-async");

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        const base = yield* storage.session.current;
        yield* backend.holdWrites;

        const first = yield* Effect.forkChild(
          storage.session.write({ ...base, acknowledged: ["first"] }),
          { startImmediately: true },
        );
        yield* yieldUntil(() => backend.startedNow() === 1);

        const second = yield* Effect.forkChild(
          storage.session.write({ ...base, acknowledged: ["second"] }),
          { startImmediately: true },
        );
        for (let turn = 0; turn < 10; turn += 1) yield* Effect.yieldNow;

        assert.strictEqual(backend.startedNow(), 1);
        yield* backend.releaseWrites;
        yield* Fiber.join(first);
        yield* Fiber.join(second);

        const writes = backend.writesNow();
        assert.lengthOf(writes, 2);
        assert.include(writes[0] ?? "", "first");
        assert.include(writes[1] ?? "", "second");
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("reports a rejected manager promise and fails the caller", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackendFor("gm-async");

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        const reported = yield* Effect.forkChild(firstIssue(storage), {
          startImmediately: true,
        });
        yield* backend.breakNextActorWrite;

        const outcome = yield* Effect.result(
          storage.session.write({
            ...storage.session.currentUnsafe(),
            acknowledged: ["rejected"],
          }),
        );
        assert.isTrue(Result.isFailure(outcome));
        if (Result.isSuccess(outcome)) return;
        assert.strictEqual(outcome.failure.reason, "backend");
        assert.strictEqual(outcome.failure.direction, "write");

        yield* yieldUntil(() => reported.pollUnsafe() !== undefined);
        const issue = yield* Fiber.join(reported);
        assert.isTrue(Option.isSome(issue));
        if (Option.isNone(issue)) return;
        assert.strictEqual(issue.value.reason, outcome.failure.reason);
        assert.strictEqual(issue.value.direction, outcome.failure.direction);
        assert.strictEqual(issue.value.detail, outcome.failure.detail);
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("commits a waiting write at once on a flush", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        const writing = yield* Effect.forkChild(
          storage.settings.write({ ...defaultSettings(), scrollStepSize: 90 }),
          { startImmediately: true },
        );

        yield* storage.settings.flush;
        yield* Fiber.join(writing);
        assert.lengthOf(yield* backend.writes, 1);
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("fails a waiting write with `cancelled` when a reset arrives", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;

        const writing = yield* Effect.forkChild(
          storage.settings.write({ ...defaultSettings(), scrollStepSize: 120 }),
          { startImmediately: true },
        );
        // The queue is first in, first out, so the reset runs after the write
        // command, and before the debounce ends.
        yield* storage.settings.reset;

        const outcome = yield* Fiber.await(writing);
        const error = Option.getOrNull(Exit.findErrorOption(outcome));
        assert.isNotNull(error, "the waiting write must fail");
        assert.strictEqual(error?.reason, "cancelled");
        assert.strictEqual(error?.direction, "write");

        // The write never reached the backend, and the defaults are in memory.
        assert.deepEqual(yield* backend.writes, []);
        assert.deepEqual(yield* storage.settings.current, defaultSettings());
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("refuses an update after a read failure of the backend", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        yield* backend.breakReads;

        // The defaults are an answer for this caller, and not the state of the
        // world. They must not be written over good data later.
        yield* storage.settings.hydrate;

        const outcome = yield* Effect.result(
          storage.settings.update((current) => ({
            ...current,
            scrollStepSize: 120,
          })),
        );
        assert.isTrue(Result.isFailure(outcome));
        const error = Result.isFailure(outcome) ? outcome.failure : null;
        assert.strictEqual(error?.reason, "backend");
        assert.strictEqual(error?.direction, "read");
        assert.deepEqual(yield* backend.writes, []);
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("writes in the order of the calls", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        // The session group writes at once, so each write is its own commit.
        const base = yield* storage.session.current;

        const first = yield* Effect.forkChild(
          storage.session.write({ ...base, acknowledged: ["first"] }),
          { startImmediately: true },
        );
        const second = yield* Effect.forkChild(
          storage.session.write({ ...base, acknowledged: ["second"] }),
          { startImmediately: true },
        );

        yield* Fiber.join(first);
        yield* Fiber.join(second);

        const writes = yield* backend.writes;
        assert.lengthOf(writes, 2);
        assert.include(writes[0] ?? "", "first");
        assert.include(writes[1] ?? "", "second");

        const raw = yield* backend.read(SESSION_KEY);
        assert.isTrue(Option.isSome(raw));
        if (Option.isNone(raw)) return;
        assert.include(raw.value, "second");
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("reads back what it wrote", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        yield* storage.session.write({
          knownTabs: [],
          acknowledged: ["one"],
          zoomByOrigin: {},
        });
        assert.deepEqual(
          storage.session.currentUnsafe().acknowledged,
          ["one"],
        );

        const reread = yield* storage.session.hydrate;
        assert.deepEqual(reread.acknowledged, ["one"]);
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("erases the stored value and goes back to the defaults", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        yield* storage.session.write({
          knownTabs: [],
          acknowledged: [],
          zoomByOrigin: {},
        });
        assert.isTrue(Option.isSome(yield* backend.read(SESSION_KEY)));

        const defaults = yield* storage.session.reset;
        assert.deepEqual(defaults.acknowledged, []);
        assert.isTrue(Option.isNone(yield* backend.read(SESSION_KEY)));
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("publishes the value that was stored, not the value offered", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        // The schema removes duplicate characters, so the stored value differs
        // from the offered value. Memory must hold what storage holds.
        const updating = yield* Effect.forkChild(
          storage.settings.update((current) => ({
            ...current,
            linkHintCharacters: "aabb",
          })),
          { startImmediately: true },
        );
        yield* storage.settings.flush;
        const stored = yield* Fiber.join(updating);
        assert.strictEqual(stored.linkHintCharacters, "aabb");

        const inMemory = yield* storage.settings.current;
        assert.strictEqual(inMemory.linkHintCharacters, "ab");
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("gives the current value first on the change stream", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        const seen = yield* Queue.unbounded<number>();
        yield* Effect.forkScoped(
          Stream.runForEach(
            storage.settings.changes,
            (settings) => Queue.offer(seen, settings.scrollStepSize),
          ),
        );

        assert.strictEqual(yield* Queue.take(seen), 60);

        const writing = yield* Effect.forkChild(
          storage.settings.write({
            ...defaultSettings(),
            scrollStepSize: 120,
          }),
          { startImmediately: true },
        );
        yield* storage.settings.flush;
        yield* Fiber.join(writing);
        assert.strictEqual(yield* Queue.take(seen), 120);
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("reads every group when the application starts", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        yield* backend.seed(
          SETTINGS_KEY,
          envelope(1, { ...defaultSettings(), scrollStepSize: 120 }),
        );
        yield* backend.seed(
          `${STORAGE_PREFIX}find-history`,
          envelope(1, { queries: ["needle"] }),
        );

        yield* storage.hydrateAll;
        assert.strictEqual(
          (yield* storage.settings.current).scrollStepSize,
          120,
        );
        assert.deepEqual(
          (yield* storage.findHistory.current).queries,
          ["needle"],
        );
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));
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
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
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
        assert.include(insideDispatch[0] ?? "", '"scrollStepSize":120');

        // The actor takes its own turn afterwards, and it finds nothing to do.
        const outcome = yield* advanceUntilDone(writing);
        assert.isTrue(Exit.isSuccess(outcome));
        assert.lengthOf(
          backend.writesNow(),
          1,
          "the value must not be written a second time",
        );
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("keeps the order of two writes to one key", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
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
        assert.include(writes[0] ?? "", '"scrollStepSize":90');
        assert.include(writes[1] ?? "", '"scrollStepSize":150');
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("leaves alone a value that the actor is already writing", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        yield* backend.holdWrites;
        const writing = yield* leavePending(storage, 120);

        // The actor takes the value out of the window and stops inside the
        // backend call. Nothing is owed to the exit path any more.
        const flushing = yield* Effect.forkChild(storage.settings.flush, {
          startImmediately: true,
        });
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
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("returns when the backend throws, and lets the actor try again", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        yield* backend.breakNextDirectWrite;
        const writing = yield* leavePending(storage, 120);

        // A throw here would be swallowed by the browser, and the rest of the
        // exit hook would never run.
        const thrown = yield* Effect.sync(() => {
          try {
            storage.flushAllUnsafe();
            return null;
          } catch (cause) {
            return String(cause);
          }
        });
        assert.isNull(thrown, "the pagehide handler must return");
        assert.deepEqual(backend.writesNow(), []);

        const issue = yield* firstIssue(storage);
        assert.isTrue(Option.isSome(issue));
        if (Option.isNone(issue)) return;
        assert.strictEqual(issue.value.reason, "backend");
        assert.strictEqual(issue.value.direction, "write");

        // The value is still pending, so the actor writes it on its own turn.
        const outcome = yield* advanceUntilDone(writing);
        assert.isTrue(Exit.isSuccess(outcome));
        assert.lengthOf(backend.writesNow(), 1);
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("continues after the first group direct write fails", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        const settingsWrite = yield* leavePending(storage, 120);
        const marksWrite = yield* Effect.forkChild(
          storage.marks.write({
            local: {
              "https://example.test/": {
                a: { scrollX: 1, scrollY: 2, savedAt: 3 },
              },
            },
            global: {},
          }),
          { startImmediately: true },
        );
        yield* yieldUntil(() =>
          storage.marks.currentUnsafe().local["https://example.test/"] !==
            undefined
        );
        yield* backend.breakNextDirectWrite;

        yield* Effect.sync(() => storage.flushAllUnsafe());

        const writes = backend.writesNow();
        assert.lengthOf(writes, 1);
        assert.include(writes[0] ?? "", '"a"');

        yield* advanceUntilDone(settingsWrite);
        yield* advanceUntilDone(marksWrite);
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

  it.effect("uses identical bytes after hydration on both write paths", () =>
    Effect.gen(function*() {
      const directBackend = yield* makeBackend;
      const directBytes = yield* Effect.gen(function*() {
        const storage = yield* Storage;
        yield* directBackend.seed(
          SETTINGS_KEY,
          envelope(0, { scrollStepSize: 120 }),
        );
        const migrated = yield* storage.settings.hydrate;
        assert.strictEqual(migrated.scrollStepSize, 120);

        yield* leavePending(storage, 90);
        yield* Effect.sync(() => storage.flushAllUnsafe());
        return directBackend.writesNow()[0] ?? "";
      }).pipe(
        Effect.provide(Storage.layer),
        Effect.provide(directBackend.layer),
      );

      const actorBackend = yield* makeBackend;
      const actorBytes = yield* Effect.gen(function*() {
        const storage = yield* Storage;
        yield* actorBackend.seed(
          SETTINGS_KEY,
          envelope(0, { scrollStepSize: 120 }),
        );
        const migrated = yield* storage.settings.hydrate;
        const writing = yield* Effect.forkChild(
          storage.settings.write({ ...migrated, scrollStepSize: 90 }),
          { startImmediately: true },
        );
        yield* storage.settings.flush;
        yield* Fiber.join(writing);
        return actorBackend.writesNow()[0] ?? "";
      }).pipe(
        Effect.provide(Storage.layer),
        Effect.provide(actorBackend.layer),
      );

      assert.strictEqual(directBytes, actorBytes);
      assert.include(directBytes, '"schemaVersion":1');
    }));

  it.effect("writes nothing when no group holds a value", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        yield* Effect.sync(() => storage.flushAllUnsafe());
        assert.deepEqual(backend.writesNow(), []);
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));
});
