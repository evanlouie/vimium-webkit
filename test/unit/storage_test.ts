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
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
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
  /** Make every later read fail with a transport error. */
  readonly breakReads: Effect.Effect<void>;
}

const makeBackend: Effect.Effect<Backend> = Effect.gen(function*() {
  const map = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const writes = yield* Ref.make<readonly string[]>([]);
  const broken = yield* Ref.make(false);

  const put = (key: string, value: string): Effect.Effect<void> =>
    Ref.update(map, (current) => new Map(current).set(key, value));

  const service = KeyValueStore.of({
    kind: "memory",
    durable: false,
    watchable: false,
    managerPrivate: false,
    get: (key) =>
      Effect.flatMap(Ref.get(broken), (isBroken) =>
        isBroken
          ? Effect.fail(
            new GmError({
              reason: "failed",
              api: "test.get",
              detail: "the backend is unavailable",
            }),
          )
          : Effect.map(
            Ref.get(map),
            (current) => Option.fromNullishOr(current.get(key) ?? null),
          )),
    set: (key, value) =>
      Effect.andThen(
        put(key, value),
        Ref.update(writes, (current) => [...current, value]),
      ),
    remove: (key) =>
      Ref.update(map, (current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      }),
    changes: () => Stream.empty,
  });

  return {
    layer: Layer.succeed(KeyValueStore, service),
    seed: put,
    read: (key) =>
      Effect.map(
        Ref.get(map),
        (current) => Option.fromNullishOr(current.get(key) ?? null),
      ),
    writes: Ref.get(writes),
    breakReads: Ref.set(broken, true),
  };
});

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

/** The first issue that storage reports, without waiting for a second. */
const firstIssue = (
  storage: Storage["Service"],
): Effect.Effect<Option.Option<StorageError>> =>
  Effect.map(
    Stream.runCollect(Stream.take(storage.issues, 1)),
    (issues) => Option.fromNullishOr(issues[0] ?? null),
  );

/** The first notice that storage gives, without waiting for a second. */
const firstNotice = (
  storage: Storage["Service"],
): Effect.Effect<Option.Option<string>> =>
  Effect.map(
    Stream.runCollect(Stream.take(storage.notices, 1)),
    (notices) => Option.fromNullishOr(notices[0] ?? null),
  );

describe("Storage", () => {
  it.effect("tells the user about a stored alphabet that it repaired", () =>
    Effect.gen(function*() {
      const backend = yield* makeBackend;

      yield* Effect.gen(function*() {
        const storage = yield* Storage;
        // A German user stored this before the hint character rule changed.
        yield* backend.seed(
          SETTINGS_KEY,
          envelope(1, {
            ...defaultSettings(),
            linkHintCharacters: "asdfghjkl\u00df",
          }),
        );

        const collecting = yield* Effect.forkChild(firstNotice(storage), {
          startImmediately: true,
        });
        const value = yield* storage.settings.hydrate;
        // The letters of the user survive. Only the sharp s is gone.
        assert.strictEqual(value.linkHintCharacters, "asdfghjkl");

        const notice = yield* Fiber.join(collecting);
        assert.isTrue(Option.isSome(notice));
        if (Option.isNone(notice)) return;
        assert.include(notice.value, "Link hint characters");
        assert.include(notice.value, "U+00DF");
      }).pipe(Effect.provide(Storage.layer), Effect.provide(backend.layer));
    }));

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
          acknowledged: ["one"],
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
        // The store repairs a bad field, so the stored value differs from the
        // value that was offered. Memory must hold what storage holds.
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

        // The repair keeps the letters that the user chose, and drops the
        // repeats only.
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
