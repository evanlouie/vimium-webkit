/**
 * Namespaced, cached, schema-validated value store.
 *
 * Storage is shared across script versions, across frames, and is directly
 * editable in every manager's UI. It is therefore *untrusted input*: every read
 * is validated against its schema and every failure has a defined fallback.
 * Nothing in this module may throw during boot (IMPLEMENTATION_PLAN.md §6.11).
 *
 * Values are grouped (`settings`, `mappings`, `marks`, ...) rather than stored
 * as one blob, so that a corrupt group can be reset independently and so that a
 * mark write does not rewrite the whole settings object.
 */

import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Result,
  Schema,
  Semaphore,
} from "effect";
import type { ValueBackend } from "./gm.ts";
import { decodeUnknownResult, describeDecodeError } from "./schema-io.ts";

export const STORAGE_PREFIX = "vimium-webkit:";

export const StorageFailureReason = Schema.Literals([
  /** The write was abandoned before it reached the backend. */
  "cancelled",
  /** The backend itself failed (manager error, quota, revoked permission). */
  "backend",
  /** Stored bytes were not JSON. */
  "malformed",
  /** Stored JSON did not match the schema, even after migration. */
  "invalid",
  /** A migration step threw. */
  "migration",
]);

export type StorageFailureReason = typeof StorageFailureReason.Type;

/**
 * Which way the value was travelling when it went wrong.
 *
 * The same reasons arise reading and writing, and the two need different words
 * to the user: a failed read means the defaults are now in force, a failed
 * write means their change did not persist. One sentence for both said
 * "could not be read; using defaults" over a rejected save.
 */
export const StorageDirection = Schema.Literals(["read", "write"]);

export type StorageDirection = typeof StorageDirection.Type;

export class StorageError
  extends Schema.TaggedErrorClass<StorageError>()("StorageError", {
    reason: StorageFailureReason,
    direction: StorageDirection,
    group: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  })
{}

/** A single ordered, idempotent transformation of persisted data. */
export interface Migration {
  /** The `schemaVersion` this step produces. */
  readonly to: number;
  readonly describe: string;
  migrate(data: unknown): unknown;
}

export interface GroupSpec<T> {
  readonly name: string;
  readonly schema: Schema.Codec<T, unknown>;
  readonly defaults: () => T;
  readonly schemaVersion: number;
  readonly migrations?: readonly Migration[];
  /** Coalesce rapid writes. `0` writes through immediately. */
  readonly writeDebounceMs?: number;
}

interface Envelope {
  readonly schemaVersion: number;
  readonly data: unknown;
}

/**
 * The stored wrapper, checked structurally rather than by schema.
 *
 * Deliberately not a `Schema.Struct`: `data` is the group's own payload and is
 * validated separately after migration, so decoding it here would either
 * duplicate that work or force `data` to be `unknown` in a schema that then
 * asserts nothing useful.
 */
const isEnvelope = (value: unknown): value is Envelope =>
  typeof value === "object" && value !== null &&
  typeof (value as Record<string, unknown>)["schemaVersion"] === "number" &&
  "data" in value;

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export type IssueListener = (issue: StorageError) => void;

/**
 * The per-frame façade over a `ValueBackend`.
 *
 * Reads are cached in memory after the first hydration: on quoid every read is
 * a promise round-trip to the extension process, and the key-dispatch hot path
 * cannot suspend.
 */
export class ValueStore {
  readonly #backend: ValueBackend;
  readonly #issueListeners = new Set<IssueListener>();
  readonly #groups: ValueGroup<unknown>[] = [];

  constructor(backend: ValueBackend) {
    this.#backend = backend;
  }

  get backendKind(): ValueBackend["kind"] {
    return this.#backend.kind;
  }

  get supportsWatch(): boolean {
    return this.#backend.watch !== null;
  }

  /** Every group created from this store, in creation order. */
  get groups(): readonly ValueGroup<unknown>[] {
    return this.#groups;
  }

  onIssue(listener: IssueListener): () => void {
    this.#issueListeners.add(listener);
    return () => this.#issueListeners.delete(listener);
  }

