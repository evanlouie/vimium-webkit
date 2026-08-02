/**
 * The compiled key trie.
 *
 * The default mappings compile first, and the user's compile on top. Adding
 * rather than replacing is what makes `unmap j` work against the defaults,
 * which is what every Vimium configuration assumes. The cost is a line-number
 * offset, and `lineOffset` corrects it, so a diagnostic beside the user's own
 * text names the user's own line.
 *
 * The trie is derived state. A fiber rebuilds it whenever the settings change,
 * so nothing has to remember to recompile.
 */

import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import { COMMANDS, DEFAULT_MAPPINGS } from "~/domain/Command.ts";
import { type CompiledMappings, compileMappings } from "~/domain/Mapping.ts";
import type { Settings as SettingsData } from "~/domain/Persisted.ts";
import { Capabilities } from "~/platform/Capabilities.ts";
import { Settings } from "./Settings.ts";

const DEFAULT_MAPPING_LINES = `${DEFAULT_MAPPINGS}\n`.split("\n").length - 1;

const KNOWN_COMMANDS: ReadonlySet<string> = new Set(Object.keys(COMMANDS));

export class Mappings extends Context.Service<Mappings, {
  readonly compiled: Effect.Effect<CompiledMappings>;

  /** The trie, read synchronously. For the key path only. */
  readonly compiledUnsafe: () => CompiledMappings;

  /** The current trie, and then every later one. */
  readonly changes: Stream.Stream<CompiledMappings>;

  /** Compile a source without adopting it. The settings dialog checks with it. */
  readonly check: (source: string) => Effect.Effect<CompiledMappings>;
}>()("vimium/core/Mappings") {
  static readonly layer: Layer.Layer<
    Mappings,
    never,
    Settings | Capabilities
  > = Layer.effect(
    Mappings,
    Effect.gen(function*() {
      const settings = yield* Settings;
      const capabilities = yield* Capabilities;

      const compileFor = (source: string): CompiledMappings =>
        compileMappings(`${DEFAULT_MAPPINGS}\n${source}`, {
          knownCommands: KNOWN_COMMANDS,
          // Refuse a reserved shortcut only on the engine where the binding
          // truly cannot fire. Elsewhere the same configuration is legitimate.
          rejectReservedShortcuts: capabilities.webkitLike,
          lineOffset: DEFAULT_MAPPING_LINES,
        });

      const compile = (current: SettingsData): CompiledMappings =>
        compileFor(current.keyMappings);

      const trie = yield* SubscriptionRef.make(
        compile(yield* settings.current),
      );

      yield* Effect.forkScoped(
        Stream.runForEach(
          settings.changes,
          (current) => SubscriptionRef.set(trie, compile(current)),
        ),
      );

      return Mappings.of({
        compiled: SubscriptionRef.get(trie),
        compiledUnsafe: () => SubscriptionRef.getUnsafe(trie),
        changes: SubscriptionRef.changes(trie),
        check: (source) => Effect.sync(() => compileFor(source)),
      });
    }),
  );
}
