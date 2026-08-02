/**
 * A string-in, string-out key-value backend.
 *
 * The value store of the userscript manager is the only durable choice. An
 * in-memory map keeps the application alive when the manager gives no such
 * store.
 *
 * `localStorage` is not a choice, and that is a security decision. The page
 * owns `localStorage`, and every group that this application keeps is private:
 * the settings hold the exclusion patterns and the key mappings of the user,
 * the marks and the history hold the pages that the user visited, and the
 * session group holds the credential that admits a frame to the cross-frame
 * session. A page that can read that credential can join the session and drive
 * a click inside a document of another origin. `localStorage` is also a poor
 * store on WebKit: intelligent tracking prevention erases all script-writable
 * storage after seven days without user interaction on the site, and the store
 * is partitioned per top-level site, so the settings do not follow the user.
 *
 * `Capabilities` reports which backend is in use, and the HUD warns the user
 * when it is not durable.
 */

import { Context, Effect, Layer, Option, Stream } from "effect";
import { Gm, type GmError } from "./Gm.ts";

export const STORAGE_PREFIX = "vimium-webkit:";

export type KeyValueKind = "gm-async" | "gm-sync" | "memory";

export class KeyValueStore extends Context.Service<KeyValueStore, {
  readonly kind: KeyValueKind;
  /** True when the backend survives a page load. */
  readonly durable: boolean;
  /** True when another tab's write can be seen without a poll. */
  readonly watchable: boolean;

  /**
   * True when the store belongs to the userscript manager.
   *
   * Two properties come with that store, and a service that holds a secret
   * needs both: page code cannot read it, and every frame of the page reads the
   * same values, whatever the origin of the frame. `frames/Auth.ts` keeps the
   * frame credential only when this is true.
   */
  readonly managerPrivate: boolean;

  readonly get: (key: string) => Effect.Effect<Option.Option<string>, GmError>;
  readonly set: (key: string, value: string) => Effect.Effect<void, GmError>;
  readonly remove: (key: string) => Effect.Effect<void, GmError>;
  /** Values written by another tab. Empty when the backend cannot report them. */
  readonly changes: (key: string) => Stream.Stream<Option.Option<string>>;
}>()("vimium/platform/KeyValueStore") {
  static readonly layer: Layer.Layer<KeyValueStore, never, Gm> = Layer
    .effect(
      KeyValueStore,
      Effect.gen(function*() {
        const gm = yield* Gm;

        const fromGm = Option.map(gm.values, (api) =>
          KeyValueStore.of({
            kind: api.kind,
            durable: true,
            watchable: Option.isSome(api.changes),
            managerPrivate: true,
            get: api.get,
            set: api.set,
            remove: api.remove,
            changes: (key) =>
              Option.match(api.changes, {
                onNone: () => Stream.empty,
                onSome: (make) => make(key),
              }),
          }));

        return Option.getOrElse(fromGm, memoryStore);
      }),
    );

  /** An in-memory layer. For a test, and for a realm with no storage at all. */
  static readonly layerMemory: Layer.Layer<KeyValueStore> = Layer.sync(
    KeyValueStore,
    memoryStore,
  );
}

function memoryStore(): KeyValueStore["Service"] {
  const map = new Map<string, string>();
  return KeyValueStore.of({
    kind: "memory",
    durable: false,
    watchable: false,
    // The map belongs to this realm, so the page cannot read it. It is not
    // shared with another frame either, which is why it is not a store for the
    // frame credential. `ARCHITECTURE.md` section 5.1 says why the top frame
    // does not give a credential of its own to a child instead.
    managerPrivate: false,
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
