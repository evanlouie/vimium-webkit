/**
 * Namespaced, cached, schema-validated value store.
 *
 * Storage is shared across script versions, across frames, and is directly
 * editable in every manager's UI. It is therefore *untrusted input*: every read
 * is Zod-validated and every failure has a defined fallback. Nothing in this
 * module may throw during boot (IMPLEMENTATION_PLAN.md §6.11).
 *
 * Values are grouped (`settings`, `mappings`, `marks`, ...) rather than stored
 * as one blob, so that a corrupt group can be reset independently and so that a
 * mark write does not rewrite the whole settings object.
 */

import { ResultAsync } from "neverthrow";
import { liftResult, type ValueBackend } from "./gm.ts";
import { err, ok, type Result } from "neverthrow";

export const STORAGE_PREFIX = "vimium-webkit:";

export type StorageIssueKind =
  /** The backend itself failed (manager error, quota, revoked permission). */
  | "backend"
  /** Stored bytes were not JSON. */
  | "malformed"
  /** Stored JSON did not match the schema, even after migration. */
  | "invalid"
  /** A migration step threw. */
  | "migration";

export interface StorageIssue {
  readonly kind: StorageIssueKind;
  readonly group: string;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Structural subset of a Zod schema.
 *
 * Declared structurally rather than as `z.ZodMiniType` so that this module does
 * not pin a Zod major version, and so tests can supply hand-written validators.
 */
export interface Validator<T> {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: unknown };
}

/** A single ordered, idempotent transformation of persisted data. */
export interface Migration {
  /** The `schemaVersion` this step produces. */
  readonly to: number;
  readonly describe: string;
  migrate(data: unknown): unknown;
}

export interface GroupSpec<T> {
  readonly name: string;
  readonly schema: Validator<T>;
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

const isEnvelope = (value: unknown): value is Envelope =>
  typeof value === "object" && value !== null &&
  typeof (value as Record<string, unknown>)["schemaVersion"] === "number" &&
  "data" in value;

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export type IssueListener = (issue: StorageIssue) => void;

/**
 * The per-frame façade over a `ValueBackend`.
 *
 * Reads are cached in memory after the first hydration: on quoid every read is
 * a promise round-trip to the extension process, and the key-dispatch hot path
 * cannot await anything.
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

  report(issue: StorageIssue): void {
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
  hydrateAll(): Promise<unknown[]> {
    return Promise.all(this.#groups.map((group) => group.hydrate()));
  }

  /**
   * Flush every group's pending write.
   *
   * Wired to `pagehide` and `visibilitychange`, where the alternative is losing
   * whatever is still inside a debounce window.
   */
  flushAll(): Promise<unknown[]> {
    return Promise.all(this.#groups.map((group) => group.flush()));
  }
}

export class ValueGroup<T> {
  readonly #store: ValueStore;
  readonly #backend: ValueBackend;
  readonly #spec: GroupSpec<T>;
  readonly #key: string;
  readonly #listeners = new Set<(value: T) => void>();

  #cached: T | undefined;
  #hydration: Promise<T> | null = null;
  #pendingWrite: T | undefined;
  #writeTimer: number | null = null;
  #unwatch: (() => void) | null = null;

  /**
   * The outcome every debounced `write()` since the last flush is waiting on.
   *
   * One promise shared by all of them, because a superseded write must *settle*
   * — adopting its successor's outcome — rather than being dropped.
   * `clearTimeout` used to orphan the previous `resolve` outright, so an
   * `await update()` that lost a race never returned at all.
   */
  #settlement: Promise<Result<void, StorageIssue>> | null = null;
  #settle: ((result: Result<void, StorageIssue>) => void) | null = null;

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
   * Synchronous by design — the key-dispatch path must never await.
   */
  peek(): T | undefined {
    return this.#cached;
  }

  /** The hydrated value, or the schema defaults if hydration has not run. */
  current(): T {
    return this.#cached ?? this.#spec.defaults();
  }

