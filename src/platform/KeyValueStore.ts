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
 * frame-credential group holds the credential that admits a frame to the
 * cross-frame session. A page that can read that credential can join the session and drive
 * a click inside a document of another origin. `localStorage` is also a poor
 * store on WebKit: intelligent tracking prevention erases all script-writable
 * storage after seven days without user interaction on the site, and the store
 * is partitioned per top-level site, so the settings do not follow the user.
 *
 * `Capabilities` reports which backend is in use, and the HUD warns the user
 * when it is not durable.
 */

import { Context, Effect, Layer, MutableRef, Option, Record, Stream, pipe } from "effect";
import { Gm, StoreKind, type ValueStore } from "./Gm.ts";

export const STORAGE_PREFIX = "vimium-webkit:";

export class KeyValueStore extends Context.Service<KeyValueStore, ValueStore>()(
  "vimium/platform/KeyValueStore",
) {
  /**
   * The value store of the manager, or a map in memory.
   *
   * The choice is the capability probe of `Gm`. Do not infer durability from a
   * manager name or from a user agent.
   */
  static readonly layer: Layer.Layer<KeyValueStore, never, Gm> = Layer.effect(
    KeyValueStore,
    Effect.gen(function* () {
      const gm = yield* Gm;
      return pipe(gm.values, Option.getOrElse(memoryStore));
    }),
  );
}

function memoryStore(): ValueStore {
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
