/**
 * A string-in, string-out key-value backend.
 *
 * The manager is the first choice. `localStorage` is the last resort, and a
 * poor one on WebKit: intelligent tracking prevention erases all script-writable
 * storage after seven days without user interaction on the site, and the store
 * is partitioned per top-level site, so settings do not follow the user. An
 * in-memory map keeps the application alive when nothing else works.
 *
 * `Capabilities` reports which one is in use, and the HUD warns the user when it
 * is not durable.
 */

import { Context, Effect, Layer, Option, Stream } from "effect";
import { Dom } from "./Dom.ts";
import { Gm, gmAttempt, type GmError } from "./Gm.ts";

export const STORAGE_PREFIX = "vimium-webkit:";

export type KeyValueKind =
  | "gm-async"
  | "gm-sync"
  | "localstorage-fallback"
  | "memory";

export class KeyValueStore extends Context.Service<KeyValueStore, {
  readonly kind: KeyValueKind;
  /** True when the backend survives a page load. */
  readonly durable: boolean;
  /** True when another tab's write can be seen without a poll. */
  readonly watchable: boolean;

  readonly get: (key: string) => Effect.Effect<Option.Option<string>, GmError>;
  readonly set: (key: string, value: string) => Effect.Effect<void, GmError>;
  readonly remove: (key: string) => Effect.Effect<void, GmError>;
  /** Values written by another tab. Empty when the backend cannot report them. */
  readonly changes: (key: string) => Stream.Stream<Option.Option<string>>;
}>()("vimium/platform/KeyValueStore") {
  static readonly layer: Layer.Layer<KeyValueStore, never, Gm | Dom> = Layer
    .effect(
      KeyValueStore,
      Effect.gen(function*() {
        const gm = yield* Gm;
        const dom = yield* Dom;

        const fromGm = Option.map(gm.values, (api) =>
          KeyValueStore.of({
            kind: api.kind,
            durable: true,
            watchable: Option.isSome(api.changes),
            get: api.get,
            set: api.set,
            remove: api.remove,
            changes: (key) =>
              Option.match(api.changes, {
                onNone: () => Stream.empty,
                onSome: (make) => make(key),
              }),
          }));

        return Option.getOrElse(
          Option.orElse(fromGm, () => localStorageStore(dom)),
          memoryStore,
        );
      }),
    );

  /** An in-memory layer. For a test, and for a realm with no storage at all. */
  static readonly layerMemory: Layer.Layer<KeyValueStore> = Layer.sync(
    KeyValueStore,
    memoryStore,
  );
}

const localStorageStore = (
  dom: Dom["Service"],
): Option.Option<KeyValueStore["Service"]> => {
  let store: Storage;
  try {
    store = dom.window.localStorage;
    const probeKey = `${STORAGE_PREFIX}__probe`;
    store.setItem(probeKey, "1");
    store.removeItem(probeKey);
  } catch {
    return Option.none();
  }

  const scoped = (key: string): string => `${STORAGE_PREFIX}${key}`;

  return Option.some(KeyValueStore.of({
    kind: "localstorage-fallback",
    durable: false,
    watchable: true,
    get: (key) =>
      gmAttempt(
        "localStorage.getItem",
        () => Option.fromNullOr(store.getItem(scoped(key))),
      ),
    set: (key, value) =>
      gmAttempt("localStorage.setItem", () => {
        store.setItem(scoped(key), value);
      }),
    remove: (key) =>
      gmAttempt("localStorage.removeItem", () => {
        store.removeItem(scoped(key));
      }),
    changes: (key) =>
      Stream.fromEventListener<StorageEvent>(dom.window, "storage").pipe(
        Stream.filter((event) => event.key === scoped(key)),
        Stream.map((event) => Option.fromNullOr(event.newValue)),
      ),
  }));
};

function memoryStore(): KeyValueStore["Service"] {
  const map = new Map<string, string>();
  return KeyValueStore.of({
    kind: "memory",
    durable: false,
    watchable: false,
    get: (key) => Effect.sync(() => Option.fromNullishOr(map.get(key) ?? null)),
    set: (key, value) =>
      Effect.sync(() => {
        map.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        map.delete(key);
      }),
    changes: () => Stream.empty,
  });
}