  report(issue: StorageError): void {
    for (const listener of this.#issueListeners) {
      try {
        listener(issue);
      } catch {
        // A broken reporter must not take down a storage read.
      }
    }
  }

  group<T>(spec: GroupSpec<T>): ValueGroup<T> {
    const created = new ValueGroup<T>(this, this.#backend, spec);
    this.#groups.push(created as ValueGroup<unknown>);
    return created;
  }

  /** Hydrate every registered group. The only correct way to boot. */
  hydrateAll(): Effect.Effect<readonly unknown[]> {
    return Effect.forEach(this.#groups, (group) => group.hydrate(), {
      concurrency: "unbounded",
    });
  }

  /**
   * Flush every group's pending write.
   *
   * Wired to `pagehide` and `visibilitychange`, where the alternative is losing
   * whatever is still inside a debounce window.
   */
  flushAll(): Effect.Effect<void> {
    return Effect.forEach(
      this.#groups,
      (group) => Effect.ignore(group.flush()),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );
  }
}

export class ValueGroup<T> {
  readonly #store: ValueStore;
  readonly #backend: ValueBackend;
  readonly #spec: GroupSpec<T>;
  readonly #key: string;
  readonly #listeners = new Set<(value: T) => void>();

  #cached: T | undefined;
  /**
   * The hydration currently in flight, if any.
   *
   * Concurrent callers share one read; a *later* call still re-reads, which is
   * what `lifecycle.ts` depends on when it re-hydrates on `visibilitychange`.
   * A permanent memo would answer that second call from the first read's cache
   * and the tab would never see another tab's write.
   */
  #inFlight: Deferred.Deferred<T> | null = null;
  #pendingWrite: T | undefined;
  #unwatch: (() => void) | null = null;

  /**
   * The sleeping fiber that will close the current debounce window.
   *
   * A superseding write interrupts it and forks another, which is the same
   * shape as the `clearTimeout`/`setTimeout` pair it replaces — except that
   * interruption is now the runtime's job, so a fiber cannot be orphaned.
   */
  #writeFiber: Fiber.Fiber<void, never> | null = null;

  /**
   * The outcome every debounced `write()` since the last flush is waiting on.
   *
   * One `Deferred` shared by all of them, because a superseded write must
   * *settle* — adopting its successor's outcome — rather than being dropped.
   * Cancelling the timer used to orphan the previous `resolve` outright, so a
   * `write()` that lost a race never completed at all.
   */
  #settlement: Deferred.Deferred<void, StorageError> | null = null;

  /**
   * One permit, held for the whole of every backend operation.
   *
   * A *handle* on the in-flight flush was not enough, and it took two rounds
   * of review to see why: it guarded a critical section that could be entered
   * twice. Two flushes each published their own handle, the first to finish
   * cleared it, and `reset()` then read an idle group and issued `remove`
   * alongside a live `set` — so the erased data came back. Two `set` calls
   * could also resolve out of order, leaving the older value on disk under a
   * cache holding the newer one.
   *
   * A lock rather than a handle makes all of that unrepresentable: `set`,
   * `remove` and the read behind `hydrate()` are serialised per group, so
   * whoever arrives second sees the finished state of whoever was first.
   */
  readonly #backendLock = Semaphore.makeUnsafe(1);

  constructor(store: ValueStore, backend: ValueBackend, spec: GroupSpec<T>) {
    this.#store = store;
    this.#backend = backend;
    this.#spec = spec;
    this.#key = `${STORAGE_PREFIX}${spec.name}`;
  }

  get name(): string {
    return this.#spec.name;
  }

  /**
   * The last hydrated value, or `undefined` before the first read completes.
   * Synchronous by design — the key-dispatch path must never suspend.
   */
  peek(): T | undefined {
    return this.#cached;
  }

  /** The hydrated value, or the schema defaults if hydration has not run. */
  current(): T {
    return this.#cached ?? this.#spec.defaults();
  }

