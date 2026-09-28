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
 * exit. `flushUnsafe` writes a held value only when the backend is synchronous.
 * A promise-backed manager does not use the debounce. Its actor starts each
 * accepted write while the page is alive.
 *
 * Storage is untrusted input. The user can edit it in the manager's interface,
 * an older build may have written it, and a newer build in another tab may have
 * written it. Every read is decoded against the group schema, and every failure
 * gives the defaults and one message on the issue stream.
 */

import {
  Array,
  Boolean,
  type Cause,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  FiberHandle,
  Layer,
  MutableRef,
  Option,
  Order,
  Ordering,
  Queue,
  Result,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef,
  pipe,
} from "effect";
import { constVoid, flow } from "effect/Function";
import { describeThrown } from "~/domain/Failure.ts";
import type { GroupSpec, Migration } from "~/domain/Persisted.ts";
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
import type { GmError } from "./Gm.ts";
import { decodeUnknown, describeSchemaError } from "./SchemaIo.ts";
import { type KeyValueKind, KeyValueStore, STORAGE_PREFIX } from "./KeyValueStore.ts";

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

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  reason: StorageFailureReason,
  direction: StorageDirection,
  group: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

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
  readonly update: (change: (current: A) => A) => Effect.Effect<A, StorageError>;

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

/** A caller that waits for a write to reach the backend. */
type WriteReply = Deferred.Deferred<void, StorageError>;

type Command<A> = Data.TaggedEnum<{
  Hydrate: { readonly reply: Deferred.Deferred<A> };
  Write: { readonly value: A; readonly reply: WriteReply };
  Update: {
    readonly change: (current: A) => A;
    readonly reply: Deferred.Deferred<A, StorageError>;
  };
  Reset: { readonly reply: Deferred.Deferred<A, StorageError> };
  Flush: { readonly reply: WriteReply };
  /** The debounce window closed. */
  Elapsed: Record<never, never>;
  /** Another tab wrote the key. */
  Remote: { readonly raw: Option.Option<string> };
}>;

interface CommandDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: Command<this["A"]>;
}

const Command = Data.taggedEnum<CommandDefinition>();

/**
 * The debounce window of a group.
 *
 * Each caller in the window waits for the write that reaches the backend. A
 * state with callers therefore has at least one of them.
 */
type Held<A> = Data.TaggedEnum<{
  /** Nothing is held, and nobody waits. */
  Empty: Record<never, never>;
  /** A value waits for the window to close. It is the last write of the window. */
  Holding: { readonly value: A; readonly waiters: Array.NonEmptyReadonlyArray<WriteReply> };
  /**
   * The exit path wrote the held value. The callers still wait for the actor,
   * which answers them on its next turn.
   */
  Written: { readonly waiters: Array.NonEmptyReadonlyArray<WriteReply> };
}>;

interface HeldDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: Held<this["A"]>;
}

const Held = Data.taggedEnum<HeldDefinition>();

type Holding<A> = Data.TaggedEnum.Value<Held<A>, "Holding">;

const waitersOf = <A>(held: Held<A>): ReadonlyArray<WriteReply> =>
  pipe(
    held,
    Held.$match({
      Empty: () => [],
      Holding: ({ waiters }) => waiters,
      Written: ({ waiters }) => waiters,
    }),
  );

/** The held value and its callers, when the window holds a value. */
const holdingOf = <A>(held: Held<A>): Option.Option<Holding<A>> =>
  pipe(
    held,
    Held.$match({
      Empty: () => Option.none(),
      Holding: (holding) => Option.some(holding),
      Written: () => Option.none(),
    }),
  );

/** Put a value in the window. It replaces the held value, and every caller keeps waiting. */
const hold =
  <A>(value: A, reply: WriteReply) =>
  (held: Held<A>): Held<A> =>
    Held.Holding({ value, waiters: pipe(waitersOf(held), Array.append(reply)) });

/** How a group writes an accepted value. */
type WritePolicy = Data.TaggedEnum<{
  /** Each accepted value goes to the backend before the next command. */
  Immediate: Record<never, never>;
  /** Values wait in a window, and the last one of the window goes. */
  Debounced: { readonly delay: Duration.Duration };
}>;

const WritePolicy = Data.taggedEnum<WritePolicy>();

/**
 * A promise is not a completed write, so a promise-backed manager never holds a
 * value. Each accepted change goes through the actor while the page is alive,
 * and that keeps one serial write order.
 */
