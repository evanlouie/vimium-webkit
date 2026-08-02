/**
 * Normal mode: the dispatch path from one key to one command.
 *
 * The tests build the real `Keyboard`, `Modes`, `HandlerStack`, `Commands` and
 * `Report` layers. `Settings`, `Mappings` and `Exclusions` are stubs, because a
 * test decides what the user configured. Nothing here writes to a global.
 *
 * Node has no `KeyboardEvent`, so a test presses a plain object that carries
 * every field that the key path reads. The path never asks for more than that:
 * `domain/Key.ts` declares the shape as `KeyEventLike`, and the handler stack
 * only calls `preventDefault` and `stopImmediatePropagation`.
 *
 * A key that needs a focused media player belongs to `test/e2e/media.spec.ts`,
 * because the answer comes from `instanceof HTMLElement`, which needs a DOM.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Ref, Stream, SubscriptionRef } from "effect";
import { Commands } from "~/core/Commands.ts";
import { HandlerStack } from "~/core/HandlerStack.ts";
import { Keyboard } from "~/core/Keyboard.ts";
import { Exclusions } from "~/core/Exclusions.ts";
import { Mappings } from "~/core/Mappings.ts";
import { Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { COMMANDS } from "~/domain/Command.ts";
import { type EffectiveRule, FULLY_ENABLED } from "~/domain/Exclusion.ts";
import { compileMappings } from "~/domain/Mapping.ts";
import {
  defaultSettings,
  type Settings as SettingsData,
} from "~/domain/Persisted.ts";
import { Dom } from "~/platform/Dom.ts";
import { Realm } from "~/platform/Realm.ts";

// ---------------------------------------------------------------------------
// A pressed key
// ---------------------------------------------------------------------------

interface PressOptions {
  readonly code?: string;
  /** `false` makes the event synthetic, as a page's `dispatchEvent` does. */
  readonly isTrusted?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
}

/** Everything that the key path reads from a `KeyboardEvent`. */
class Press {
  readonly key: string;
  readonly code: string;
  readonly isTrusted: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey = false;
  readonly metaKey = false;
  readonly isComposing = false;
  defaultPrevented = false;
  propagationStopped = false;

  constructor(key: string, options: PressOptions = {}) {
    this.key = key;
    this.code = options.code ?? `Key${key.toUpperCase()}`;
    this.isTrusted = options.isTrusted ?? true;
    this.ctrlKey = options.ctrlKey ?? false;
    this.shiftKey = options.shiftKey ?? false;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true;
  }
}

/** The cast names what the object already is: everything the path reads. */
const asEvent = (press: Press): KeyboardEvent =>
  press as unknown as KeyboardEvent;

// ---------------------------------------------------------------------------
// The layers
// ---------------------------------------------------------------------------

const KNOWN_COMMANDS: ReadonlySet<string> = new Set(Object.keys(COMMANDS));

/** The compiled mappings of one source, with no defaults under them. */
const mappingsOf = (source: string): Layer.Layer<Mappings> =>
  Layer.sync(Mappings, () => {
    const compiled = compileMappings(source, {
      knownCommands: KNOWN_COMMANDS,
      rejectReservedShortcuts: false,
    });
    return Mappings.of({
      compiled: Effect.succeed(compiled),
      compiledUnsafe: () => compiled,
      changes: Stream.make(compiled),
      check: () => Effect.succeed(compiled),
    });
  });

const settingsOf = (patch: Partial<SettingsData>): Layer.Layer<Settings> =>
  Layer.sync(Settings, () => {
    const data: SettingsData = { ...defaultSettings(), ...patch };
    return Settings.of({
      current: Effect.succeed(data),
      currentUnsafe: () => data,
      changes: Stream.make(data),
      save: (next) => Effect.succeed(next),
      patch: (change) => Effect.succeed(change(data)),
      reload: Effect.succeed(data),
    });
  });