  /**
   * Read, validate, and migrate. Never fails: any problem is reported to the
   * store's issue listeners and the defaults are returned in its place.
   */
  hydrate(): Effect.Effect<T> {
    return Effect.gen({ self: this }, function*() {
      const existing = this.#inFlight;
      if (existing !== null) return yield* Deferred.await(existing);

      const deferred = yield* Deferred.make<T>();
      this.#inFlight = deferred;
      // `onExit` rather than a plain completion, so an interrupted hydration
      // still releases anyone waiting on it instead of parking them for good.
      return yield* Effect.onExit(
        this.#hydrateOnce(),
        (exit) =>
          Effect.sync(() => {
            this.#inFlight = null;
          }).pipe(Effect.andThen(
            // Joiners get a value even when the *first* caller was
            // interrupted. Forwarding that exit would interrupt callers that
            // were perfectly healthy, and `hydrate()` promises it cannot fail.
            Exit.isSuccess(exit)
              ? Deferred.done(deferred, exit)
              : Deferred.succeed(deferred, this.current()),
          )),
      );
    });
  }

  #hydrateOnce(): Effect.Effect<T> {
    return Effect.gen({ self: this }, function*() {
      // A debounced write still sitting in its window holds the newest value.
      // Reading around it and adopting what is on disk would resurrect exactly
      // the value the pending write is about to replace.
      if (this.#pendingWrite !== undefined) yield* Effect.ignore(this.flush());
      return yield* this.#doHydrate();
    });
  }