const writePolicy = (kind: KeyValueKind, debounceMs: number): WritePolicy =>
  pipe(
    kind !== "gm-async" && debounceMs > 0,
    Boolean.match({
      onFalse: () => WritePolicy.Immediate(),
      onTrue: () => WritePolicy.Debounced({ delay: Duration.millis(debounceMs) }),
    }),
  );

/**
 * The stored wrapper.
 *
 * `data` stays `unknown` here. It is the group's own payload, and it is decoded
 * against the group schema after migration.
 */
const Envelope = Schema.Struct({ schemaVersion: Schema.Finite, data: Schema.Unknown });

type Envelope = typeof Envelope.Type;

/** Data from a 0.1 development build has no envelope. Treat it as v0. */
const toEnvelope = (parsed: unknown): Envelope =>
  pipe(
    parsed,
    Schema.decodeUnknownOption(Envelope),
    Option.getOrElse(() => ({ schemaVersion: 0, data: parsed })),
  );

const byTarget: Order.Order<Migration> = pipe(
  Order.Number,
  Order.mapInput((step: Migration) => step.to),
);

/**
 * Build one value group over the value store.
 *
 * It is exported for a module that must own a group of its own, and not share
 * it. `frames/Auth.ts` builds the group of the frame credential in that way,
 * so no feature can read that value through `Storage`. Every other group
 * belongs to `Storage` and is reached through the service.
 */
