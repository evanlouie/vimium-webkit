import { Effect, Fiber, Option, Result, Schema } from "effect";
import { test } from "vitest";
import { GmError, type ValueBackend } from "~/platform/gm.ts";
import {
  type Migration,
  type StorageError,
  ValueStore,
} from "~/platform/storage.ts";
import { assert, assertEquals } from "./support/assert.ts";

/** Run an effect to a promise, so each test reads as it did before. */
const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);

/** Run an effect and observe the typed failure instead of throwing. */
const attempt = <A, E>(
  effect: Effect.Effect<A, E>,
): Promise<Result.Result<A, E>> => Effect.runPromise(Effect.result(effect));

interface Fake {
  readonly backend: ValueBackend;
  readonly map: Map<string, string>;
  notify(key: string, raw: string | undefined): void;
}

const fakeBackend = (withWatch: boolean): Fake => {
  const map = new Map<string, string>();
  const watchers = new Map<string, (raw: string | undefined) => void>();

  const backend: ValueBackend = {
    kind: "gm-async",
    get: (key) => Effect.succeed(Option.fromNullishOr(map.get(key) ?? null)),
    set: (key, value) =>
      Effect.sync(() => {
        map.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        map.delete(key);
      }),
    watch: withWatch
      ? (key, onChange) => {
        watchers.set(key, onChange);
        return () => watchers.delete(key);
      }
      : null,
  };

  return {
    backend,
    map,
    notify: (key, raw) => watchers.get(`vimium-webkit:${key}`)?.(raw),
  };
};

const schema = Schema.Struct({ count: Schema.Number, label: Schema.String });
type Shape = typeof schema.Type;

const defaults = (): Shape => ({ count: 0, label: "default" });

const spec = (migrations?: readonly Migration[]) => ({
  name: "test",
  schema,
  defaults,
  schemaVersion: 2,
  migrations,
});

test("an absent value hydrates to the defaults", async () => {
  const fake = fakeBackend(false);
  const group = new ValueStore(fake.backend).group(spec());
  assertEquals(await run(group.hydrate()), defaults());
});

test("a written value round-trips through the envelope", async () => {
  const fake = fakeBackend(false);
  const store = new ValueStore(fake.backend);
  const group = store.group(spec());

  await run(group.write({ count: 3, label: "three" }));
  const raw = fake.map.get("vimium-webkit:test");
  assert(raw !== undefined);
  assertEquals(JSON.parse(raw), {
    schemaVersion: 2,
    data: { count: 3, label: "three" },
  });

  const reread = new ValueStore(fake.backend).group(spec());
  assertEquals(await run(reread.hydrate()), { count: 3, label: "three" });
});

test("malformed JSON falls back to defaults and reports", async () => {
  const fake = fakeBackend(false);
  fake.map.set("vimium-webkit:test", "{not json");
  const store = new ValueStore(fake.backend);
  const issues: StorageError[] = [];
  store.onIssue((issue) => issues.push(issue));

  assertEquals(await run(store.group(spec()).hydrate()), defaults());
  assertEquals(issues[0]?.reason, "malformed");
});

test("a schema mismatch falls back to defaults and reports", async () => {
  const fake = fakeBackend(false);
  fake.map.set(
    "vimium-webkit:test",
    JSON.stringify({ schemaVersion: 2, data: { count: "not a number" } }),
  );
  const store = new ValueStore(fake.backend);
  const issues: StorageError[] = [];
  store.onIssue((issue) => issues.push(issue));

  assertEquals(await run(store.group(spec()).hydrate()), defaults());
  assertEquals(issues[0]?.reason, "invalid");
});

test("migrations run in order and only forward", async () => {
  const fake = fakeBackend(false);
  fake.map.set(
    "vimium-webkit:test",
    JSON.stringify({ schemaVersion: 0, data: { n: 5 } }),
  );

  const migrations: readonly Migration[] = [
    {
      to: 2,
      describe: "rename label",
      migrate: (data) => ({
        ...(data as Record<string, unknown>),
        label: "migrated",
      }),
    },
    {
      to: 1,
      describe: "n -> count",
      migrate: (data) => {
        const record = data as Record<string, unknown>;
        return { count: record["n"], label: "" };
      },
    },
  ];

  const group = new ValueStore(fake.backend).group(spec(migrations));
  assertEquals(await run(group.hydrate()), { count: 5, label: "migrated" });
});

