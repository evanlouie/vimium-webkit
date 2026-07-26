import { assert, assertEquals } from "@std/assert";
import * as z from "zod/mini";
import { errAsync, okAsync } from "neverthrow";
import type { ValueBackend } from "~/platform/gm.ts";
import {
  type Migration,
  type StorageIssue,
  ValueStore,
} from "~/platform/storage.ts";

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
    get: (key) => okAsync(map.get(key)),
    set: (key, value) => {
      map.set(key, value);
      return okAsync(undefined);
    },
    remove: (key) => {
      map.delete(key);
      return okAsync(undefined);
    },
    list: () => okAsync([...map.keys()]),
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

const schema = z.object({ count: z.number(), label: z.string() });
type Shape = z.infer<typeof schema>;

const defaults = (): Shape => ({ count: 0, label: "default" });

const spec = (migrations?: readonly Migration[]) => ({
  name: "test",
  schema,
  defaults,
  schemaVersion: 2,
  migrations,
});

Deno.test("an absent value hydrates to the defaults", async () => {
  const fake = fakeBackend(false);
  const group = new ValueStore(fake.backend).group(spec());
  assertEquals(await group.hydrate(), defaults());
});

Deno.test("a written value round-trips through the envelope", async () => {
  const fake = fakeBackend(false);
  const store = new ValueStore(fake.backend);
  const group = store.group(spec());

  await group.write({ count: 3, label: "three" });
  const raw = fake.map.get("vimium-webkit:test");
  assert(raw !== undefined);
  assertEquals(JSON.parse(raw), {
    schemaVersion: 2,
    data: { count: 3, label: "three" },
  });

  const reread = new ValueStore(fake.backend).group(spec());
  assertEquals(await reread.hydrate(), { count: 3, label: "three" });
});

Deno.test("malformed JSON falls back to defaults and reports", async () => {
  const fake = fakeBackend(false);
  fake.map.set("vimium-webkit:test", "{not json");
  const store = new ValueStore(fake.backend);
  const issues: StorageIssue[] = [];
  store.onIssue((issue) => issues.push(issue));

  assertEquals(await store.group(spec()).hydrate(), defaults());
  assertEquals(issues[0]?.kind, "malformed");
});

Deno.test("a schema mismatch falls back to defaults and reports", async () => {
  const fake = fakeBackend(false);
  fake.map.set(
    "vimium-webkit:test",
    JSON.stringify({ schemaVersion: 2, data: { count: "not a number" } }),
  );
  const store = new ValueStore(fake.backend);
  const issues: StorageIssue[] = [];
  store.onIssue((issue) => issues.push(issue));

  assertEquals(await store.group(spec()).hydrate(), defaults());
  assertEquals(issues[0]?.kind, "invalid");
});

Deno.test("migrations run in order and only forward", async () => {
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
  assertEquals(await group.hydrate(), { count: 5, label: "migrated" });
});

Deno.test("a throwing migration falls back to defaults and reports", async () => {
  const fake = fakeBackend(false);
  fake.map.set(
    "vimium-webkit:test",
    JSON.stringify({ schemaVersion: 1, data: {} }),
  );
  const store = new ValueStore(fake.backend);
  const issues: StorageIssue[] = [];
  store.onIssue((issue) => issues.push(issue));

  const group = store.group(spec([{
    to: 2,
    describe: "explodes",
    migrate: () => {
      throw new Error("boom");
    },
  }]));

  assertEquals(await group.hydrate(), defaults());
  assertEquals(issues[0]?.kind, "migration");
});

Deno.test("data written by a newer build is left alone", async () => {
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
  assertEquals(await group.hydrate(), defaults());
  assertEquals(fake.map.get("vimium-webkit:test"), stored);
});

Deno.test("pre-envelope data is treated as version 0", async () => {
  const fake = fakeBackend(false);
  fake.map.set(
    "vimium-webkit:test",
    JSON.stringify({ count: 7, label: "old" }),
  );
  const group = new ValueStore(fake.backend).group(spec());
  assertEquals(await group.hydrate(), { count: 7, label: "old" });
});

Deno.test("peek is synchronous and current() falls back to defaults", async () => {
  const fake = fakeBackend(false);
  const group = new ValueStore(fake.backend).group(spec());
  assertEquals(group.peek(), undefined);
  assertEquals(group.current(), defaults());
  await group.hydrate();
  assertEquals(group.peek(), defaults());
});

Deno.test("update applies against the cached value", async () => {
  const fake = fakeBackend(false);
  const group = new ValueStore(fake.backend).group(spec());
  await group.hydrate();
  const result = await group.update((current) => ({ ...current, count: 9 }));
  assert(result.isOk());
  assertEquals(group.current().count, 9);
});