export const makeGroup = Effect.fnUntraced(function* <A>(
  spec: GroupSpec<A>,
  kv: KeyValueStore["Service"],
  issues: Queue.Queue<StorageError>,
): Effect.fn.Return<ValueGroup<A>, never, Scope.Scope> {
  const key = `${STORAGE_PREFIX}${spec.name}`;
  const policy = writePolicy(kv.kind, spec.writeDebounceMs);

  const memory = yield* SubscriptionRef.make(spec.defaults());
  const mailbox = yield* Queue.unbounded<Command<A>>();

  // References and not `Ref`s, because the exit path reads and writes them with
  // no effect. Apart from that path, only the group fiber touches them, so
  // nothing can interleave.
  const held = MutableRef.make<Held<A>>(Held.Empty());
  /** Why the last read failed, until a later read or write succeeds. */
  const readFailure = MutableRef.make(Option.none<StorageError>());

  /**
   * The fiber that closes the current debounce window.
   *
   * A handle, and not a plain fiber. Arming it again interrupts the fiber
   * that is already there, and the scope interrupts whatever is left. A
   * detached fiber would keep the page alive after the runtime closes, and a
   * scoped fiber for each write would add a finaliser for each write.
   */
  const timer = yield* FiberHandle.make<void, never>();

  const failure = (reason: StorageFailureReason, direction: StorageDirection, detail: string) =>
    new StorageError({ reason, direction, group: spec.name, detail });

  /** A failure that carries its cause. The detail names the cause too. */
  const failureFrom =
    (reason: StorageFailureReason, direction: StorageDirection, detail: string) =>
    (cause: unknown): StorageError =>
      new StorageError({
        reason,
        direction,
        group: spec.name,
        detail: `${detail}: ${describeThrown(cause)}`,
        cause,
      });

  const backendWriteFailure = (cause: GmError): StorageError =>
    failureFrom("backend", "write", cause.detail)(cause);

  const report = (error: StorageError): Effect.Effect<void> => pipe(issues, Queue.offer(error));

  const setReadFailure = (failed: Option.Option<StorageError>): Effect.Effect<void> =>
    Effect.sync(() => {
      pipe(readFailure, MutableRef.set(failed));
    });

  // -- decoding ------------------------------------------------------------

  const migrate = (data: unknown, from: number): Result.Result<unknown, StorageError> => {
    const start: Result.Result<unknown, StorageError> = Result.succeed(data);
    return pipe(
      spec.migrations,
      Array.filter((step) => step.to > from),
      Array.sort(byTarget),
      Array.reduce(start, (migrated, step) =>
        pipe(
          migrated,
          Result.flatMap((current) =>
            Result.try({
              try: () => step.migrate(current),
              catch: failureFrom(
                "migration",
                "read",
                `migration to v${step.to} (${step.describe}) failed`,
              ),
            }),
          ),
        ),
      ),
    );
  };

  /** The payload in this build's version, or why it cannot be brought there. */
  const upgrade = ({ schemaVersion, data }: Envelope): Result.Result<unknown, StorageError> =>
    pipe(
      Order.Number(schemaVersion, spec.schemaVersion),
      Ordering.match({
        onLessThan: () => migrate(data, schemaVersion),
        onEqual: () => Result.succeed(data),
        // A newer build in another tab wrote this. Do not try to go backwards.
        // Use the defaults for this frame and leave the stored value alone.
        onGreaterThan: () =>
          Result.fail(
            failure(
              "invalid",
              "read",
              `the stored schema version ${schemaVersion} is newer ` +
                `than this build's ${spec.schemaVersion}`,
            ),
          ),
      }),
    );

  const read = (raw: string): Result.Result<A, StorageError> =>
    pipe(
      Result.try({
        try: (): unknown => JSON.parse(raw),
        catch: failureFrom("malformed", "read", "the stored value is not JSON"),
      }),
      Result.map(toEnvelope),
      Result.flatMap(upgrade),
      Result.flatMap(
        flow(
          decodeUnknown(spec.schema),
          Result.mapError(
            flow(
              describeSchemaError,
              failureFrom("invalid", "read", "the stored value failed schema validation"),
            ),
          ),
        ),
      ),
    );

  const decode = (raw: Option.Option<string>): Result.Result<A, StorageError> =>
    pipe(
      raw,
      Option.match({
        onNone: () => Result.succeed(spec.defaults()),
        onSome: read,
      }),
    );

  /** The decoded value, or the defaults and one issue. */
  const orDefaults = (decoded: Result.Result<A, StorageError>): Effect.Effect<A> =>
    pipe(
      decoded,
      Result.match({
        onFailure: (error) => pipe(report(error), Effect.as(spec.defaults())),
        onSuccess: Effect.succeed,
      }),
    );

  const decodeOrDefaults = flow(decode, orDefaults);

  // -- the backend ---------------------------------------------------------

  /**
   * Validated before it is published or written, and the *decoded* value is
   * what goes on. A schema repairs a field rather than rejecting it, so the
   * two differ.
   */
  const validate = flow(
    decodeUnknown(spec.schema),
    Result.mapError(
      flow(
        describeSchemaError,
        failureFrom("invalid", "write", "refusing to persist a value that fails its own schema"),
      ),
    ),
  );

  /**
   * The bytes for one value, or the failure that stops the write.
   *
   * The value is validated on the way out as well as on the way in. A bad
   * value is then caught where it was made, and not on the next page load. A
   * bad value that reached the disk would reset the group on the next read,
   * and it would take every other field with it.
   *
   * One function for the actor path and for the exit path. The two must give
   * the same bytes, and one function is the only way to be sure of that. Only
   * the actor reports a failure, so that one failure gives one message: the
   * actor writes the same value again and reports it there.
   */
  const encode = flow(
    validate,
    Result.flatMap((data) =>
      Result.try({
        try: () => JSON.stringify({ schemaVersion: spec.schemaVersion, data }),
        catch: failureFrom("malformed", "write", "the value cannot be serialised"),
      }),
    ),
  );

  /** Write one value to the backend. */
  const commit = (next: A): Effect.Effect<void, StorageError> =>
    pipe(
      encode(next),
      Effect.fromResult,
      Effect.tapError(report),
      Effect.flatMap((bytes) =>
        pipe(
          kv.set(key, bytes),
          Effect.mapError(backendWriteFailure),
          Effect.tapError(report),
          // Not interruptible. A promise inside the backend keeps running after
          // its fiber is interrupted, so an interrupted `set` could still land
          // after a later `remove`.
          Effect.uninterruptible,
        ),
      ),
      Effect.andThen(setReadFailure(Option.none())),
    );

  type SetUnsafe = (key: string, value: string) => void;

  /** One direct write. A throw becomes a failure, so the exit path never throws. */
  const writeDirect = (setUnsafe: SetUnsafe, bytes: string): Result.Result<void, StorageError> =>
    Result.try({
      try: () => setUnsafe(key, bytes),
      catch: failureFrom("backend", "write", "the direct write failed"),
    });

  /** The exit path wrote the held value. The actor answers its callers later. */
  const markWritten = (waiters: Array.NonEmptyReadonlyArray<WriteReply>): void => {
    pipe(held, MutableRef.set<Held<A>>(Held.Written({ waiters })));
    pipe(readFailure, MutableRef.set(Option.none()));
  };

  /** The held value, written with a direct call. It never throws. */
  const writeHeld = (setUnsafe: SetUnsafe, { value, waiters }: Holding<A>): void =>
    pipe(
      encode(value),
      Result.match({
        // The value cannot be written at all. The actor reports it, and it
        // fails the callers that wait for this write.
        onFailure: constVoid,
        onSuccess: (bytes) =>
          pipe(
            writeDirect(setUnsafe, bytes),
            Result.match({
              // The value stays held, so the actor tries again. A second
              // message therefore means a second failed attempt, and not one
              // failure twice.
              onFailure: (error) => {
                Queue.offerUnsafe(issues, error);
              },
              onSuccess: () => markWritten(waiters),
            }),
          ),
      }),
    );

  /**
   * Write the held value to the backend now, with no suspension.
   *
   * This exit path is only for a synchronous backend. A promise-backed
   * manager writes each accepted change through the actor with no debounce.
   * The actor waits for each promise before it starts the next write.
   *
   * Four rules hold this path together:
   *
   * 1. **One value goes, and it is the newest one.** `Holding` holds the last
   *    write of the debounce window. The order of two writes to one key is
   *    therefore the order that the backend sees.
   * 2. **Nothing is written twice.** The window becomes `Written` after the
   *    write, so the flush that the actor runs later finds nothing to write.
   * 3. **A value that the actor is writing is left alone.** The actor empties
   *    the window before it commits, and it runs one command at a time. A
   *    window that holds no value therefore means that nothing is owed.
   * 4. **It never throws.** The `pagehide` handler must return, and a browser
   *    swallows a throw from a listener. A failed write keeps the value held,
   *    so the actor writes it again if this page lives on.
   *
   * A command that is still in the mailbox is not covered. The exit path
   * cannot take it without breaking the actor order. A final exit can lose a
   * command that the actor did not accept before the exit.
   */
  const flushUnsafe = (): void =>
    pipe(
      Option.all({
        setUnsafe: Option.fromNullishOr(kv.setUnsafe),
        holding: holdingOf(MutableRef.get(held)),
      }),
      Option.match({
        onNone: constVoid,
        onSome: ({ setUnsafe, holding }) => writeHeld(setUnsafe, holding),
      }),
    );

  const publish = (next: A): Effect.Effect<void> => pipe(memory, SubscriptionRef.set(next));

  const cancelTimer = FiberHandle.clear(timer);

  /** Take whatever the window holds, and leave it empty. */
  const takeHeld = Effect.sync(() => pipe(held, MutableRef.getAndSet<Held<A>>(Held.Empty())));

  const settle = (
    waiters: ReadonlyArray<WriteReply>,
    outcome: Exit.Exit<void, StorageError>,
  ): Effect.Effect<void> =>
    pipe(waiters, Effect.forEach(Deferred.done(outcome), { discard: true }));

  /** Write whatever is inside the debounce window, if anything is. */
  const commitHeld: Effect.Effect<Exit.Exit<void, StorageError>> = Effect.gen(function* () {
    yield* cancelTimer;
    const taken = yield* takeHeld;
    const outcome = yield* pipe(
      taken,
      Held.$match({
        Empty: () => Effect.succeed(Exit.void),
        Holding: ({ value }) => Effect.exit(commit(value)),
        Written: () => Effect.succeed(Exit.void),
      }),
    );
    yield* settle(waitersOf(taken), outcome);
    return outcome;
  });

  // -- the command loop ----------------------------------------------------

  const elapsed = pipe(mailbox, Queue.offer(Command.Elapsed()));

  const armTimer = (delay: Duration.Duration) =>
    pipe(Effect.sleep(delay), Effect.andThen(elapsed), FiberHandle.run(timer));

  /** Write an accepted value now, and give the caller the outcome. */
  const commitNow = (accepted: A, reply: WriteReply): Effect.Effect<void> =>
    pipe(
      commit(accepted),
      Effect.exit,
      Effect.flatMap((outcome) => pipe(reply, Deferred.done(outcome))),
    );

  /** Hold an accepted value until the window closes. The caller waits for that write. */
  const holdFor = (delay: Duration.Duration, accepted: A, reply: WriteReply): Effect.Effect<void> =>
    pipe(
      Effect.sync(() => {
        pipe(held, MutableRef.update(hold(accepted, reply)));
      }),
      Effect.andThen(armTimer(delay)),
    );

  const persist = (accepted: A, reply: WriteReply): Effect.Effect<void> =>
    pipe(
      policy,
      WritePolicy.$match({
        Immediate: () => commitNow(accepted, reply),
        Debounced: ({ delay }) => holdFor(delay, accepted, reply),
      }),
    );

  /** Report a refused value, and give the caller the same failure. */
  const refuse = (error: StorageError, reply: WriteReply): Effect.Effect<void> => {
    const answer = pipe(reply, Deferred.fail(error));
    return pipe(report(error), Effect.andThen(answer));
  };

  // Validated before it is published, and the *decoded* value is what gets
  // published. Publishing the raw value would leave memory holding a value
  // that storage does not have, and the setting would appear to revert on the
  // next page load.
  const applyWrite = (next: A, reply: WriteReply): Effect.Effect<void> =>
    pipe(
      validate(next),
      Result.match({
        onFailure: (error) => refuse(error, reply),
        onSuccess: (accepted) => pipe(publish(accepted), Effect.andThen(persist(accepted, reply))),
      }),
    );

  // Do not publish the defaults after a transport failure. They are an answer
  // for this caller, not the state of the world. An unrelated update must not
  // write them over good data later.
  const readFailed = (cause: Cause.Cause<GmError>): Effect.Effect<A> => {
    const error = failureFrom("backend", "read", "could not read the stored value")(cause);
    return pipe(
      report(error),
      Effect.andThen(setReadFailure(Option.some(error))),
      Effect.andThen(SubscriptionRef.get(memory)),
    );
  };

  const readStored = (raw: Option.Option<string>): Effect.Effect<A> =>
    pipe(setReadFailure(Option.none()), Effect.andThen(decodeOrDefaults(raw)), Effect.tap(publish));

  const hydrate = Effect.fnUntraced(function* (reply: Deferred.Deferred<A>) {
    // A value still inside its debounce window is newer than the disk. Write
    // it first, or the read brings back the value that it is about to replace.
    yield* commitHeld;
    const stored = yield* Effect.exit(kv.get(key));
    const value = yield* pipe(stored, Exit.match({ onFailure: readFailed, onSuccess: readStored }));
    yield* pipe(reply, Deferred.succeed(value));
  });

  const changeAndWrite = Effect.fnUntraced(function* (
    change: (current: A) => A,
    reply: Deferred.Deferred<A, StorageError>,
  ) {
    const next = change(yield* SubscriptionRef.get(memory));
    const written = yield* Deferred.make<void, StorageError>();
    yield* applyWrite(next, written);
    yield* pipe(
      Deferred.await(written),
      Effect.matchEffect({
        onFailure: (error) => pipe(reply, Deferred.fail(error)),
        onSuccess: () => pipe(reply, Deferred.succeed(next)),
      }),
      Effect.forkDetach,
    );
  });

  // The defaults are not a safe base for a read, change and write. Refuse
  // until a later read succeeds, or until the caller replaces the whole value
  // with `write`.
  const update = (
    change: (current: A) => A,
    reply: Deferred.Deferred<A, StorageError>,
  ): Effect.Effect<void> =>
    pipe(
      Effect.sync(() => MutableRef.get(readFailure)),
      Effect.flatMap(
        Option.match({
          onNone: () => changeAndWrite(change, reply),
          onSome: (error) => pipe(reply, Deferred.fail(error)),
        }),
      ),
    );

  const reset = Effect.fnUntraced(function* (reply: Deferred.Deferred<A, StorageError>) {
    yield* cancelTimer;
    const taken = yield* takeHeld;
    // The waiting writes were deliberately dropped, and they never reached
    // storage. `write` promises to complete when they do, so they must be
    // failed, not succeeded. The caller asked for this, so it is not reported
    // beside the message that caused it.
    yield* settle(
      waitersOf(taken),
      Exit.fail(failure("cancelled", "write", "the write was replaced by a reset")),
    );
    const defaults = spec.defaults();
    yield* publish(defaults);
    const removed = yield* pipe(
      kv.remove(key),
      Effect.mapError(backendWriteFailure),
      Effect.tapError(report),
      Effect.uninterruptible,
      Effect.exit,
    );
    yield* pipe(
      removed,
      Exit.match({
        onFailure: () => Effect.void,
        onSuccess: () => setReadFailure(Option.none()),
      }),
    );
    const answer = pipe(
      removed,
      Exit.map(() => defaults),
    );
    yield* pipe(reply, Deferred.done(answer));
  });

  const flush = (reply: WriteReply): Effect.Effect<void> =>
    pipe(
      commitHeld,
      Effect.flatMap((outcome) => pipe(reply, Deferred.done(outcome))),
    );

  const acceptRemote = flow(decodeOrDefaults, Effect.flatMap(publish));

  // Local intent wins while it is waiting. Another tab did commit, but
  // replacing the value that this user has just chosen would be the greater
  // surprise. Our own commit becomes the last write.
  const remote = (raw: Option.Option<string>): Effect.Effect<void> =>
    pipe(
      Effect.sync(() => MutableRef.get(held)),
      Effect.flatMap(
        Held.$match({
          Empty: () => acceptRemote(raw),
          Holding: () => Effect.void,
          Written: () => acceptRemote(raw),
        }),
      ),
    );

  const handle = (command: Command<A>): Effect.Effect<void> =>
    pipe(
      command,
      Command.$match({
        Hydrate: ({ reply }) => hydrate(reply),
        Write: ({ value, reply }) => applyWrite(value, reply),
        Update: ({ change, reply }) => update(change, reply),
        Reset: ({ reply }) => reset(reply),
        Flush: ({ reply }) => flush(reply),
        Elapsed: () => commitHeld,
        Remote: ({ raw }) => remote(raw),
      }),
    );

  yield* pipe(Queue.take(mailbox), Effect.flatMap(handle), Effect.forever, Effect.forkScoped);

  // Another tab's writes enter through the same queue, so they take their
  // turn like everything else.
  yield* pipe(
    kv.changes(key),
    Stream.runForEach((raw) => pipe(mailbox, Queue.offer(Command.Remote({ raw })))),
    Effect.forkScoped,
  );

  const ask = <Ok, Err>(
    make: (reply: Deferred.Deferred<Ok, Err>) => Command<A>,
  ): Effect.Effect<Ok, Err> =>
    pipe(
      Deferred.make<Ok, Err>(),
      Effect.tap((reply) => pipe(mailbox, Queue.offer(make(reply)))),
      Effect.flatMap(Deferred.await),
    );

  return {
    name: spec.name,
    current: SubscriptionRef.get(memory),
    currentUnsafe: () => SubscriptionRef.getUnsafe(memory),
    changes: SubscriptionRef.changes(memory),
    hydrate: ask<A, never>((reply) => Command.Hydrate({ reply })),
    write: (next) => ask<void, StorageError>((reply) => Command.Write({ value: next, reply })),
    update: (change) => ask<A, StorageError>((reply) => Command.Update({ change, reply })),
    reset: ask<A, StorageError>((reply) => Command.Reset({ reply })),
    flush: ask<void, StorageError>((reply) => Command.Flush({ reply })),
    flushUnsafe,
  };
});

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** What `Storage` does with every group at once. None of it depends on the value type. */
type GroupLifecycle = Pick<ValueGroup<unknown>, "hydrate" | "flush" | "flushUnsafe">;