test("a throwing migration falls back to defaults and reports", async () => {
  const fake = fakeBackend(false);
  fake.map.set(
    "vimium-webkit:test",
    JSON.stringify({ schemaVersion: 1, data: {} }),
  );
  const store = new ValueStore(fake.backend);
  const issues: StorageError[] = [];
  store.onIssue((issue) => issues.push(issue));

  const group = store.group(spec([{
    to: 2,
    describe: "explodes",
    migrate: () => {
      throw new Error("boom");
    },
  }]));

  assertEquals(await run(group.hydrate()), defaults());
  assertEquals(issues[0]?.reason, "migration");
});

test("data written by a newer build is left alone", async () => {
  // Downgrading would destroy the newer tab's settings; using defaults for this
  // session is the conservative choice.
  const fake = fakeBackend(false);
  const stored = JSON.stringify({
    schemaVersion: 99,
    data: { count: 1, label: "future" },
  });
  fake.map.set("vimium-webkit:test", stored);

  const store = new ValueStore(fake.backend);
  const group = store.group(spec());
  assertEquals(await run(group.hydrate()), defaults());
  assertEquals(fake.map.get("vimium-webkit:test"), stored);
});

test("pre-envelope data is treated as version 0", async () => {
  const fake = fakeBackend(false);
  fake.map.set(
    "vimium-webkit:test",
    JSON.stringify({ count: 7, label: "old" }),
  );
  const group = new ValueStore(fake.backend).group(spec());
  assertEquals(await run(group.hydrate()), { count: 7, label: "old" });
});

test("peek is synchronous and current() falls back to defaults", async () => {
  const fake = fakeBackend(false);
  const group = new ValueStore(fake.backend).group(spec());
  assertEquals(group.peek(), undefined);
  assertEquals(group.current(), defaults());
  await run(group.hydrate());
  assertEquals(group.peek(), defaults());
});

test("update applies against the cached value", async () => {
  const fake = fakeBackend(false);
  const group = new ValueStore(fake.backend).group(spec());
  await run(group.hydrate());
  const result = await attempt(
    group.update((current) => ({ ...current, count: 9 })),
  );
  assert(Result.isSuccess(result));
  assertEquals(group.current().count, 9);
});

test("reset clears storage and reverts in memory", async () => {
  const fake = fakeBackend(false);
  const group = new ValueStore(fake.backend).group(spec());
  await run(group.write({ count: 4, label: "x" }));
  await run(group.reset());
  assertEquals(fake.map.has("vimium-webkit:test"), false);
  assertEquals(group.current(), defaults());
});

test("subscribers see cross-tab changes when the backend supports it", async () => {
  const fake = fakeBackend(true);
  const store = new ValueStore(fake.backend);
  assertEquals(store.supportsWatch, true);

  const group = store.group(spec());
  await run(group.hydrate());

  const seen: Shape[] = [];
  group.subscribe((value) => seen.push(value));
  fake.notify(
    "test",
    JSON.stringify({ schemaVersion: 2, data: { count: 42, label: "remote" } }),
  );

  assertEquals(seen.at(-1), { count: 42, label: "remote" });
});

test("a backend without a watch primitive reports it honestly", () => {
  // quoid and Stay have no change-listener primitive at all; `lifecycle.ts`
  // substitutes a re-read on `visibilitychange`, and it needs to know.
  assertEquals(new ValueStore(fakeBackend(false).backend).supportsWatch, false);
});

// ---------------------------------------------------------------------------
// Debounced writes
//
// Every group in `settings/schema.ts` sets `writeDebounceMs > 0`, so this is
// the path production actually takes — and it had no coverage at all.
// ---------------------------------------------------------------------------

const debouncedSpec = (debounceMs: number) => ({
  ...spec(),
  writeDebounceMs: debounceMs,
});

