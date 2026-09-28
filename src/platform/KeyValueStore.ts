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

import { Context, Data, Effect, Layer, MutableRef, Option, Record, Stream, pipe } from "effect";
import { Gm, type GmError, GmValueApi } from "./Gm.ts";

export const STORAGE_PREFIX = "vimium-webkit:";

/** The name of a store kind, as the capability report and the settings dialog give it. */
export type KeyValueKind = "gm-async" | "gm-sync" | "memory";

/** A variant with no fields. The type `{}` would mean any value that is not nullish. */
type NoFields = Record.ReadonlyRecord<never, never>;

/**
 * Which backend holds the values, and what it can do.
 *
 * The two forms of the manager's store survive a page load, and they belong
 * to the userscript manager. Two properties come with that store, and a
 * service that holds a secret needs both: page code cannot read it, and every
 * frame of the page reads the same values, whatever the origin of the frame.
 * `frames/Auth.ts` keeps the frame credential only in such a store.
 */
export type StoreKind = Data.TaggedEnum<{
  /** The promise form of the manager's store. It cannot report another tab's write. */
  GmAsync: NoFields;
  /** The synchronous form of the manager's store. */
  GmSync: {
    /** True when another tab's write can be seen without a poll. */
    readonly watchable: boolean;
  };
  /**
   * A map in this realm, which is lost when the page unloads.
   *
   * The map belongs to this realm, so the page cannot read it. It is not
   * shared with another frame either, which is why it is not a store for the
   * frame credential. `ARCHITECTURE.md` section 5.1 says why the top frame
   * does not give a credential of its own to a child instead.
   */
  Memory: NoFields;
}>;

export const StoreKind = Data.taggedEnum<StoreKind>();

/** The name of a store kind. */
export const kindName: (kind: StoreKind) => KeyValueKind = StoreKind.$match({
  GmAsync: (): KeyValueKind => "gm-async",
  GmSync: (): KeyValueKind => "gm-sync",
  Memory: (): KeyValueKind => "memory",
});

export class KeyValueStore extends Context.Service<
  KeyValueStore,
  {
    /** Which backend this is, and so what it can do. */
    readonly kind: StoreKind;

    readonly get: (key: string) => Effect.Effect<Option.Option<string>, GmError>;
    readonly set: (key: string, value: string) => Effect.Effect<void, GmError>;
    readonly remove: (key: string) => Effect.Effect<void, GmError>;
    /**
     * Write now when the selected backend is synchronous.
     *
     * The promise-backed manager API gives `None`. Storage sends those writes
     * through its actor before the page exit.
     */
    readonly setUnsafe: Option.Option<(key: string, value: string) => void>;
    /** Values written by another tab. Empty when the backend cannot report them. */
    readonly changes: (key: string) => Stream.Stream<Option.Option<string>>;
  }
>()("vimium/platform/KeyValueStore") {
  static readonly layer: Layer.Layer<KeyValueStore, never, Gm> = Layer.effect(
    KeyValueStore,
    Effect.gen(function* () {
      const gm = yield* Gm;
      return pipe(gm.values, Option.map(managerStore), Option.getOrElse(memoryStore));
    }),
  );

  /** An in-memory layer. For a test, and for a realm with no storage at all. */
  static readonly layerMemory: Layer.Layer<KeyValueStore> = Layer.sync(KeyValueStore, memoryStore);
}

/**
 * The value store of the manager.
 *
 * The API kind is the existing capability probe. Do not infer durability from a
 * manager name or from a user agent.
 */
function managerStore(api: GmValueApi): KeyValueStore["Service"] {
  return pipe(
    api,
    GmValueApi.$match({
      Async: ({ get, set, remove }) =>
        KeyValueStore.of({
          kind: StoreKind.GmAsync(),
          get,
          set,
          remove,
          setUnsafe: Option.none(),
          changes: () => Stream.empty,
        }),
      Sync: ({ get, set, remove, setUnsafe, changes }) =>
        KeyValueStore.of({
          kind: StoreKind.GmSync({ watchable: Option.isSome(changes) }),
          get,
          set,
          remove,
          setUnsafe: Option.some(setUnsafe),
          changes: (key) =>
            pipe(
              changes,
              Option.match({
                onNone: () => Stream.empty,
                onSome: (make) => make(key),
              }),
            ),
        }),
    }),
  );
}

function memoryStore(): KeyValueStore["Service"] {
  // A reference and not a `Ref`, because `setUnsafe` writes it with no effect.
  const values = MutableRef.make<Record.ReadonlyRecord<string, string>>({});
  return KeyValueStore.of({
    kind: StoreKind.Memory(),
    get: (key) => Effect.sync(() => pipe(MutableRef.get(values), Record.get(key))),
    set: (key, value) =>
      Effect.sync(() => {
        pipe(values, MutableRef.update(Record.set(key, value)));
      }),
    remove: (key) =>
      Effect.sync(() => {
        pipe(values, MutableRef.update(Record.remove(key)));
      }),
    setUnsafe: Option.some((key, value) => {
      pipe(values, MutableRef.update(Record.set(key, value)));
    }),
    changes: () => Stream.empty,
  });
}
