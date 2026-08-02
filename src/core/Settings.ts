/**
 * The settings, as one observable value.
 *
 * Every other service reads settings from here, and no other service knows that
 * they are persisted. A service that must react to a change subscribes to
 * `changes` in a forked fiber. The fiber belongs to the layer scope, so it stops
 * with the runtime.
 */

import { Context, Effect, Layer, type Stream } from "effect";
import type { Settings as SettingsData } from "~/domain/Persisted.ts";
import { Storage, type StorageError } from "~/platform/Storage.ts";

export type { SettingsData };

export class Settings extends Context.Service<Settings, {
  readonly current: Effect.Effect<SettingsData>;

  /**
   * The settings, read synchronously.
   *
   * For the key path only, which must not suspend. Every other caller uses
   * `current`.
   */
  readonly currentUnsafe: () => SettingsData;

  /** The current settings, and then every later value. */
  readonly changes: Stream.Stream<SettingsData>;

  /**
   * Replace the settings.
   *
   * It completes when the value reaches storage. The value that it gives back
   * is what was *stored*, which is not always what was offered: the schema
   * repairs a bad field instead of rejecting it.
   */
  readonly save: (
    next: SettingsData,
  ) => Effect.Effect<SettingsData, StorageError>;

  /** Change some fields, as one indivisible step. */
  readonly patch: (
    change: (current: SettingsData) => SettingsData,
  ) => Effect.Effect<SettingsData, StorageError>;

  /** Read the stored settings again. Another tab may have changed them. */
  readonly reload: Effect.Effect<SettingsData>;
}>()("vimium/core/Settings") {
  static readonly layer: Layer.Layer<Settings, never, Storage> = Layer.effect(
    Settings,
    Effect.gen(function*() {
      const storage = yield* Storage;
      const group = storage.settings;

      return Settings.of({
        current: group.current,
        currentUnsafe: group.currentUnsafe,
        changes: group.changes,
        save: Effect.fn("Settings.save")(function*(next: SettingsData) {
          yield* group.write(next);
          // Adopt what was stored, and not what was offered. The schema repairs
          // a bad field rather than rejecting it, so the two differ.
          return yield* group.current;
        }),
        patch: group.update,
        reload: group.hydrate,
      });
    }),
  );
}