/** A backend whose `set` can be made to fail, and which records every write. */
const failableBackend = (): {
  readonly backend: ValueBackend;
  readonly writes: string[];
  fail: boolean;
} => {
  const base = fakeBackend(false);
  const writes: string[] = [];
  const state = { fail: false };
  return {
    writes,
    get fail(): boolean {
      return state.fail;
    },
    set fail(value: boolean) {
      state.fail = value;
    },
    backend: {
      ...base.backend,
      set: (key, value) => {
        if (state.fail) {
          return Effect.fail(
            new GmError({
              reason: "failed",
              api: "setValue",
              detail: "disk full",
            }),
          );
        }
        writes.push(value);
        return base.backend.set(key, value);
      },
    },
  };
};

test("a debounced write resolves from the flush, not the timer", async () => {
  const fake = failableBackend();
  const group = new ValueStore(fake.backend).group(debouncedSpec(5));
  fake.fail = true;

  const result = await attempt(group.write({ count: 1, label: "a" }));

  // The regression: the promise used to resolve `Ok` when the *timer* fired
  // while `void`-ing the flush, so `ResultAsync<void, StorageIssue>` could
  // never be `Err` in production and every error branch built on it was
  // unreachable.
  assert(Result.isFailure(result), "a failing backend must surface as Err");
  assertEquals(result.failure.reason, "backend");
});

test("a superseded write settles rather than hanging", async () => {
  const fake = failableBackend();
  const group = new ValueStore(fake.backend).group(debouncedSpec(5));

  // The first write's timer is cleared by the second. Its promise used to be
  // orphaned by that `clearTimeout`, so `await update()` never returned.
  const first = attempt(group.write({ count: 1, label: "a" }));
  const second = attempt(group.write({ count: 2, label: "b" }));

  const [a, b] = await Promise.all([first, second]);
  assert(Result.isSuccess(a));
  assert(Result.isSuccess(b));
  // Coalesced: one write reaches the backend, carrying the newest value.
  assertEquals(fake.writes.length, 1);
  assertEquals(JSON.parse(fake.writes[0] ?? "{}").data, {
    count: 2,
    label: "b",
  });
});

test("flush() commits a pending write immediately", async () => {
  const fake = failableBackend();
  const group = new ValueStore(fake.backend).group(debouncedSpec(10_000));

  const pending = attempt(group.write({ count: 5, label: "e" }));
  assertEquals(fake.writes.length, 0);

  await run(group.flush());
  assertEquals(fake.writes.length, 1);
  assert(
    Result.isSuccess(await pending),
    "the pending write adopts the flush outcome",
  );
});

test("flushAll commits every group", async () => {
  const fake = failableBackend();
  const store = new ValueStore(fake.backend);
  const one = store.group({ ...debouncedSpec(10_000), name: "one" });
  const two = store.group({ ...debouncedSpec(10_000), name: "two" });

  void attempt(one.write({ count: 1, label: "a" }));
  void attempt(two.write({ count: 2, label: "b" }));
  await run(store.flushAll());

  assertEquals(fake.writes.length, 2);
});

test("hydrate does not resurrect a value a pending write is replacing", async () => {
  const fake = failableBackend();
  const store = new ValueStore(fake.backend);
  const group = store.group(debouncedSpec(10_000));

  const stored = attempt(group.write({ count: 1, label: "stored" }));
  await run(group.flush());
  assert(Result.isSuccess(await stored));

  // Written but still inside its debounce window when a refresh comes in.
  void attempt(group.write({ count: 2, label: "newer" }));
  assertEquals(await run(group.hydrate()), { count: 2, label: "newer" });
});

test("a value that fails its own schema is never persisted", async () => {
  const fake = failableBackend();
  const group = new ValueStore(fake.backend).group(spec());

  // Caught here rather than on the next load, where it would reset the whole
  // group and take every other field down with it.
  const result = await attempt(
    group.write({ count: "not a number", label: "x" } as unknown as Shape),
  );
  assert(Result.isFailure(result));
  assertEquals(result.failure.reason, "invalid");
  assertEquals(fake.writes.length, 0);
});

test("hydrateAll covers every registered group", async () => {
  const fake = fakeBackend(false);
  const store = new ValueStore(fake.backend);
  const one = store.group({ ...spec(), name: "one" });
  const two = store.group({ ...spec(), name: "two" });

  assertEquals(store.groups.length, 2);
  await run(store.hydrateAll());

  // The bug this makes impossible: three of five groups were hydrated by a
  // hand-written list, and `update()` on an unhydrated group replaces the
  // user's whole persisted value with the defaults plus one change.
  assertEquals(one.peek(), defaults());
  assertEquals(two.peek(), defaults());
});