  #doHydrate(): Effect.Effect<T> {
    // Under the lock too: a read that overtakes a live write caches the value
    // that write is replacing, and nothing ever refreshes it.
    return this.#backendLock.withPermits(1)(this.#backend.get(this.#key)).pipe(
      Effect.map((raw) =>
        this.#adopt(this.#decode(Option.getOrUndefined(raw)))
      ),
      Effect.catch((cause) =>
        Effect.sync(() => {
          this.#issue("backend", cause.detail, cause, "read");
          return this.#adopt(this.#spec.defaults());
        })
      ),
    );
  }

  #decode(raw: string | undefined): T {
    if (raw === undefined) return this.#spec.defaults();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      this.#issue("malformed", "stored value is not valid JSON", cause, "read");
      return this.#spec.defaults();
    }

    const envelope: Envelope = isEnvelope(parsed)
      // Pre-envelope data (v0.1 dev builds) is treated as version 0.
      ? parsed
      : { schemaVersion: 0, data: parsed };

    let data = envelope.data;
    if (envelope.schemaVersion < this.#spec.schemaVersion) {
      const migrated = this.#runMigrations(data, envelope.schemaVersion);
      if (!migrated.ok) return this.#spec.defaults();
      data = migrated.data;
    } else if (envelope.schemaVersion > this.#spec.schemaVersion) {
      // Written by a newer build in another tab. Do not attempt to downgrade;
      // use defaults for this session and leave the stored value untouched.
      this.#issue(
        "invalid",
        `stored schema version ${envelope.schemaVersion} is newer than ` +
          `this build's ${this.#spec.schemaVersion}`,
        undefined,
        "read",
      );
      return this.#spec.defaults();
    }

    const result = decodeUnknownResult(this.#spec.schema)(data);
    if (Result.isFailure(result)) {
      this.#issue(
        "invalid",
        "stored value failed schema validation",
        describeDecodeError(result.failure),
        "read",
      );
      return this.#spec.defaults();
    }
    return result.success;
  }

  /**
   * Run every migration step newer than `from`, in order.
   *
   * The result is a tagged union rather than `unknown | undefined`, which is
   * just `unknown`: the failure sentinel was unrepresentable in the type, so
   * nothing stopped a migration that legitimately produced `undefined` from
   * being read as a failure.
   */
  #runMigrations(
    data: unknown,
    from: number,
  ): { readonly ok: true; readonly data: unknown } | { readonly ok: false } {
    let current = data;
    const steps = (this.#spec.migrations ?? [])
      .filter((step) => step.to > from)
      .toSorted((a, b) => a.to - b.to);
    for (const step of steps) {
      try {
        current = step.migrate(current);
      } catch (cause) {
        this.#issue(
          "migration",
          `migration to v${step.to} (${step.describe}) failed`,
          cause,
          "read",
        );
        return { ok: false };
      }
    }
    return { ok: true, data: current };
  }

  #adopt(value: T): T {
    this.#cached = value;
    for (const listener of this.#listeners) {
      try {
        listener(value);
      } catch {
        // Ignored: a broken subscriber must not poison hydration.
      }
    }
    return value;
  }

  /**
   * Replace the value. Completes once the write actually reaches the backend.
   *
   * The debounced path used to report success when the *timer* fired, discarding
   * the flush that followed — so the error channel could never carry a failure
   * in production, and error handling built on it was provably unreachable.
   * Every group here debounces, so that was every group.
   */
  write(value: T): Effect.Effect<void, StorageError> {
    return Effect.gen({ self: this }, function*() {
      this.#cached = value;
      const debounce = this.#spec.writeDebounceMs ?? 0;
      if (debounce <= 0) return yield* this.#flushValue(value);

      this.#pendingWrite = value;
      if (this.#writeFiber !== null) yield* Fiber.interrupt(this.#writeFiber);

      // Shared: everyone waiting on this debounce window gets the outcome of
      // the flush that closes it, whether or not their own value is written.
      this.#settlement ??= yield* Deferred.make<void, StorageError>();
      const settlement = this.#settlement;

      this.#writeFiber = yield* Effect.forkDetach(
        Effect.sleep(Duration.millis(debounce)).pipe(
          // Drop the handle *before* flushing. `flush()` interrupts whatever
          // `#writeFiber` names, and by this point that is this fiber — so
          // leaving it set makes the flush interrupt itself and nobody ever
          // completes the deferred.
          Effect.andThen(Effect.sync(() => {
            this.#writeFiber = null;
          })),
          Effect.andThen(Effect.ignore(this.flush())),
        ),
      );

      return yield* Deferred.await(settlement);
    });
  }

  /**
   * Write any pending value now.
   *
   * Wired to `pagehide` and `visibilitychange`: marks debounce 100 ms, settings
   * 250 ms and the history index 2 s, so without this every one of them is lost
   * on a navigation that happens inside its own window.
   */
  flush(): Effect.Effect<void, StorageError> {
    return Effect.gen({ self: this }, function*() {
      yield* this.#interruptWriteFiber();

      const pending = this.#pendingWrite;
      const settlement = this.#settlement;
      this.#pendingWrite = undefined;
      this.#settlement = null;

      if (pending === undefined) {
        if (settlement !== null) yield* Deferred.succeed(settlement, undefined);
        return;
      }

      // `onExit`, not the success path: an interruption between here and the
      // completion would otherwise leave the deferred unfulfilled and park
      // every fiber waiting on it for the life of the frame.
      // `onExit` on the raw effect, before `Effect.result` — which turns a
      // failure into a *successful* Result and would hand every waiter a
      // success. Doing it here also covers interruption, which would otherwise
      // leave the deferred unfulfilled and park its waiters for the life of
      // the frame.
      const outcome = yield* this.#flushValue(pending).pipe(
        Effect.onExit((exit) =>
          settlement === null
            ? Effect.void
            // An interrupt is not this caller's failure. Forwarding it would
            // kill a `write()` that was merely parked, and an interrupt slips
            // past every `Effect.catch` the caller wrote — so they would
            // neither succeed nor be told. The value may well have reached
            // storage: `Effect.promise` cannot be interrupted once entered, so
            // the wording claims only that we stopped waiting.
            : Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
            ? Deferred.fail(
              settlement,
              this.#issue(
                "cancelled",
                "the write was interrupted, so it may not have been saved",
                undefined,
                "write",
                { report: false },
              ),
            )
            : Deferred.done(settlement, exit)
        ),
        Effect.result,
      );
      if (Result.isFailure(outcome)) return yield* Effect.fail(outcome.failure);
    });
  }

  /** Stop the sleeping debounce fiber, if there is one. */
  #interruptWriteFiber(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function*() {
      if (this.#writeFiber === null) return;
      const fiber = this.#writeFiber;
      this.#writeFiber = null;
      yield* Fiber.interrupt(fiber);
    });
  }

  /**
   * Drop any pending debounced write and release whoever is waiting on it.
   *
   * Settled rather than abandoned: a `write()` parked on the shared `Deferred`
   * would otherwise wait for a flush that is never going to happen.
   */
  #cancelPendingWrite(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function*() {
      yield* this.#interruptWriteFiber();
      this.#pendingWrite = undefined;
      const settlement = this.#settlement;
      this.#settlement = null;
      // Failure, not success: the value was deliberately discarded and never
      // reached storage. `write()` promises to complete when it does.
      if (settlement !== null) {
        yield* Deferred.fail(
          settlement,
          this.#issue(
            "cancelled",
            "the write was superseded by a reset",
            undefined,
            "write",
          ),
        );
      }
    });
  }

  #flushValue(value: T): Effect.Effect<void, StorageError> {
    return Effect.suspend(() => {
      // Validated on the way out as well as on the way in, so a bad value is
      // caught where it was produced rather than on the next load — where it
      // would reset the group and take every other field with it.
      const validated = decodeUnknownResult(this.#spec.schema)(value);
      if (Result.isFailure(validated)) {
        return Effect.fail(this.#issue(
          "invalid",
          "refusing to persist a value that fails its own schema",
          describeDecodeError(validated.failure),
          "write",
        ));
      }

      let encoded: string;
      try {
        const envelope: Envelope = {
          schemaVersion: this.#spec.schemaVersion,
          data: validated.success,
        };
        encoded = JSON.stringify(envelope);
      } catch (cause) {
        return Effect.fail(
          this.#issue("malformed", "value is not serialisable", cause, "write"),
        );
      }

      return this.#backendLock.withPermits(1)(
        Effect.mapError(
          this.#backend.set(this.#key, encoded),
          (cause) => this.#issue("backend", cause.detail, cause, "write"),
        ),
      );
    });
  }

  /** Read-modify-write against the cached value. */
  update(mutate: (current: T) => T): Effect.Effect<T, StorageError> {
    return Effect.suspend(() => {
      const next = mutate(this.current());
      return Effect.as(this.write(next), next);
    });
  }

  /** Delete the persisted value and revert to defaults in memory. */
  reset(): Effect.Effect<T, StorageError> {
    return Effect.gen({ self: this }, function*() {
      // Cancel the debounce first. Without this the sleeping fiber wakes after
      // the key has been removed and writes the pre-reset value straight back:
      // `:clear-history` erased the index, said so, and up to two seconds later
      // the visit still inside the debounce window reappeared on disk.
      yield* this.#cancelPendingWrite();

      const defaults = this.#spec.defaults();
      this.#adopt(defaults);
      return yield* this.#backendLock.withPermits(1)(
        this.#backend.remove(this.#key).pipe(
          Effect.mapError((cause) =>
            this.#issue("backend", cause.detail, cause, "write")
          ),
          Effect.as(defaults),
        ),
      );
    });
  }

  /**
   * Subscribe to value changes, including cross-tab changes where the manager
   * supports them (`GM_addValueChangeListener`; Violentmonkey and Tampermonkey
   * only). On quoid and Stay the portable substitute is `lifecycle.ts`
   * re-hydrating on `visibilitychange`.
   */
  subscribe(listener: (value: T) => void): () => void {
    this.#listeners.add(listener);
    this.#ensureWatching();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#unwatch?.();
        this.#unwatch = null;
      }
    };
  }

  #ensureWatching(): void {
    if (this.#unwatch !== null || this.#backend.watch === null) return;
    this.#unwatch = this.#backend.watch(this.#key, (raw) => {
      this.#adopt(this.#decode(raw));
    });
  }

  #issue(
    reason: StorageFailureReason,
    detail: string,
    cause: unknown,
    direction: StorageDirection,
    // A discard the caller asked for is not an issue anybody needs to see. It
    // still reaches the `write()` that was waiting; it just does not raise a
    // HUD error beside the "erased" message that caused it.
    options: { readonly report: boolean } = { report: true },
  ): StorageError {
    const issue = new StorageError({
      reason,
      direction,
      group: this.#spec.name,
      detail: cause === undefined
        ? detail
        : `${detail}: ${describeCause(cause)}`,
      ...(cause === undefined ? {} : { cause }),
    });
    if (options.report) this.#store.report(issue);
    return issue;
  }
}
