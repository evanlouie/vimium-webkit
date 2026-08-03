/**
 * Persistence, as one serial actor per group.
 *
 * The earlier design used an epoch counter, a semaphore, an outstanding
 * counter and a committed counter to put reads, writes, resets and debounced
 * flushes in the correct order. Order is not a property that those primitives
 * give. Each of those counters was added after a race that the previous one did
 * not close.
 *
 * Each group now owns one fiber and one queue. The fiber takes one command and
 * runs it to completion before it takes the next. The order of effects is the
 * order of the queue, and nothing else can change it. A caller waits on a
 * `Deferred` that the fiber completes, so a debounced write still reports the
 * outcome of the write that reaches the backend.
 *
 * There is one path around the fiber, and it exists for one moment: the page
 * exit. `flushUnsafe` writes the held value with a direct call to the backend.
 * A `pagehide` handler gets one synchronous run. The Effect scheduler is a
 * macrotask in a page, so a value that waits for the fiber is lost. Read the
 * note above `flushUnsafe` before you use it.
 *
 * Storage is untrusted input. The user can edit it in the manager's interface,
 * an older build may have written it, and a newer build in another tab may have
 * written it. Every read is decoded against the group schema, and every failure
 * gives the defaults and one message on the issue stream.
 */

import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FiberHandle,
  Layer,
  Option,
  Queue,
  Result,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import type { GroupSpec } from "~/domain/Persisted.ts";
import {
  type FindHistory,
  findHistoryGroup,
  historyGroup,
  type HistoryIndex,
  type Marks,
  marksGroup,
  sessionGroup,
  type SessionState,
  type Settings,
  settingsGroup,
} from "~/domain/Persisted.ts";
import { decodeUnknown, describeSchemaError } from "./SchemaIo.ts";
import { KeyValueStore, STORAGE_PREFIX } from "./KeyValueStore.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const StorageFailureReason = Schema.Literals([
  /** The write was dropped before it reached the backend. */
  "cancelled",
  /** The backend failed: a manager error, a quota, or a removed permission. */
  "backend",
  /** The stored bytes were not JSON. */
  "malformed",
  /** The stored JSON did not match the schema, even after migration. */
  "invalid",
  /** A migration step failed. */
  "migration",
]);

export type StorageFailureReason = typeof StorageFailureReason.Type;

/**
 * The direction of travel.
 *
 * The same reasons occur on a read and on a write, and the user needs different
 * words for each. A failed read means that the defaults are now in use. A failed
 * write means that the change did not persist.
 */
export const StorageDirection = Schema.Literals(["read", "write"]);

export type StorageDirection = typeof StorageDirection.Type;