test("reset cancels a pending write instead of letting it resurrect", async () => {
  // The bug: `reset()` removed the key but left the debounce fiber sleeping,
  // so the value reset had just erased was written straight back. Reachable
  // from `:clear-history`, which debounces for two seconds — so the HUD said
  // the index was erased and the visit reappeared on disk afterwards.
  const fake = fakeBackend(false);
  const group = new ValueStore(fake.backend).group(debouncedSpec(20));

  const pending = attempt(group.write({ count: 7, label: "secret" }));
  await run(group.reset());
  assertEquals(fake.map.get("vimium-webkit:test"), undefined);

  // Past the debounce window the write must not have come back.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assertEquals(fake.map.get("vimium-webkit:test"), undefined);

  // The caller must be released rather than parked, and told the truth: its
  // value was discarded, so reporting success would be a lie.
  const outcome = await pending;
  assert(Result.isFailure(outcome));
  assertEquals(outcome.failure.reason, "cancelled");
  assertEquals(outcome.failure.direction, "write");
});

test("a hydrate joiner is unaffected when the first caller is interrupted", async () => {
  // `Deferred.done(deferred, exit)` used to forward an *interrupt* to every
  // joiner, so a healthy second caller died because the first was cancelled —
  // and `hydrate()` declares that it cannot fail.
  // The read must actually suspend, or the interrupt lands after it has
  // finished and the test proves nothing: with a synchronous fake, mutating
  // this branch either way still passed.
  const fake = gatedBackend();
  fake.map.set(
    "vimium-webkit:test",
    JSON.stringify({ schemaVersion: 2, data: { count: 1, label: "disk" } }),
  );
  const group = new ValueStore(fake.backend).group(spec());

  const value = await Effect.runPromise(Effect.gen(function*() {
    const first = yield* Effect.forkChild(group.hydrate());
    const joiner = yield* Effect.forkChild(group.hydrate());
    yield* Effect.sleep(5);
    yield* Fiber.interrupt(first);
    // Two releases: the leader's abandoned read, then the joiner's own.
    yield* Effect.forkChild(
      Effect.repeat(
        Effect.sync(() => fake.gates.shift()?.()).pipe(Effect.delay(5)),
        { times: 5 },
      ),
    );
    // Whatever happened to the first caller, the joiner still gets a value.
    return yield* Fiber.join(joiner);
  }));
  // The value on disk, not the defaults: `hydrate()` declares it cannot fail,
  // so a joiner must be served the read, not a fallback. `0 || 1` accepted
  // both of the only two reachable answers and so asserted nothing.
  assertEquals(value, { count: 1, label: "disk" });
});

test("reset waits for a flush that is already touching the backend", async () => {
  // The first repair cancelled a *sleeping* debounce fiber, which left the
  // window between the sleep ending and `backend.set` resolving unguarded: the
  // group looked idle, `reset()` issued its `remove` alongside a live `set`,
  // and the erased value came back. On `gm-async` managers `set` is a promise
  // round-trip, so that window is real.
  const map = new Map<string, string>();
  const log: string[] = [];
  let releaseSet: (() => void) | undefined;
  const backend: ValueBackend = {
    kind: "gm-async",
    get: (key) => Effect.succeed(Option.fromNullishOr(map.get(key) ?? null)),
    set: (key, value) =>
      Effect.promise(async () => {
        log.push("set:start");
        await new Promise<void>((resolve) => {
          releaseSet = resolve;
        });
        map.set(key, value);
        log.push("set:done");
      }),
    remove: (key) =>
      Effect.sync(() => {
        log.push("remove");
        map.delete(key);
      }),
    watch: null,
  };

  const group = new ValueStore(backend).group(debouncedSpec(5));
  const pending = attempt(group.write({ count: 9, label: "secret" }));

  // Let the debounce fire and enter `set`, then reset while it is in flight.
  await new Promise((resolve) => setTimeout(resolve, 25));
  assertEquals(log, ["set:start"]);
  const reset = attempt(group.reset());
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseSet?.();
  await reset;
  await pending;

  // The remove must come after the write it is undoing, and win.
  assertEquals(log, ["set:start", "set:done", "remove"]);
  assertEquals(map.get("vimium-webkit:test"), undefined);
});