const exclusionsOf = (rule: EffectiveRule): Layer.Layer<Exclusions> =>
  Layer.effect(
    Exclusions,
    Effect.map(SubscriptionRef.make(rule), (effective) =>
      Exclusions.of({
        effective,
        effectiveUnsafe: () => rule,
        resolveLocal: Effect.succeed(rule),
        match: () => Effect.succeed(rule),
        adopt: () => Effect.void,
        isEnabled: Effect.succeed(rule.enabled),
      })),
  );

interface Options {
  readonly mappings: string;
  readonly settings?: Partial<SettingsData>;
  readonly exclusion?: EffectiveRule;
}

/**
 * `Keyboard` over its dependencies, with `HandlerStack` and `Commands` exposed.
 *
 * A test needs the stack to deliver a key, and the registry to record what the
 * key ran.
 */
const layerFor = (
  options: Options,
): Layer.Layer<Commands | HandlerStack | Keyboard | Modes> => {
  const support = Layer.mergeAll(
    Commands.layer,
    Report.layer,
    Layer.provideMerge(Modes.layer, HandlerStack.layer),
    Layer.provideMerge(Realm.layer, Dom.layer),
    settingsOf(options.settings ?? {}),
    exclusionsOf(options.exclusion ?? FULLY_ENABLED),
    mappingsOf(options.mappings),
  );
  return Layer.provideMerge(Keyboard.layer, support);
};

/** Register a body for each command that a test maps, and record every call. */
const recorder = Effect.fn("recorder")(function*(
  names: readonly string[],
) {
  const commands = yield* Commands;
  const calls = yield* Ref.make<readonly string[]>([]);
  for (const name of names) {
    // The cast is the catalogue's own key type; the list comes from a test.
    yield* commands.register(
      name as Parameters<typeof commands.register>[0],
      ({ count }) =>
        Ref.update(calls, (current) => [...current, `${name}:${count}`]),
    );
  }
  return calls;
});