export class Storage extends Context.Service<
  Storage,
  {
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
     * For the page exit only. This writes held values for synchronous backends.
     * Promise-backed managers do not hold values in a debounce window. This call
     * never throws. A failed direct write becomes one issue.
     */
    readonly flushAllUnsafe: () => void;
  }
>()("vimium/platform/Storage") {
  static readonly layer: Layer.Layer<Storage, never, KeyValueStore> = Layer.effect(
    Storage,
    Effect.gen(function* () {
      const kv = yield* KeyValueStore;
      const issues = yield* Queue.unbounded<StorageError>();

      const settings = yield* makeGroup(settingsGroup, kv, issues);
      const marks = yield* makeGroup(marksGroup, kv, issues);
      const findHistory = yield* makeGroup(findHistoryGroup, kv, issues);
      const history = yield* makeGroup(historyGroup, kv, issues);
      const session = yield* makeGroup(sessionGroup, kv, issues);

      // Every group, and never a subset. `update` works against the value in
      // memory, so a group that was never read has only the defaults — and the
      // first write to it would replace the user's whole stored value with the
      // defaults plus one change.
      const groups: ReadonlyArray<GroupLifecycle> = [
        settings,
        marks,
        findHistory,
        history,
        session,
      ];

      return Storage.of({
        settings,
        marks,
        findHistory,
        history,
        session,
        issues: Stream.fromQueue(issues),
        hydrateAll: pipe(
          groups,
          Effect.forEach((group) => group.hydrate, {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
        flushAll: pipe(
          groups,
          Effect.forEach((group) => Effect.ignore(group.flush), {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
        flushAllUnsafe: () =>
          pipe(
            groups,
            Array.forEach((group) => group.flushUnsafe()),
          ),
      });
    }),
  );
}
