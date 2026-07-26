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
import { err, ok } from "neverthrow";

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

  constructor(backend: ValueBackend) {
    this.#backend = backend;
  }

  get backendKind(): ValueBackend["kind"] {
    return this.#backend.kind;
  }

  get supportsWatch(): boolean {
    return this.#backend.watch !== null;
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
    return new ValueGroup<T>(this, this.#backend, spec);
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
    this.#hydration ??= this.#doHydrate().finally(() => {
      this.#hydration = null;
    });
    return this.#hydration;
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
      if (migrated === undefined) return this.#spec.defaults();
      data = migrated;
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

  #runMigrations(data: unknown, from: number): unknown | undefined {
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
        return undefined;
      }
    }
    return current;
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

  /** Replace the value. Resolves once the write reaches the backend. */
  write(value: T): ResultAsync<void, StorageIssue> {
    this.#cached = value;
    const debounce = this.#spec.writeDebounceMs ?? 0;
    if (debounce <= 0) return this.#flushValue(value);

    this.#pendingWrite = value;
    if (this.#writeTimer !== null) clearTimeout(this.#writeTimer);
    return ResultAsync.fromSafePromise(
      new Promise<void>((resolve) => {
        this.#writeTimer = setTimeout(() => {
          this.#writeTimer = null;
          const pending = this.#pendingWrite;
          this.#pendingWrite = undefined;
          if (pending !== undefined) void this.#flushValue(pending);
          resolve();
        }, debounce);
      }),
    ).andThen(() => ok(undefined));
  }

  #flushValue(value: T): ResultAsync<void, StorageIssue> {
    let encoded: string;
    try {
      const envelope: Envelope = {
        schemaVersion: this.#spec.schemaVersion,
        data: value,
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