export class StorageError extends Schema.TaggedErrorClass<StorageError>()(
  "StorageError",
  {
    reason: StorageFailureReason,
    direction: StorageDirection,
    group: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// ---------------------------------------------------------------------------
// A group
// ---------------------------------------------------------------------------

export interface ValueGroup<A> {
  readonly name: string;

  /** The value in memory. The defaults until the first read completes. */
  readonly current: Effect.Effect<A>;

  /**
   * The value in memory, read synchronously.
   *
   * For the key path only, which must not suspend. Every other caller uses
   * `current`.
   */
  readonly currentUnsafe: () => A;

  /** The current value, and then every later value. */
  readonly changes: Stream.Stream<A>;

  /** Read the backend again. This never fails; it reports and uses defaults. */
  readonly hydrate: Effect.Effect<A>;

  /** Replace the value. It completes when the write reaches the backend. */
  readonly write: (value: A) => Effect.Effect<void, StorageError>;

  /** Read, change and write, as one indivisible step. */
  readonly update: (
    change: (current: A) => A,
  ) => Effect.Effect<A, StorageError>;

  /** Erase the stored value and go back to the defaults. */
  readonly reset: Effect.Effect<A, StorageError>;

  /** Write a value that is still inside its debounce window. */
  readonly flush: Effect.Effect<void, StorageError>;

  /**
   * Write the held value to the backend now, with no suspension.
   *
   * For the page exit only. Every other caller uses `flush`. Read the note
   * above the implementation before you call it.
   */
  readonly flushUnsafe: () => void;
}

// ---------------------------------------------------------------------------
// The commands that the group fiber runs
// ---------------------------------------------------------------------------

type Command<A> =
  | { readonly _tag: "Hydrate"; readonly reply: Deferred.Deferred<A> }
  | {
    readonly _tag: "Write";
    readonly value: A;
    readonly reply: Deferred.Deferred<void, StorageError>;
  }
  | {
    readonly _tag: "Update";
    readonly change: (current: A) => A;
    readonly reply: Deferred.Deferred<A, StorageError>;
  }
  | {
    readonly _tag: "Reset";
    readonly reply: Deferred.Deferred<A, StorageError>;
  }
  | {
    readonly _tag: "Flush";
    readonly reply: Option.Option<Deferred.Deferred<void, StorageError>>;
  }
  | { readonly _tag: "Remote"; readonly raw: Option.Option<string> };

interface Envelope {
  readonly schemaVersion: number;
  readonly data: unknown;
}

/**
 * The stored wrapper, checked by shape and not by schema.
 *
 * `data` is the group's own payload, and it is decoded separately after
 * migration. A schema here would either do that work twice, or make `data`
 * `unknown` in a schema that then says nothing.
 */
const isEnvelope = (value: unknown): value is Envelope =>
  typeof value === "object" && value !== null &&
  typeof (value as Record<string, unknown>)["schemaVersion"] === "number" &&
  "data" in value;

const describeCause = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "detail" in cause) {
    const detail: unknown = (cause as { readonly detail: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  return String(cause);
};

/**
 * Build one value group over the value store.
 *
 * It is exported for a module that must own a group of its own, and not share
 * it. `frames/Auth.ts` builds the group of the frame credential in that way,
 * so no feature can read that value through `Storage`. Every other group
 * belongs to `Storage` and is reached through the service.
 */
export const makeGroup = <A>(
  spec: GroupSpec<A>,
  kv: KeyValueStore["Service"],
  issues: Queue.Queue<StorageError>,
): Effect.Effect<ValueGroup<A>, never, Scope.Scope> =>
  Effect.gen(function*() {
    const key = `${STORAGE_PREFIX}${spec.name}`;
    const debounce = Duration.millis(spec.writeDebounceMs ?? 0);
    const debounced = Duration.toMillis(debounce) > 0;

    const value = yield* SubscriptionRef.make(spec.defaults());
    const mailbox = yield* Queue.unbounded<Command<A>>();

    // Everything below this line is touched by the group fiber only. One fiber
    // means that a plain variable is safe, and that nothing can interleave.
    let pending = Option.none<A>();
    let waiters: Array<Deferred.Deferred<void, StorageError>> = [];
    let readFailure: StorageError | null = null;

    /**
     * The fiber that closes the current debounce window.
     *
     * A handle, and not a plain fiber. Arming it again interrupts the fiber
     * that is already there, and the scope interrupts whatever is left. A
     * detached fiber would keep the page alive after the runtime closes, and a
     * scoped fiber for each write would add a finaliser for each write.
     */
    const timer = yield* FiberHandle.make<void, never>();

    const raise = (
      reason: StorageFailureReason,
      direction: StorageDirection,
      detail: string,
      cause?: unknown,
      report = true,
    ): StorageError => {
      const error = new StorageError({
        reason,
        direction,
        group: spec.name,
        detail: cause === undefined
          ? detail
          : `${detail}: ${describeCause(cause)}`,
        ...(cause === undefined ? {} : { cause }),
      });
      if (report) Queue.offerUnsafe(issues, error);
      return error;
    };

    // -- decoding ----------------------------------------------------------

    const runMigrations = (
      data: unknown,
      from: number,
    ): Option.Option<unknown> => {
      let current = data;
      const steps = (spec.migrations ?? [])
        .filter((step) => step.to > from)
        .toSorted((left, right) => left.to - right.to);
      for (const step of steps) {
        try {
          current = step.migrate(current);
        } catch (cause) {
          raise(
            "migration",
            "read",
            `migration to v${step.to} (${step.describe}) failed`,
            cause,
          );
          return Option.none();
        }
      }
      return Option.some(current);
    };

    const decode = (raw: Option.Option<string>): A => {
      if (Option.isNone(raw)) return spec.defaults();

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.value);
      } catch (cause) {
        raise("malformed", "read", "the stored value is not JSON", cause);
        return spec.defaults();
      }

      // Data from a 0.1 development build has no envelope. Treat it as v0.
      const envelope: Envelope = isEnvelope(parsed)
        ? parsed
        : { schemaVersion: 0, data: parsed };

      let data = envelope.data;
      if (envelope.schemaVersion < spec.schemaVersion) {
        const migrated = runMigrations(data, envelope.schemaVersion);
        if (Option.isNone(migrated)) return spec.defaults();
        data = migrated.value;
      } else if (envelope.schemaVersion > spec.schemaVersion) {
        // A newer build in another tab wrote this. Do not try to go backwards.
        // Use the defaults for this frame and leave the stored value alone.
        raise(
          "invalid",
          "read",
          `the stored schema version ${envelope.schemaVersion} is newer ` +
            `than this build's ${spec.schemaVersion}`,
        );
        return spec.defaults();
      }

      const decoded = decodeUnknown(spec.schema)(data);
      if (Result.isFailure(decoded)) {
        raise(
          "invalid",
          "read",
          "the stored value failed schema validation",
          describeSchemaError(decoded.failure),
        );
        return spec.defaults();
      }
      return decoded.success;
    };

    // -- the backend -------------------------------------------------------

    /**
     * The bytes for one value, or the failure that stops the write.
     *
     * The value is validated on the way out as well as on the way in. A bad
     * value is then caught where it was made, and not on the next page load. A
     * bad value that reached the disk would reset the group on the next read,
     * and it would take every other field with it.
     *
     * One function for the actor path and for the exit path. The two must give
     * the same bytes, and one function is the only way to be sure of that.
     * `report` is false on the exit path, so that one failure gives one
     * message: the actor writes the same value again and reports it there.
     */
    const encode = (
      next: A,
      report: boolean,
    ): Result.Result<string, StorageError> => {
      const validated = decodeUnknown(spec.schema)(next);
      if (Result.isFailure(validated)) {
        return Result.fail(raise(
          "invalid",
          "write",
          "refusing to persist a value that fails its own schema",
          describeSchemaError(validated.failure),
          report,
        ));
      }
      try {
        const envelope: Envelope = {
          schemaVersion: spec.schemaVersion,
          data: validated.success,
        };
        return Result.succeed(JSON.stringify(envelope));
      } catch (cause) {
        return Result.fail(raise(
          "malformed",
          "write",
          "the value cannot be serialised",
          cause,
          report,
        ));
      }
    };

    /** Write one value to the backend. */
    const commit = (next: A): Effect.Effect<void, StorageError> =>
      Effect.gen(function*() {
        const encoded = encode(next, true);
        if (Result.isFailure(encoded)) {
          return yield* encoded.failure;
        }

        // Not interruptible. A promise inside the backend keeps running after
        // its fiber is interrupted, so an interrupted `set` could still land
        // after a later `remove`.
        yield* Effect.uninterruptible(
          Effect.mapError(
            kv.set(key, encoded.success),
            (cause) => raise("backend", "write", cause.detail, cause),
          ),
        );
        readFailure = null;
      });

    /**
     * Write the held value to the backend now, with no suspension.
     *
     * This is the exit path, and it exists because the actor path cannot save
     * a dying page. A caller of `flush` waits on a `Deferred`, and the actor
     * fiber resumes through the Effect scheduler. That scheduler is
     * `setTimeout(f, 0)` in a page, and a macrotask that starts inside
     * `pagehide` never runs. `GM_setValue` and `localStorage.setItem` are both
     * synchronous, so the last hop can be a direct call instead.
     *
     * Four rules hold this path together:
     *
     * 1. **One value goes, and it is the newest one.** `pending` holds the
     *    last write of the debounce window. The order of two writes to one key
     *    is therefore the order that the backend sees.
     * 2. **Nothing is written twice.** `pending` is cleared after the write, so
     *    the flush that the actor runs later finds nothing to do.
     * 3. **A value that the actor is writing is left alone.** The actor clears
     *    `pending` before it commits, and it runs one command at a time. An
     *    empty `pending` therefore means that nothing is owed.
     * 4. **It never throws.** The `pagehide` handler must return, and a browser
     *    swallows a throw from a listener. A failed write keeps `pending`, so
     *    the actor writes it again if this page lives on.
     *
     * A command that is still in the mailbox is not covered. Only the actor may
     * run one, and this path must not take its turn.
     */
    const flushUnsafe = (): void => {
      const held = pending;
      if (Option.isNone(held)) return;
      try {
        const encoded = encode(held.value, false);
        // The value cannot be written at all. The actor reports it, and it
        // fails the callers that wait for this write.
        if (Result.isFailure(encoded)) return;
        kv.setUnsafe(key, encoded.success);
        pending = Option.none();
        readFailure = null;
      } catch (cause) {
        // The value stays pending, so the actor tries again. A second message
        // therefore means a second failed attempt, and not one failure twice.
        raise("backend", "write", "the direct write failed", cause);
      }
    };

    const publish = (next: A): Effect.Effect<void> =>
      SubscriptionRef.set(value, next);

    const cancelTimer = FiberHandle.clear(timer);

    const settleWaiters = (
      outcome: Exit.Exit<void, StorageError>,
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        const waiting = waiters;
        waiters = [];
        return Effect.forEach(
          waiting,
          (reply) => Deferred.done(reply, outcome),
          { discard: true },
        );
      });

    /** Write whatever is inside the debounce window, if anything is. */
    const commitPending = Effect.gen(function*() {
      yield* cancelTimer;
      const held = pending;
      pending = Option.none();
      if (Option.isNone(held)) {
        yield* settleWaiters(Exit.void);
        return Exit.void as Exit.Exit<void, StorageError>;
      }
      const outcome = yield* Effect.exit(commit(held.value));
      yield* settleWaiters(outcome);
      return outcome;
    });

    // -- the command loop --------------------------------------------------

    const armTimer = FiberHandle.run(
      timer,
      Effect.andThen(
        Effect.sleep(debounce),
        Effect.sync(() => {
          Queue.offerUnsafe(mailbox, { _tag: "Flush", reply: Option.none() });
        }),
      ),
    );

    const applyWrite = (
      next: A,
      reply: Deferred.Deferred<void, StorageError>,
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        // Validated before it is published, and the *decoded* value is what
        // gets published. A schema repairs a field rather than rejecting it, so
        // the two differ. Publishing the raw value would leave memory holding a
        // value that storage does not have, and the setting would appear to
        // revert on the next page load.
        const validated = decodeUnknown(spec.schema)(next);
        if (Result.isFailure(validated)) {
          yield* Deferred.fail(
            reply,
            raise(
              "invalid",
              "write",
              "refusing to persist a value that fails its own schema",
              describeSchemaError(validated.failure),
            ),
          );
          return;
        }
        const accepted = validated.success;
        yield* publish(accepted);

        if (!debounced) {
          yield* Deferred.done(reply, yield* Effect.exit(commit(accepted)));
          return;
        }
        pending = Option.some(accepted);
        waiters.push(reply);
        yield* armTimer;
      });

    const handle = (command: Command<A>): Effect.Effect<void> =>
      Effect.gen(function*() {
        switch (command._tag) {
          case "Hydrate": {
            // A value still inside its debounce window is newer than the disk.
            // Write it first, or the read brings back the value that it is
            // about to replace.
            yield* commitPending;
            const raw = yield* Effect.exit(kv.get(key));
            if (Exit.isFailure(raw)) {
              // Do not publish the defaults after a transport failure. They are
              // an answer for this caller, not the state of the world. An
              // unrelated update must not write them over good data later.
              readFailure = raise(
                "backend",
                "read",
                "could not read the stored value",
                raw.cause,
              );
              yield* Deferred.succeed(
                command.reply,
                yield* SubscriptionRef.get(value),
              );
              return;
            }
            readFailure = null;
            const decoded = decode(raw.value);
            yield* publish(decoded);
            yield* Deferred.succeed(command.reply, decoded);
            return;
          }

          case "Write": {
            yield* applyWrite(command.value, command.reply);
            return;
          }

          case "Update": {
            if (readFailure !== null) {
              // The defaults are not a safe base for a read, change and write.
              // Refuse until a later read succeeds, or until the caller
              // replaces the whole value with `write`.
              yield* Deferred.fail(command.reply, readFailure);
              return;
            }
            const next = command.change(yield* SubscriptionRef.get(value));
            const inner = yield* Deferred.make<void, StorageError>();
            yield* applyWrite(next, inner);
            yield* Effect.forkDetach(
              Effect.matchEffect(Deferred.await(inner), {
                onFailure: (error) => Deferred.fail(command.reply, error),
                onSuccess: () => Deferred.succeed(command.reply, next),
              }),
            );
            return;
          }

          case "Flush": {
            const outcome = yield* commitPending;
            if (Option.isSome(command.reply)) {
              yield* Deferred.done(command.reply.value, outcome);
            }
            return;
          }

          case "Reset": {
            yield* cancelTimer;
            pending = Option.none();
            // The waiting writes were deliberately dropped, and they never
            // reached storage. `write` promises to complete when they do, so
            // they must be failed, not succeeded. The caller asked for this, so
            // it is not reported beside the message that caused it.
            yield* settleWaiters(
              Exit.fail(
                raise(
                  "cancelled",
                  "write",
                  "the write was replaced by a reset",
                  undefined,
                  false,
                ),
              ),
            );
            const defaults = spec.defaults();
            yield* publish(defaults);
            const removed = yield* Effect.exit(
              Effect.uninterruptible(
                Effect.mapError(
                  kv.remove(key),
                  (cause) => raise("backend", "write", cause.detail, cause),
                ),
              ),
            );
            if (Exit.isFailure(removed)) {
              yield* Deferred.failCause(command.reply, removed.cause);
              return;
            }
            readFailure = null;
            yield* Deferred.succeed(command.reply, defaults);
            return;
          }

          case "Remote": {
            // Local intent wins while it is waiting. Another tab did commit,
            // but replacing the value that this user has just chosen would be
            // the greater surprise. Our own commit becomes the last write.
            if (Option.isSome(pending)) return;
            yield* publish(decode(command.raw));
            return;
          }
        }
      });

    yield* Effect.forkScoped(
      Effect.forever(Effect.flatMap(Queue.take(mailbox), handle)),
    );

    // Another tab's writes enter through the same queue, so they take their
    // turn like everything else.
    yield* Effect.forkScoped(
      Stream.runForEach(
        kv.changes(key),
        (raw) => Queue.offer(mailbox, { _tag: "Remote", raw }),
      ),
    );

    const ask = <Ok, Err>(
      make: (reply: Deferred.Deferred<Ok, Err>) => Command<A>,
    ): Effect.Effect<Ok, Err> =>
      Effect.gen(function*() {
        const reply = yield* Deferred.make<Ok, Err>();
        yield* Queue.offer(mailbox, make(reply));
        return yield* Deferred.await(reply);
      });

    return {
      name: spec.name,
      current: SubscriptionRef.get(value),
      currentUnsafe: () => SubscriptionRef.getUnsafe(value),
      changes: SubscriptionRef.changes(value),
      hydrate: ask<A, never>((reply) => ({ _tag: "Hydrate", reply })),
      write: (next) =>
        ask<void, StorageError>((reply) => ({
          _tag: "Write",
          value: next,
          reply,
        })),
      update: (change) =>
        ask<A, StorageError>((reply) => ({ _tag: "Update", change, reply })),
      reset: ask<A, StorageError>((reply) => ({ _tag: "Reset", reply })),
      flush: ask<void, StorageError>((reply) => ({
        _tag: "Flush",
        reply: Option.some(reply),
      })),
      flushUnsafe,
    };
  });

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Storage extends Context.Service<Storage, {
  readonly settings: ValueGroup<Settings>;
  readonly marks: ValueGroup<Marks>;
  readonly findHistory: ValueGroup<FindHistory>;
  readonly history: ValueGroup<HistoryIndex>;
  readonly session: ValueGroup<SessionState>;

  /**
   * Every read failure and every write failure, in order.
   *
   * A queue and not a broadcast. The HUD does not exist when the application
   * first reads storage, and a message that nobody heard is the failure that
   * this stream exists to prevent.
   */
  readonly issues: Stream.Stream<StorageError>;

  /** Read every group. This is the only correct way to start. */
  readonly hydrateAll: Effect.Effect<void>;

  /** Write every value that is still inside a debounce window. */
  readonly flushAll: Effect.Effect<void>;

  /**
   * Write every held value to the backend now, with no suspension.
   *
   * For the page exit only. A `pagehide` handler gets one synchronous run, and
   * the Effect scheduler is a macrotask in a page. A write that waits for a
   * fiber therefore never reaches the backend. This call never throws, and a
   * failed write becomes one message on the issue stream.
   */
  readonly flushAllUnsafe: () => void;
}>()("vimium/platform/Storage") {
  static readonly layer: Layer.Layer<Storage, never, KeyValueStore> = Layer
    .effect(
      Storage,
      Effect.gen(function*() {
        const kv = yield* KeyValueStore;
        const issues = yield* Queue.unbounded<StorageError>();

        const settings = yield* makeGroup(settingsGroup, kv, issues);
        const marks = yield* makeGroup(marksGroup, kv, issues);
        const findHistory = yield* makeGroup(findHistoryGroup, kv, issues);
        const history = yield* makeGroup(historyGroup, kv, issues);
        const session = yield* makeGroup(sessionGroup, kv, issues);

        const groups: ReadonlyArray<ValueGroup<unknown>> = [
          settings,
          marks,
          findHistory,
          history,
          session,
          // Every group, and never a subset. `update` works against the value
          // in memory, so a group that was never read has only the defaults —
          // and the first write to it would replace the user's whole stored
          // value with the defaults plus one change.
        ] as ReadonlyArray<ValueGroup<unknown>>;

        return Storage.of({
          settings,
          marks,
          findHistory,
          history,
          session,
          issues: Stream.fromQueue(issues),
          hydrateAll: Effect.forEach(groups, (group) => group.hydrate, {
            concurrency: "unbounded",
            discard: true,
          }),
          flushAll: Effect.forEach(
            groups,
            (group) => Effect.ignore(group.flush),
            { concurrency: "unbounded", discard: true },
          ),
          flushAllUnsafe: () => {
            for (const group of groups) group.flushUnsafe();
          },
        });
      }),
    );
}
