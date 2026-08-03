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
import { Exclusions } from "~/core/Exclusions.ts";
import { HandlerStack } from "~/core/HandlerStack.ts";
import { Keyboard } from "~/core/Keyboard.ts";
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

/** A focus event. Normal mode reads nothing from it. */
const asFocus = (): FocusEvent => ({}) as unknown as FocusEvent;

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

    it.effect("drops the count when the focus moves", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder([
          "scrollUp",
          "scrollToTop",
          "scrollDown",
        ]);

        // The count and the focus reset meet here. The indicator showed `5`,
        // and the reset takes the count away with the keys.
        yield* stack.bubble(
          "keydown",
          asEvent(new Press("5", { code: "Digit5" })),
        );
        yield* stack.bubble("focus", asFocus());
        yield* stack.bubble("keydown", asEvent(new Press("j")));

        assert.deepEqual(yield* Ref.get(calls), ["scrollDown:1"]);
      }).pipe(Effect.provide(prefixLayer)));

    it.effect("drops the accepted binding when the focus moves", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder([
          "scrollUp",
          "scrollToTop",
          "scrollDown",
        ]);

        yield* stack.bubble("keydown", asEvent(new Press("g")));
        // The user clicks a text field. Insert mode takes the keys, and this
        // half-typed sequence is over.
        yield* stack.bubble("focus", asFocus());
        yield* stack.bubble("keydown", asEvent(new Press("j")));

        assert.deepEqual(yield* Ref.get(calls), ["scrollDown:1"]);
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

    /**
     * Three mappings that overlap: `a`, `abc` and `b`.
     *
     * The key `b` after `a` opens two nodes. The node `ab` carries on the
     * sequence, and the node `b` starts a new one. The binding of `b` must not
     * take the place of the binding that `a` accepted.
     */
    describe("a root restart under an accepted binding", () => {
      const overlapping = [
        "map a scrollUp",
        "map abc scrollToTop",
        "map b scrollDown",
      ].join("\n");

      const overlappingLayer = layerFor({ mappings: overlapping });
      const names = ["scrollUp", "scrollToTop", "scrollDown"];

      it.effect("runs the binding that the first key accepted", () =>
        Effect.gen(function*() {
          const stack = yield* HandlerStack;
          const calls = yield* recorder(names);

          yield* stack.bubble("keydown", asEvent(new Press("a")));
          yield* stack.bubble("keydown", asEvent(new Press("b")));
          yield* stack.bubble("keydown", asEvent(new Press("x")));

          // `b` was part of the attempt at `abc`, so only `a` runs.
          assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);
        }).pipe(Effect.provide(overlappingLayer)));

      it.effect("still runs the longest sequence when the user finishes it", () =>
        Effect.gen(function*() {
          const stack = yield* HandlerStack;
          const calls = yield* recorder(names);

          yield* stack.bubble("keydown", asEvent(new Press("a")));
          yield* stack.bubble("keydown", asEvent(new Press("b")));
          yield* stack.bubble("keydown", asEvent(new Press("c")));

          assert.deepEqual(yield* Ref.get(calls), ["scrollToTop:1"]);
        }).pipe(Effect.provide(overlappingLayer)));

      it.effect("still runs the new sequence when nothing is accepted", () =>
        Effect.gen(function*() {
          const stack = yield* HandlerStack;
          const calls = yield* recorder(names);

          yield* stack.bubble("keydown", asEvent(new Press("b")));

          assert.deepEqual(yield* Ref.get(calls), ["scrollDown:1"]);
        }).pipe(Effect.provide(overlappingLayer)));

      it.effect("gives the accepted binding the count that came first", () =>
        Effect.gen(function*() {
          const stack = yield* HandlerStack;
          const calls = yield* recorder(names);

          // The count, the accepted binding and the root restart meet here.
          yield* stack.bubble(
            "keydown",
            asEvent(new Press("2", { code: "Digit2" })),
          );
          yield* stack.bubble("keydown", asEvent(new Press("a")));
          yield* stack.bubble("keydown", asEvent(new Press("b")));
          yield* stack.bubble("keydown", asEvent(new Press("x")));

          // The count belongs to `a`, and `b` did not start a count of its own.
          assert.deepEqual(yield* Ref.get(calls), ["scrollUp:2"]);
        }).pipe(Effect.provide(overlappingLayer)));

      it.effect("lets Escape cancel the accepted binding", () =>
        Effect.gen(function*() {
          const stack = yield* HandlerStack;
          const calls = yield* recorder(names);

          yield* stack.bubble("keydown", asEvent(new Press("a")));
          yield* stack.bubble("keydown", asEvent(new Press("b")));
          const escape = new Press("Escape", { code: "Escape" });
          const toPage = yield* stack.bubble("keydown", asEvent(escape));

          // Escape ends the attempt. It runs nothing, and it stays with us.
          assert.deepEqual(yield* Ref.get(calls), []);
          assert.isFalse(toPage);

          // The state is clean, so the next key starts a sequence of its own.
          yield* stack.bubble("keydown", asEvent(new Press("b")));
          assert.deepEqual(yield* Ref.get(calls), ["scrollDown:1"]);
        }).pipe(Effect.provide(overlappingLayer)));
    });

    /**
     * The accepted binding belongs to the branch that accepted it.
     *
     * A branch is one live attempt at a mapping. It starts when the root opens
     * a child. It dies when its node has no child for the next key, and its
     * accepted binding dies with it. When every branch dies, the accepted
     * binding of the branch that lived longest runs.
     */
    describe("an accepted binding that belongs to a branch", () => {
      const names = ["scrollUp", "scrollToTop", "scrollLeft"];

      it.effect("keeps the binding of the branch that lived longest", () =>
        Effect.gen(function*() {
          const stack = yield* HandlerStack;
          const calls = yield* recorder(names);

          // `c` opens `bc`, which is one key deep and carries `scrollLeft`. The
          // attempt at `abcd` is deeper, and it accepted `scrollUp` at `ab`.
          yield* stack.bubble("keydown", asEvent(new Press("a")));
          yield* stack.bubble("keydown", asEvent(new Press("b")));
          yield* stack.bubble("keydown", asEvent(new Press("c")));
          yield* stack.bubble("keydown", asEvent(new Press("x")));

          assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);
        }).pipe(Effect.provide(layerFor({
          mappings: [
            "map ab scrollUp",
            "map abcd scrollToTop",
            "map bc scrollLeft",
          ].join("\n"),
        }))));

      /**
       * The branch `ab` dies at the third key, because `abc` is bound nowhere.
       * The binding that `a` accepted dies with that branch. The branch `bc`
       * lives on, so it alone decides what the next keys do.
       */
      describe("a binding whose branch died", () => {
        const deadBranch = layerFor({
          mappings: [
            "map a scrollUp",
            "map abz scrollToTop",
            "map bcd scrollLeft",
          ].join("\n"),
        });

        it.effect("does not run two keys later", () =>
          Effect.gen(function*() {
            const stack = yield* HandlerStack;
            const calls = yield* recorder(names);

            yield* stack.bubble("keydown", asEvent(new Press("a")));
            yield* stack.bubble("keydown", asEvent(new Press("b")));
            yield* stack.bubble("keydown", asEvent(new Press("c")));
            yield* stack.bubble("keydown", asEvent(new Press("x")));

            // `scrollUp` died at `c`, and `bcd` accepted nothing.
            assert.deepEqual(yield* Ref.get(calls), []);
          }).pipe(Effect.provide(deadBranch)));

        it.effect("leaves the live branch to finish its own mapping", () =>
          Effect.gen(function*() {
            const stack = yield* HandlerStack;
            const calls = yield* recorder(names);

            yield* stack.bubble("keydown", asEvent(new Press("a")));
            yield* stack.bubble("keydown", asEvent(new Press("b")));
            yield* stack.bubble("keydown", asEvent(new Press("c")));
            yield* stack.bubble("keydown", asEvent(new Press("d")));

            // The single slot gave this answer as well, so this test holds
            // before the branch model and after it. It is here because the two
            // tests together are the point: the accepted binding of a dead
            // branch must never decide, whichever key comes next.
            assert.deepEqual(yield* Ref.get(calls), ["scrollLeft:1"]);
          }).pipe(Effect.provide(deadBranch)));
      });

      /**
       * Two dead branches, at two depths, and only one of them holds a binding.
       *
       * The branch `ab` accepted nothing, and it is the deeper of the two. The
       * branch `b` accepted `scrollDown`, and it is one key deep. The key `x`
       * kills both. The deepest one lived longest, so it decides, and it runs
       * no command. The shallower one goes in silence.
       */
      describe("two dead branches at two depths", () => {
        const uneven = layerFor({
          mappings: [
            "map abz scrollToTop",
            "map b scrollDown",
            "map bz scrollLeft",
          ].join("\n"),
        });

        const unevenNames = ["scrollToTop", "scrollDown", "scrollLeft"];

        it.effect("drops a shallower dead branch that holds a binding", () =>
          Effect.gen(function*() {
            const stack = yield* HandlerStack;
            const calls = yield* recorder(unevenNames);

            yield* stack.bubble("keydown", asEvent(new Press("a")));
            yield* stack.bubble("keydown", asEvent(new Press("b")));
            const stray = new Press("x");
            yield* stack.bubble("keydown", asEvent(stray));

            // The deepest dead branch decides, and it accepted nothing.
            assert.deepEqual(yield* Ref.get(calls), []);
            // The key ended a half-typed sequence, so it stays with us.
            assert.isTrue(stray.defaultPrevented);
          }).pipe(Effect.provide(uneven)));

        it.effect("runs the shallower binding when it is the only branch", () =>
          Effect.gen(function*() {
            const stack = yield* HandlerStack;
            const calls = yield* recorder(unevenNames);

            // The same keys with no `a` in front. The branch `b` is then the
            // only one, so its binding runs. The pair of tests shows that the
            // depth alone decides in the test above.
            yield* stack.bubble("keydown", asEvent(new Press("b")));
            yield* stack.bubble("keydown", asEvent(new Press("x")));

            assert.deepEqual(yield* Ref.get(calls), ["scrollDown:1"]);
          }).pipe(Effect.provide(uneven)));
      });
    });
  });

  /**
   * The count prefix is a half-typed command of its own.
   *
   * A digit starts a sequence, exactly as a key prefix does. Every rule that
   * asks whether the user is at the root therefore reads the count as well.
   */
  describe("a count in front of a key", () => {
    it.effect("keeps a stray key away from the page", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder(["scrollDown"]);

        yield* stack.bubble(
          "keydown",
          asEvent(new Press("5", { code: "Digit5" })),
        );
        const stray = new Press("x");
        const toPage = yield* stack.bubble("keydown", asEvent(stray));

        // The count made this key part of a half-typed command. The user is
        // in the middle of a sequence, so the page must not see the key.
        assert.isFalse(toPage);
        assert.isTrue(stray.defaultPrevented);
        assert.deepEqual(yield* Ref.get(calls), []);

        // The stray key ended the count, so the next key counts as one.
        yield* stack.bubble("keydown", asEvent(new Press("j")));
        assert.deepEqual(yield* Ref.get(calls), ["scrollDown:1"]);
      }).pipe(Effect.provide(layerFor({ mappings: "map j scrollDown" }))));

    it.effect("takes a pass key that a count starts", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder(["scrollDown"]);

        // The user gave `j` to the page, so `j` alone goes to the page.
        const promised = new Press("j");
        assert.isTrue(yield* stack.bubble("keydown", asEvent(promised)));
        assert.isFalse(promised.defaultPrevented);
        assert.deepEqual(yield* Ref.get(calls), []);

        yield* stack.bubble(
          "keydown",
          asEvent(new Press("3", { code: "Digit3" })),
        );
        const ours = new Press("j");
        const toPage = yield* stack.bubble("keydown", asEvent(ours));

        // The count started a sequence, so the pass rule no longer applies.
        assert.deepEqual(yield* Ref.get(calls), ["scrollDown:3"]);
        assert.isFalse(toPage);
        assert.isTrue(ours.defaultPrevented);
      }).pipe(Effect.provide(layerFor({
        mappings: "map j scrollDown",
        exclusion: { enabled: true, passKeys: "j" },
      }))));
  });

  /**
   * The key that ends a sequence starts again at the root.
   *
   * A pass key, a media key and the pass counter all apply to a first key
   * only. The key that ends a sequence becomes a first key, so every one of
   * those rules must read it again.
   */
  describe("a key that restarts at the root", () => {
    it.effect("goes to the page when the exclusion names it", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder([
          "scrollUp",
          "scrollToTop",
          "scrollDown",
        ]);

        yield* stack.bubble("keydown", asEvent(new Press("g")));
        const promised = new Press("j");
        const toPage = yield* stack.bubble("keydown", asEvent(promised));

        // `g` ran, because the sequence ended. `j` belongs to the page, and
        // the user promised it before any of this.
        assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);
        assert.isTrue(toPage);
        assert.isFalse(promised.defaultPrevented);
      }).pipe(Effect.provide(layerFor({
        mappings: [
          "map g scrollUp",
          "map gg scrollToTop",
          "map j scrollDown",
        ].join("\n"),
        exclusion: { enabled: true, passKeys: "j" },
      }))));

    it.effect("is the key that a deferred passNextKey passes", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const keyboard = yield* Keyboard;
        const commands = yield* Commands;
        const calls = yield* recorder(["scrollToTop", "scrollDown"]);

        // The real body, because the point of the test is the order. The
        // counter must hold the pass before the next key is read.
        yield* commands.register(
          "passNextKey",
          ({ count }) =>
            Effect.andThen(
              Ref.update(calls, (current) => [
                ...current,
                `passNextKey:${count}`,
              ]),
              keyboard.passNextKey(count),
            ),
        );

        yield* stack.bubble("keydown", asEvent(new Press("g")));
        const passed = new Press("x");
        const toPage = yield* stack.bubble("keydown", asEvent(passed));

        // `x` is the key after the command, so `x` is the key that passes.
        assert.deepEqual(yield* Ref.get(calls), ["passNextKey:1"]);
        assert.isTrue(toPage);
        assert.isFalse(passed.defaultPrevented);

        // The counter held one pass, and `x` used it.
        yield* stack.bubble("keydown", asEvent(new Press("x")));
        assert.deepEqual(yield* Ref.get(calls), [
          "passNextKey:1",
          "scrollDown:1",
        ]);
      }).pipe(Effect.provide(layerFor({
        mappings: [
          "map g passNextKey",
          "map gg scrollToTop",
          "map x scrollDown",
        ].join("\n"),
      }))));

    it.effect("passes as many keys as the count in front of the command", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const keyboard = yield* Keyboard;
        const commands = yield* Commands;
        const calls = yield* recorder(["scrollToTop", "scrollDown"]);

        yield* commands.register(
          "passNextKey",
          ({ count }) =>
            Effect.andThen(
              Ref.update(calls, (current) => [
                ...current,
                `passNextKey:${count}`,
              ]),
              keyboard.passNextKey(count),
            ),
        );

        // The count, the accepted binding and the pass counter meet here.
        yield* stack.bubble(
          "keydown",
          asEvent(new Press("2", { code: "Digit2" })),
        );
        yield* stack.bubble("keydown", asEvent(new Press("g")));

        // `x` ends the sequence, so it is the first of the two keys that pass.
        const first = new Press("x");
        assert.isTrue(yield* stack.bubble("keydown", asEvent(first)));
        assert.isFalse(first.defaultPrevented);
        assert.isTrue(
          yield* stack.bubble("keydown", asEvent(new Press("x"))),
        );
        assert.deepEqual(yield* Ref.get(calls), ["passNextKey:2"]);

        // The counter is spent, so the third `x` is ours again.
        yield* stack.bubble("keydown", asEvent(new Press("x")));
        assert.deepEqual(yield* Ref.get(calls), [
          "passNextKey:2",
          "scrollDown:1",
        ]);
      }).pipe(Effect.provide(layerFor({
        mappings: [
          "map g passNextKey",
          "map gg scrollToTop",
          "map x scrollDown",
        ].join("\n"),
      }))));

    it.effect("keeps the promise to pass when the focus moves", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const keyboard = yield* Keyboard;
        const commands = yield* Commands;
        const calls = yield* recorder(["scrollDown"]);

        yield* commands.register(
          "passNextKey",
          ({ count }) => keyboard.passNextKey(count),
        );

        yield* stack.bubble("keydown", asEvent(new Press("p")));
        // The focus reset ends a half-typed sequence. The promise to give one
        // key to the page is not a half-typed sequence, so it stands.
        yield* stack.bubble("focus", asFocus());

        const promised = new Press("j");
        const toPage = yield* stack.bubble("keydown", asEvent(promised));
        assert.isTrue(toPage);
        assert.isFalse(promised.defaultPrevented);
        assert.deepEqual(yield* Ref.get(calls), []);
      }).pipe(Effect.provide(layerFor({
        mappings: "map p passNextKey\nmap j scrollDown",
      }))));
  });

  /**
   * `mapkey` and the keys that belong to the page.
   *
   * An exclusion rule names a *physical* key, because the user gives that key
   * to the page. `mapkey` says what the key does for us, which is a later
   * question. The order of the two decides who gets the keystroke.
   */
  describe("a remapped key", () => {
    const remap = "map k scrollUp\nmap j scrollDown\nmapkey j k";

    it.effect("still goes to the page when the exclusion names it", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder(["scrollUp", "scrollDown"]);

        const press = new Press("j");
        const toPage = yield* stack.bubble("keydown", asEvent(press));

        assert.deepEqual(yield* Ref.get(calls), []);
        assert.isTrue(toPage);
        assert.isFalse(press.defaultPrevented);
      }).pipe(Effect.provide(layerFor({
        mappings: remap,
        exclusion: { enabled: true, passKeys: "j" },
      }))));

    it.effect("runs its command when the exclusion names the target key", () =>
      Effect.gen(function*() {
        const stack = yield* HandlerStack;
        const calls = yield* recorder(["scrollUp", "scrollDown"]);

        // The user gave `k` to the page, and `j` is not `k`.
        yield* stack.bubble("keydown", asEvent(new Press("j")));
        assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);

        // The physical `k` is the one that the page keeps.
        const kept = new Press("k");
        const toPage = yield* stack.bubble("keydown", asEvent(kept));
        assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);
        assert.isTrue(toPage);
      }).pipe(Effect.provide(layerFor({
        mappings: remap,
        exclusion: { enabled: true, passKeys: "k" },
      }))));
  });
});