describe("Keyboard", () => {
  describe("synthetic events", () => {
    it.effect("ignores a keydown that the page dispatched", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder(["scrollDown"]);

        const press = new Press("j", { isTrusted: false });
        const toPage = yield* stack.bubble("keydown", asEvent(press));

        assert.deepEqual(yield* Ref.get(calls), []);
        // The page made the event, so the page keeps it.
        assert.isTrue(toPage);
        assert.isFalse(press.defaultPrevented);
      }).pipe(Effect.provide(layerFor({ mappings: "map j scrollDown" }))));

    it.effect("ignores a synthetic key in the middle of a sequence", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder(["scrollToTop"]);

        yield* stack.bubble("keydown", asEvent(new Press("g")));
        yield* stack.bubble(
          "keydown",
          asEvent(new Press("g", { isTrusted: false })),
        );
        assert.deepEqual(yield* Ref.get(calls), []);

        // The true key still completes the sequence that the user typed.
        yield* stack.bubble("keydown", asEvent(new Press("g")));
        assert.deepEqual(yield* Ref.get(calls), ["scrollToTop:1"]);
      }).pipe(Effect.provide(layerFor({ mappings: "map gg scrollToTop" }))));

    it.effect("ignores a keyup that the page dispatched", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        yield* recorder(["scrollDown"]);

        // A true press, so that the release of `KeyJ` is one that we took.
        yield* stack.bubble("keydown", asEvent(new Press("j")));

        const release = new Press("j", { isTrusted: false });
        const toPage = yield* stack.bubble("keyup", asEvent(release));

        assert.isTrue(toPage);
        assert.isFalse(release.propagationStopped);
      }).pipe(Effect.provide(layerFor({ mappings: "map j scrollDown" }))));

    it.effect("still runs a command for a key that the user pressed", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder(["scrollDown"]);

        const press = new Press("j");
        const toPage = yield* stack.bubble("keydown", asEvent(press));

        assert.deepEqual(yield* Ref.get(calls), ["scrollDown:1"]);
        assert.isFalse(toPage);
        assert.isTrue(press.defaultPrevented);
      }).pipe(Effect.provide(layerFor({ mappings: "map j scrollDown" }))));
  });

  /**
   * A binding that is also the prefix of a longer one.
   *
   * The dispatcher accepts it and waits. The next key decides: it extends the
   * sequence, or the accepted binding runs and the key starts again at the
   * root.
   */
  describe("a prefix that is bound", () => {
    const prefixMappings = [
      "map g scrollUp",
      "map gg scrollToTop",
      "map j scrollDown",
    ].join("\n");

    const prefixLayer = layerFor({ mappings: prefixMappings });

    it.effect("runs the longer mapping when the user completes it", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder([
          "scrollUp",
          "scrollToTop",
          "scrollDown",
        ]);

        yield* stack.bubble("keydown", asEvent(new Press("g")));
        assert.deepEqual(yield* Ref.get(calls), []);

        yield* stack.bubble("keydown", asEvent(new Press("g")));
        assert.deepEqual(yield* Ref.get(calls), ["scrollToTop:1"]);
      }).pipe(Effect.provide(prefixLayer)));

    it.effect("runs the prefix when a mapped key follows it", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder([
          "scrollUp",
          "scrollToTop",
          "scrollDown",
        ]);

        yield* stack.bubble("keydown", asEvent(new Press("g")));
        yield* stack.bubble("keydown", asEvent(new Press("j")));

        // `g` ran, and `j` then started a sequence of its own.
        assert.deepEqual(yield* Ref.get(calls), [
          "scrollUp:1",
          "scrollDown:1",
        ]);
      }).pipe(Effect.provide(prefixLayer)));

    it.effect("runs the prefix when an unmapped key follows it", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder([
          "scrollUp",
          "scrollToTop",
          "scrollDown",
        ]);

        yield* stack.bubble("keydown", asEvent(new Press("g")));
        const stray = new Press("x");
        const toPage = yield* stack.bubble("keydown", asEvent(stray));

        assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);
        // The sequence is over, so the key that ended it belongs to the page.
        assert.isTrue(toPage);
      }).pipe(Effect.provide(prefixLayer)));

    it.effect("gives the prefix the count that the user typed", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder([
          "scrollUp",
          "scrollToTop",
          "scrollDown",
        ]);

        yield* stack.bubble(
          "keydown",
          asEvent(
            new Press("3", {
              code: "Digit3",
            }),
          ),
        );
        yield* stack.bubble("keydown", asEvent(new Press("g")));
        yield* stack.bubble("keydown", asEvent(new Press("j")));

        // The count belongs to the binding that the user typed it in front of.
        // The key that ends the sequence starts a count of its own.
        assert.deepEqual(yield* Ref.get(calls), [
          "scrollUp:3",
          "scrollDown:1",
        ]);
      }).pipe(Effect.provide(prefixLayer)));

    it.effect("lets a digit start a count again after the prefix ran", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder([
          "scrollUp",
          "scrollToTop",
          "scrollDown",
        ]);

        yield* stack.bubble("keydown", asEvent(new Press("g")));
        yield* stack.bubble(
          "keydown",
          asEvent(
            new Press("2", {
              code: "Digit2",
            }),
          ),
        );
        assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);

        yield* stack.bubble("keydown", asEvent(new Press("j")));
        assert.deepEqual(yield* Ref.get(calls), [
          "scrollUp:1",
          "scrollDown:2",
        ]);
      }).pipe(Effect.provide(prefixLayer)));

    it.effect("keeps a binding that a deeper step accepted none", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder(["scrollUp", "scrollToTop"]);

        // `ab` is a prefix of `abc` and carries no binding of its own, so the
        // binding on `a` must survive the second key.
        yield* stack.bubble("keydown", asEvent(new Press("a")));
        yield* stack.bubble("keydown", asEvent(new Press("b")));
        assert.deepEqual(yield* Ref.get(calls), []);

        yield* stack.bubble("keydown", asEvent(new Press("x")));
        assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);
      }).pipe(Effect.provide(layerFor({
        mappings: "map a scrollUp\nmap abc scrollToTop",
      }))));
  });
});