Deno.test("reset clears storage and reverts in memory", async () => {
  const fake = fakeBackend(false);
  const group = new ValueStore(fake.backend).group(spec());
  await group.write({ count: 4, label: "x" });
  await group.reset();
  assertEquals(fake.map.has("vimium-webkit:test"), false);
  assertEquals(group.current(), defaults());
});

Deno.test("subscribers see cross-tab changes when the backend supports it", async () => {
  const fake = fakeBackend(true);
  const store = new ValueStore(fake.backend);
  assertEquals(store.supportsWatch, true);

  const group = store.group(spec());
  await group.hydrate();

  const seen: Shape[] = [];
  group.subscribe((value) => seen.push(value));
  fake.notify(
    "test",
    JSON.stringify({ schemaVersion: 2, data: { count: 42, label: "remote" } }),
  );

  assertEquals(seen.at(-1), { count: 42, label: "remote" });
});

Deno.test("a backend without a watch primitive reports it honestly", () => {
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
          return errAsync({
            kind: "failed" as const,
            api: "setValue",
            message: "disk full",
          });
        }
        writes.push(value);
        return base.backend.set(key, value);
      },
    },
  };
};

Deno.test("a debounced write resolves from the flush, not the timer", async () => {
  const fake = failableBackend();
  const group = new ValueStore(fake.backend).group(debouncedSpec(5));
  fake.fail = true;

  const result = await group.write({ count: 1, label: "a" });

  // The regression: the promise used to resolve `Ok` when the *timer* fired
  // while `void`-ing the flush, so `ResultAsync<void, StorageIssue>` could
  // never be `Err` in production and every error branch built on it was
  // unreachable.
  assert(result.isErr(), "a failing backend must surface as Err");
  assertEquals(result.error.kind, "backend");
});

Deno.test("a superseded write settles rather than hanging", async () => {
  const fake = failableBackend();
  const group = new ValueStore(fake.backend).group(debouncedSpec(5));

  // The first write's timer is cleared by the second. Its promise used to be
  // orphaned by that `clearTimeout`, so `await update()` never returned.
  const first = group.write({ count: 1, label: "a" });
  const second = group.write({ count: 2, label: "b" });

  const [a, b] = await Promise.all([first, second]);
  assert(a.isOk());
  assert(b.isOk());
  // Coalesced: one write reaches the backend, carrying the newest value.
  assertEquals(fake.writes.length, 1);
  assertEquals(JSON.parse(fake.writes[0] ?? "{}").data, {
    count: 2,
    label: "b",
  });
});

Deno.test("flush() commits a pending write immediately", async () => {
  const fake = failableBackend();
  const group = new ValueStore(fake.backend).group(debouncedSpec(10_000));

  const pending = group.write({ count: 5, label: "e" });
  assertEquals(fake.writes.length, 0);

  await group.flush();
  assertEquals(fake.writes.length, 1);
  assert((await pending).isOk(), "the pending write adopts the flush outcome");
});

Deno.test("flushAll commits every group", async () => {
  const fake = failableBackend();
  const store = new ValueStore(fake.backend);
  const one = store.group({ ...debouncedSpec(10_000), name: "one" });
  const two = store.group({ ...debouncedSpec(10_000), name: "two" });

  void one.write({ count: 1, label: "a" });
  void two.write({ count: 2, label: "b" });
  await store.flushAll();

  assertEquals(fake.writes.length, 2);
});

Deno.test("hydrate does not resurrect a value a pending write is replacing", async () => {
  const fake = failableBackend();
  const store = new ValueStore(fake.backend);
  const group = store.group(debouncedSpec(10_000));

  const stored = group.write({ count: 1, label: "stored" });
  await group.flush();
  assert((await stored).isOk());

  // Written but still inside its debounce window when a refresh comes in.
  void group.write({ count: 2, label: "newer" });
  assertEquals(await group.hydrate(), { count: 2, label: "newer" });
});

Deno.test("a value that fails its own schema is never persisted", async () => {
  const fake = failableBackend();
  const group = new ValueStore(fake.backend).group(spec());

  // Caught here rather than on the next load, where it would reset the whole
  // group and take every other field down with it.
  const result = await group.write(
    { count: "not a number", label: "x" } as unknown as Shape,
  );
  assert(result.isErr());
  assertEquals(result.error.kind, "invalid");
  assertEquals(fake.writes.length, 0);
});

Deno.test("hydrateAll covers every registered group", async () => {
  const fake = fakeBackend(false);
  const store = new ValueStore(fake.backend);
  const one = store.group({ ...spec(), name: "one" });
  const two = store.group({ ...spec(), name: "two" });

  assertEquals(store.groups.length, 2);
  await store.hydrateAll();

  // The bug this makes impossible: three of five groups were hydrated by a
  // hand-written list, and `update()` on an unhydrated group replaces the
  // user's whole persisted value with the defaults plus one change.
  assertEquals(one.peek(), defaults());
  assertEquals(two.peek(), defaults());
});