test("two flushes cannot overlap, so writes reach storage in order", async () => {
  // Round three's finding: an in-flight *handle* guarded a section that could
  // be entered twice. Two flushes each published their own handle, the first
  // to finish cleared it, and the group then looked idle to `reset()` — which
  // is how erased data came back. Two `set` calls could also resolve out of
  // order and leave the older value on disk under a newer cache.
  const map = new Map<string, string>();
  const log: string[] = [];
  const gates: Array<() => void> = [];
  const backend: ValueBackend = {
    kind: "gm-async",
    get: (key) => Effect.succeed(Option.fromNullishOr(map.get(key) ?? null)),
    set: (key, value) =>
      Effect.promise(async () => {
        const n = JSON.parse(value).data.count as number;
        log.push(`start:${n}`);
        await new Promise<void>((resolve) => gates.push(resolve));
        map.set(key, value);
        log.push(`done:${n}`);
      }),
    remove: (key) =>
      Effect.sync(() => {
        log.push("remove");
        map.delete(key);
      }),
    watch: null,
  };

  const group = new ValueStore(backend).group(debouncedSpec(5));
  const first = attempt(group.write({ count: 1, label: "old" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(log, ["start:1"]);

  // A second write and an explicit flush, while the first is still in the
  // backend. Nothing may enter `set` until the first one leaves it.
  const second = attempt(group.write({ count: 2, label: "new" }));
  const flushed = attempt(group.flush());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(log, ["start:1"], "the second flush must wait for the first");

  // Release them in the order they were admitted; the later value must win.
  // Sequential by design: each release must be observed before the next.
  while (gates.length > 0 || log.length < 4) {
    gates.shift()?.();
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await Promise.all([first, second, flushed]);

  assertEquals(log, ["start:1", "done:1", "start:2", "done:2"]);
  assertEquals(JSON.parse(map.get("vimium-webkit:test") ?? "{}").data, {
    count: 2,
    label: "new",
  });
});

/** A backend whose reads and writes can be released by hand. */
const gatedBackend = (): {
  readonly backend: ValueBackend;
  readonly map: Map<string, string>;
  readonly gates: Array<() => void>;
} => {
  const map = new Map<string, string>();
  const gates: Array<() => void> = [];
  const gate = (): Promise<void> =>
    new Promise<void>((resolve) => gates.push(resolve));
  return {
    map,
    gates,
    backend: {
      kind: "gm-async",
      get: (key) =>
        Effect.promise(async () => {
          await gate();
          return Option.fromNullishOr(map.get(key) ?? null);
        }),
      set: (key, value) =>
        Effect.promise(async () => {
          await gate();
          map.set(key, value);
        }),
      remove: (key) =>
        Effect.sync(() => {
          map.delete(key);
        }),
      watch: null,
    },
  };
};

test("a reset during a hydration is not undone by the read it overtook", async () => {
  // The read was decoded and adopted *after* the permit was released, so a
  // `reset()` that ran during it reverted the cache and the read then
  // republished the value the reset had erased — which the next write put back
  // on disk. `:clear-history` resolved successfully with every visit intact.
  const fake = gatedBackend();
  fake.map.set(
    "vimium-webkit:test",
    JSON.stringify({ schemaVersion: 2, data: { count: 5, label: "secret" } }),
  );
  const group = new ValueStore(fake.backend).group(spec());

  const hydrating = attempt(group.hydrate());
  await new Promise((resolve) => setTimeout(resolve, 5));
  const reset = attempt(group.reset());
  fake.gates.shift()?.();
  await Promise.all([hydrating, reset]);

  assertEquals(fake.map.get("vimium-webkit:test"), undefined);
  assertEquals(
    group.current(),
    defaults(),
    "the cache must not hold the erased value",
  );
});

test("a write during a hydration is not reverted by the read it overtook", async () => {
  // Same hole, other victim: `onVisible` re-hydrates while the user changes a
  // setting, the read publishes the pre-change value, and because `update()`
  // reads the cache the *next* change writes the stale value back over the
  // good one. The user's change was lost after being reported as saved.
  const fake = gatedBackend();
  fake.map.set(
    "vimium-webkit:test",
    JSON.stringify({ schemaVersion: 2, data: { count: 1, label: "stored" } }),
  );
  const group = new ValueStore(fake.backend).group(spec());

  const hydrating = attempt(group.hydrate());
  await new Promise((resolve) => setTimeout(resolve, 5));
  const writing = attempt(group.write({ count: 2, label: "user" }));

  // Release each gate as it appears: the write's `set` cannot even start until
  // the read has released the permit, so its gate does not exist yet.
  const settled = Promise.all([hydrating, writing]);
  for (let i = 0; i < 10; i++) {
    fake.gates.shift()?.();
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await settled;

  assertEquals(group.current(), { count: 2, label: "user" });
});

test("a repaired value is cached as repaired, not as it was offered", async () => {
  // The settings schema repairs a bad field rather than rejecting it, so the
  // outbound check could not fail for that group. Memory kept the bad value
  // while disk got the repaired one, and the setting silently reverted on the
  // next page load — after the dialog had said "Settings saved".
  const repairing = Schema.Struct({
    count: Schema.Number.pipe(
      Schema.catchDecoding(() => Effect.succeed(Option.some(0))),
    ),
    label: Schema.String,
  });
  const fake = fakeBackend(false);
  const group = new ValueStore(fake.backend).group({
    name: "test",
    schema: repairing as unknown as typeof schema,
    defaults,
    schemaVersion: 2,
  });

  await run(
    group.write({ count: "nonsense" as unknown as number, label: "x" }),
  );

  const stored = JSON.parse(fake.map.get("vimium-webkit:test") ?? "{}").data;
  assertEquals(stored, { count: 0, label: "x" });
  assertEquals(group.current(), stored, "the cache must agree with the disk");
});

test("an invalid value never reaches the cache", async () => {
  // It was written to `#cached` before validation, so `current()` and
  // `update()` served a value that had been refused by storage.
  const fake = fakeBackend(false);
  const group = new ValueStore(fake.backend).group(spec());
  await run(group.hydrate());

  const outcome = await attempt(
    group.write({ count: "not a number" as unknown as number, label: "x" }),
  );
  assert(Result.isFailure(outcome));
  assertEquals(group.current(), defaults());
});

test("reset erases even when a later write never lands", async () => {
  // `reset()` stood aside whenever a *later epoch existed* — but an epoch bump
  // marks intent, not commitment. Order matters: the reset is issued first, a
  // write is issued after it, and that write then fails. The reset saw a newer
  // epoch, skipped its `remove` entirely, and reported success — on the
  // privacy control, with the value still on disk.
  const map = new Map<string, string>();
  const gates: Array<() => void> = [];
  let failWrites = false;
  const backend: ValueBackend = {
    kind: "gm-async",
    get: (key) =>
      Effect.promise(async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return Option.fromNullishOr(map.get(key) ?? null);
      }),
    set: (key, value) =>
      failWrites
        ? Effect.fail(
          new GmError({ reason: "failed", api: "setValue", detail: "nope" }),
        )
        : Effect.sync(() => {
          map.set(key, value);
        }),
    remove: (key) =>
      Effect.sync(() => {
        map.delete(key);
      }),
    watch: null,
  };

  const store = new ValueStore(backend);
  const group = store.group(spec());
  map.set(
    "vimium-webkit:test",
    JSON.stringify({ schemaVersion: 2, data: { count: 7, label: "secret" } }),
  );

  // A read holds the permit, so the reset and the write both queue behind it.
  const reading = attempt(group.hydrate());
  await new Promise((resolve) => setTimeout(resolve, 5));

  const reset = attempt(group.reset());
  failWrites = true;
  const doomed = attempt(group.write({ count: 8, label: "newer" }));

  gates.shift()?.();
  await Promise.all([reading, reset, doomed]);

  assert(Result.isSuccess(await reset));
  assert(Result.isFailure(await doomed), "the write must have failed");
  assertEquals(
    map.get("vimium-webkit:test"),
    undefined,
    "a reset that reported success must have erased the key",
  );
});

test("a transient read failure cannot turn defaults into an update", async () => {
  const fake = fakeBackend(false);
  fake.map.set(
    "vimium-webkit:test",
    JSON.stringify({ schemaVersion: 2, data: { count: 7, label: "secret" } }),
  );
  let failRead = true;
  const backend: ValueBackend = {
    ...fake.backend,
    get: (key) =>
      failRead
        ? Effect.fail(
          new GmError({ reason: "failed", api: "getValue", detail: "offline" }),
        )
        : fake.backend.get(key),
  };
  const group = new ValueStore(backend).group(spec());

  assertEquals(await run(group.hydrate()), defaults());
  const rejected = await attempt(
    group.update((value) => ({ ...value, count: value.count + 1 })),
  );
  assert(Result.isFailure(rejected));
  assertEquals(
    JSON.parse(fake.map.get("vimium-webkit:test") ?? "null").data,
    { count: 7, label: "secret" },
  );

  failRead = false;
  assertEquals(await run(group.hydrate()), { count: 7, label: "secret" });
  await run(group.update((value) => ({ ...value, count: value.count + 1 })));
  assertEquals(group.current(), { count: 8, label: "secret" });
});

test("subscribers receive successful local writes", async () => {
  const fake = fakeBackend(false);
  const group = new ValueStore(fake.backend).group(spec());
  const seen: Shape[] = [];
  const unsubscribe = group.subscribe((value) => seen.push(value));

  await run(group.write({ count: 3, label: "local" }));
  unsubscribe();

  assertEquals(seen, [{ count: 3, label: "local" }]);
});

test("an interrupted asynchronous set cannot undo a reset", async () => {
  const map = new Map<string, string>();
  let startSet: (() => void) | null = null;
  let releaseSet: (() => void) | null = null;
  let removes = 0;
  const started = new Promise<void>((resolve) => {
    startSet = resolve;
  });
  const backend: ValueBackend = {
    kind: "gm-async",
    get: (key) => Effect.succeed(Option.fromNullishOr(map.get(key) ?? null)),
    set: (key, value) =>
      Effect.promise(async () => {
        startSet?.();
        await new Promise<void>((resolve) => {
          releaseSet = resolve;
        });
        map.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        removes++;
        map.delete(key);
      }),
    watch: null,
  };
  const group = new ValueStore(backend).group(spec());
  const writeFiber = Effect.runFork(
    group.write({ count: 9, label: "abandoned" }),
  );
  await started;

  const interrupted = Effect.runPromise(Fiber.interrupt(writeFiber));
  const reset = attempt(group.reset());
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(
    removes,
    0,
    "reset must wait for the continuing backend promise",
  );

  const unblockSet: unknown = releaseSet;
  assert(typeof unblockSet === "function");
  unblockSet();
  await interrupted;
  assert(Result.isSuccess(await reset));
  assertEquals(map.get("vimium-webkit:test"), undefined);
});

test("flush waits for an older commit queued behind a read", async () => {
  const map = new Map<string, string>();
  let releaseGet: (() => void) | null = null;
  let releaseSet: (() => void) | null = null;
  const backend: ValueBackend = {
    kind: "gm-async",
    get: (key) =>
      Effect.promise(async () => {
        await new Promise<void>((resolve) => {
          releaseGet = resolve;
        });
        return Option.fromNullishOr(map.get(key) ?? null);
      }),
    set: (key, value) =>
      Effect.promise(async () => {
        await new Promise<void>((resolve) => {
          releaseSet = resolve;
        });
        map.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        map.delete(key);
      }),
    watch: null,
  };
  const group = new ValueStore(backend).group({
    ...spec(),
    writeDebounceMs: 1,
  });

  const hydration = run(group.hydrate());
  while (releaseGet === null) {
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const write = attempt(group.write({ count: 4, label: "queued" }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  let flushed = false;
  const flush = run(group.flush()).then(() => {
    flushed = true;
  });
  const unblockGet: unknown = releaseGet;
  assert(typeof unblockGet === "function");
  unblockGet();
  while (releaseSet === null) {
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(flushed, false, "flush returned before the queued set settled");

  const unblockSet: unknown = releaseSet;
  assert(typeof unblockSet === "function");
  unblockSet();
  await Promise.all([hydration, write, flush]);
  assertEquals(
    JSON.parse(map.get("vimium-webkit:test") ?? "null").data,
    { count: 4, label: "queued" },
  );
});
