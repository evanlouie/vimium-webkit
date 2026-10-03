/**
 * The compiled key trie.
 *
 * The default mappings compile first, and the user's compile on top. Adding
 * rather than replacing is what makes `unmap j` work against the defaults,
 * which is what every Vimium configuration assumes. The cost is a line-number
 * offset, and `lineOffset` corrects it, so a diagnostic beside the user's own
 * text names the user's own line.
 *
 * The trie is derived state. It is the trie of the text that the settings hold
 * when it is read, so it never lags behind them, and nothing has to remember
 * to recompile. A key that the guard held while the application started plays
 * right after the settings load, and a trie that a fiber rebuilt a moment
 * later took the first half of a command typed during the load with it.
 */

import { Context, Effect, Layer, MutableRef, Stream, pipe } from "effect";
import { DEFAULT_MAPPINGS } from "~/domain/Command.ts";
import { type CompiledMappings, compileMappings } from "~/domain/Mapping.ts";
import type { Settings as SettingsData } from "~/domain/Persisted.ts";
import { Capabilities } from "~/platform/Capabilities.ts";
import { Settings } from "./Settings.ts";

const DEFAULT_MAPPING_LINES = `${DEFAULT_MAPPINGS}\n`.split("\n").length - 1;

export class Mappings extends Context.Service<
  Mappings,
  {
    /** The trie, read synchronously. For the key path only. */
    readonly compiledUnsafe: () => CompiledMappings;

    /**
     * The current trie, and then each one for a new text. A change to
     * another setting gives no new trie.
     */
    readonly changes: Stream.Stream<CompiledMappings>;

    /** Compile a source without adopting it. The settings dialog checks with it. */
    readonly check: (source: string) => Effect.Effect<CompiledMappings>;
  }
>()("vimium/core/Mappings") {
  static readonly layer: Layer.Layer<Mappings, never, Settings | Capabilities> = Layer.effect(
    Mappings,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const capabilities = yield* Capabilities;

      const compileFor = (source: string): CompiledMappings =>
        compileMappings(`${DEFAULT_MAPPINGS}\n${source}`, {
          // Refuse a reserved shortcut only on the engine where the binding
          // truly cannot fire. Elsewhere the same configuration is legitimate.
          rejectReservedShortcuts: capabilities.webkitLike,
          lineOffset: DEFAULT_MAPPING_LINES,
        });

      // The last text and its trie. The key path reads the trie on every
      // key, and the text seldom changes.
      const initial = settings.currentUnsafe().keyMappings;
      const latest = MutableRef.make({ source: initial, compiled: compileFor(initial) });

      /** The trie of one text. While the text stays, every reader gets the same trie. */
      const compiledOf = (source: string): CompiledMappings =>
        pipe(
          latest,
          MutableRef.update((entry) =>
            entry.source === source ? entry : { source, compiled: compileFor(source) },
          ),
          MutableRef.get,
        ).compiled;

      const sourceOf = (current: SettingsData): string => current.keyMappings;

      return Mappings.of({
        compiledUnsafe: () => compiledOf(sourceOf(settings.currentUnsafe())),
        changes: pipe(
          settings.changes,
          Stream.map(sourceOf),
          Stream.changes,
          Stream.map(compiledOf),
        ),
        check: (source) => Effect.sync(() => compileFor(source)),
      });
    }),
  );
}