  /**
   * Read, validate, and migrate. Never rejects: any problem is reported to the
   * store's issue listeners and the defaults are returned in its place.
   */
  hydrate(): Promise<T> {
    this.#hydration ??= this.#hydrateOnce().finally(() => {
      this.#hydration = null;
    });
    return this.#hydration;
  }

  async #hydrateOnce(): Promise<T> {
    // A debounced write still sitting in its timer holds the newest value.
    // Reading around it and adopting what is on disk would resurrect exactly
    // the value the pending write is about to replace.
    if (this.#pendingWrite !== undefined) await this.flush();
    return this.#doHydrate();
  }

  async #doHydrate(): Promise<T> {
    const raw = await this.#backend.get(this.#key);
    if (raw.isErr()) {
      this.#issue("backend", raw.error.message, raw.error);
      return this.#adopt(this.#spec.defaults());
    }
    return this.#adopt(this.#decode(raw.value));
  }

  #decode(raw: string | undefined): T {
    if (raw === undefined) return this.#spec.defaults();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      this.#issue("malformed", "stored value is not valid JSON", cause);
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
      );
      return this.#spec.defaults();
    }

    const result = this.#spec.schema.safeParse(data);
    if (!result.success) {
      this.#issue(
        "invalid",
        "stored value failed schema validation",
        result.error,
      );
      return this.#spec.defaults();
    }
    return result.data;
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
   * Replace the value. Resolves once the write actually reaches the backend.
   *
   * The debounced path used to resolve `Ok` when the *timer* fired, `void`-ing
   * the flush that followed — so `ResultAsync<void, StorageIssue>` could never
   * be `Err` in production, and error handling built on it was provably
   * unreachable. Every group here debounces, so that was every group.
   */
  write(value: T): ResultAsync<void, StorageIssue> {
    this.#cached = value;
    const debounce = this.#spec.writeDebounceMs ?? 0;
    if (debounce <= 0) return this.#flushValue(value);

    this.#pendingWrite = value;
    if (this.#writeTimer !== null) clearTimeout(this.#writeTimer);

    // Shared: everyone waiting on this debounce window gets the outcome of the
    // flush that closes it, whether or not their own value is the one written.
    this.#settlement ??= new Promise<Result<void, StorageIssue>>((resolve) => {
      this.#settle = resolve;
    });
    const settlement = this.#settlement;

    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = null;
      void this.flush();
    }, debounce);

    return ResultAsync.fromSafePromise(settlement).andThen((result) => result);
  }

  /**
   * Write any pending value now.
   *
   * Wired to `pagehide` and `visibilitychange`: marks debounce 100 ms, settings
   * 250 ms and the history index 2 s, so without this every one of them is lost
   * on a navigation that happens inside its own window.
   */
  flush(): ResultAsync<void, StorageIssue> {
    if (this.#writeTimer !== null) {
      clearTimeout(this.#writeTimer);
      this.#writeTimer = null;
    }

    const pending = this.#pendingWrite;
    const settle = this.#settle;
    this.#pendingWrite = undefined;
    this.#settlement = null;
    this.#settle = null;

    if (pending === undefined) {
      settle?.(ok(undefined));
      return liftResult(ok(undefined));
    }

    const flushed = this.#flushValue(pending);
    if (settle !== null) {
      void flushed.match(
        () => settle(ok(undefined)),
        (issue) => settle(err(issue)),
      );
    }
    return flushed;
  }

  #flushValue(value: T): ResultAsync<void, StorageIssue> {
    // Validated on the way out as well as on the way in, so a bad value is
    // caught where it was produced rather than on the next load — where it
    // would reset the group and take every other field with it.
    const validated = this.#spec.schema.safeParse(value);
    if (!validated.success) {
      return liftResult(err(this.#issue(
        "invalid",
        "refusing to persist a value that fails its own schema",
        validated.error,
      )));
    }

    let encoded: string;
    try {
      const envelope: Envelope = {
        schemaVersion: this.#spec.schemaVersion,
        data: validated.data,
      };
      encoded = JSON.stringify(envelope);
    } catch (cause) {
      const issue = this.#issue(
        "malformed",
        "value is not serialisable",
        cause,
      );
      return liftResult(err(issue));
    }
    return this.#backend.set(this.#key, encoded).mapErr((cause) =>
      this.#issue("backend", cause.message, cause)
    );
  }

  /** Read-modify-write against the cached value. */
  update(mutate: (current: T) => T): ResultAsync<T, StorageIssue> {
    const next = mutate(this.current());
    return this.write(next).map(() => next);
  }

  /** Delete the persisted value and revert to defaults in memory. */
  reset(): ResultAsync<T, StorageIssue> {
    const defaults = this.#spec.defaults();
    this.#adopt(defaults);
    return this.#backend.remove(this.#key)
      .mapErr((cause) => this.#issue("backend", cause.message, cause))
      .map(() => defaults);
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
    kind: StorageIssueKind,
    message: string,
    cause?: unknown,
  ): StorageIssue {
    const issue: StorageIssue = {
      kind,
      group: this.#spec.name,
      message: cause === undefined
        ? message
        : `${message}: ${describeCause(cause)}`,
      cause,
    };
    this.#store.report(issue);
    return issue;
  }
}
