/**
 * Normal mode: the dispatch path from one key to one command.
 *
 * The tests build the real `Keyboard`, `Modes`, `Commands` and `Report`
 * layers. `Settings`, `Mappings` and `Exclusions` are stubs, because a test
 * decides what the user configured. Nothing here writes to a global.
 *
 * Node has no `KeyboardEvent`, and no script can make a trusted one, so a test
 * presses a double of its own. The double is a whole `KeyboardEvent`. A test
 * chooses the fields that the key path reads, and the rest are the values of a
 * plain event. The mode stack only calls `preventDefault` and
 * `stopImmediatePropagation`, and the double records both.
 */

import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Layer, Option, Ref, Stream, pipe } from "effect";
import { Commands } from "~/core/Commands.ts";
import { Exclusions, Verdict } from "~/core/Exclusions.ts";
import { Keyboard } from "~/core/Keyboard.ts";
import { Mappings } from "~/core/Mappings.ts";
import { Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import type { CommandName } from "~/domain/Command.ts";
import { EffectiveRule, FULLY_ENABLED } from "~/domain/Exclusion.ts";
import { compileMappings } from "~/domain/Mapping.ts";
import { defaultSettings, type Settings as SettingsData } from "~/domain/Persisted.ts";
import { Capabilities, type CapabilityReport } from "~/platform/Capabilities.ts";
import { StoreKind } from "~/platform/Gm.ts";
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
  readonly altKey?: boolean;
  /** The legacy code. It carries the character of the layout on macOS. */
  readonly keyCode?: number;
}

/**
 * Every member of a `UIEvent`, with the values of a plain event.
 *
 * `defaultPrevented` and `propagationStopped` record what the mode stack
 * did to the event.
 */
class UiEventDouble implements UIEvent {
  readonly bubbles = true;
  cancelBubble = false;
  readonly cancelable = true;
  readonly composed = true;
  readonly currentTarget = null;
  defaultPrevented = false;
  readonly eventPhase = 0;
  returnValue = true;
  readonly srcElement = null;
  readonly target = null;
  readonly timeStamp = 0;
  readonly detail = 0;
  readonly view = null;
  readonly which = 0;
  readonly NONE = 0;
  readonly CAPTURING_PHASE = 1;
  readonly AT_TARGET = 2;
  readonly BUBBLING_PHASE = 3;
  propagationStopped = false;

  constructor(
    readonly type: string,
    readonly isTrusted: boolean,
  ) {}

  composedPath(): EventTarget[] {
    return [];
  }

  initEvent(): void {}

  initUIEvent(): void {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true;
  }

  stopPropagation(): void {}
}

/** A pressed key. `keyCode` is `0` when a test gives none, as for a key with no code. */
class Press extends UiEventDouble implements KeyboardEvent {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly keyCode: number;
  readonly metaKey = false;
  readonly isComposing = false;
  readonly repeat = false;
  readonly charCode = 0;
  readonly location = 0;
  readonly DOM_KEY_LOCATION_STANDARD = 0;
  readonly DOM_KEY_LOCATION_LEFT = 1;
  readonly DOM_KEY_LOCATION_RIGHT = 2;
  readonly DOM_KEY_LOCATION_NUMPAD = 3;

  constructor(key: string, options: PressOptions = {}) {
    super("keydown", options.isTrusted ?? true);
    this.key = key;
    this.code = options.code ?? `Key${key.toUpperCase()}`;
    this.ctrlKey = options.ctrlKey ?? false;
    this.shiftKey = options.shiftKey ?? false;
    this.altKey = options.altKey ?? false;
    this.keyCode = options.keyCode ?? 0;
  }

  getModifierState(): boolean {
    return false;
  }

  initKeyboardEvent(): void {}
}

/** A focus event. Normal mode reads nothing from it. */
class Focus extends UiEventDouble implements FocusEvent {
  readonly relatedTarget = null;

  constructor() {
    super("focus", true);
  }
}

// ---------------------------------------------------------------------------
// The layers
// ---------------------------------------------------------------------------

/** The compiled mappings of one source, with no defaults under them. */
const mappingsOf = (source: string): Layer.Layer<Mappings> =>
  Layer.sync(Mappings, () => {
    const compiled = compileMappings(source, {
      rejectReservedShortcuts: false,
    });
    return Mappings.of({
      compiledUnsafe: () => compiled,
      changes: Stream.make(compiled),
      check: () => Effect.succeed(compiled),
    });
  });

const settingsOf = (data: SettingsData): Layer.Layer<Settings> =>
  Layer.sync(Settings, () =>
    Settings.of({
      current: Effect.succeed(data),
      currentUnsafe: () => data,
      changes: Stream.make(data),
      save: (next) => Effect.succeed(next),
      reload: Effect.succeed(data),
    }),
  );

/** A verdict that keeps us on, and gives the page `passKeys`. */
const passing = (passKeys: string): Verdict =>
  Verdict.Known({ rule: EffectiveRule.cases.Enabled.make({ passKeys }) });

const exclusionsOf = (verdict: Verdict): Layer.Layer<Exclusions> =>
  Layer.sync(Exclusions, () =>
    Exclusions.of({
      current: Effect.succeed(verdict),
      currentUnsafe: () => verdict,
      changes: Stream.make(verdict),
      known: Effect.void,
      refresh: Effect.void,
      resolveLocal: Effect.succeed(FULLY_ENABLED),
      match: () => Effect.succeed(FULLY_ENABLED),
    }),
  );

/**
 * The capability report, with one flag that a test chooses.
 *
 * The key path reads `applePlatform` only. Every other flag is `false`, so a
 * test that reads one of them fails instead of passing by accident.
 */
const capabilitiesOf = (applePlatform: boolean): Layer.Layer<Capabilities> =>
  Layer.sync(Capabilities, () => {
    const report = {
      manager: "unknown",
      managerVersion: Option.none(),
      scriptVersion: Option.none(),
      world: "unknown",
      value: StoreKind.Memory(),
      openInTab: false,
      setClipboard: false,
      windowClose: false,
      adoptedStyleSheets: false,
      checkVisibility: false,
      composedRanges: false,
      selectionModify: false,
      clipboardWrite: false,
      webkitLike: false,
      applePlatform,
    } satisfies CapabilityReport;
    return Capabilities.of(report);
  });

interface Options {
  readonly mappings: string;
  readonly settings?: SettingsData;
  readonly verdict?: Verdict;
  /** macOS, iOS or iPadOS. It changes the reading of an Option chord. */
  readonly applePlatform?: boolean;
}

/**
 * `Keyboard` over its dependencies, with `Modes` and `Commands` exposed.
 *
 * A test needs the mode stack to deliver a key, and the registry to record what the
 * key ran.
 */
const layerFor = (options: Options): Layer.Layer<Commands | Keyboard | Modes> => {
  const support = Layer.mergeAll(
    Commands.layer,
    Report.layer,
    capabilitiesOf(options.applePlatform ?? false),
    Modes.layer,
    Layer.provideMerge(Realm.layer, Dom.layer),
    settingsOf(options.settings ?? defaultSettings()),
    exclusionsOf(options.verdict ?? Verdict.Known({ rule: FULLY_ENABLED })),
    mappingsOf(options.mappings),
  );
  return Layer.provideMerge(Keyboard.layer, support);
};

/** Register a body for each command that a test maps, and record every call. */
const recorder = Effect.fn("recorder")(function* (names: ReadonlyArray<CommandName>) {
  const commands = yield* Commands;
  const calls = yield* Ref.make<readonly string[]>([]);
  yield* pipe(
    names,
    Effect.forEach(
      (name) =>
        commands.register(name, ({ count }) =>
          pipe(calls, Ref.update(Array.append(`${name}:${count}`))),
        ),
      { discard: true },
    ),
  );
  return calls;
});

describe("Keyboard", () => {
  /**
   * An Option chord, from the key of the user to the command.
   *
   * The values are measured, and they are the same rows as in
   * `test/unit/key_test.ts`. The platform decides: on macOS `<a-f>` is the F
   * key of the layout, and on Linux `Alt+\u0444` is the Cyrillic letter.
   */
  describe("an Option chord", () => {
    it.effect("runs the command for the F key of a Dvorak layout", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollDown"]);

          // The F key of a Dvorak layout sits at the US Y position.
          const press = new Press("\u0192", {
            code: "KeyY",
            keyCode: 70,
            altKey: true,
          });
          yield* modes.bubble("keydown", press);

          assert.deepEqual(yield* Ref.get(calls), ["scrollDown:1"]);
        }),
        Effect.provide(
          layerFor({
            mappings: "map <a-f> scrollDown",
            applePlatform: true,
          }),
        ),
      ),
    );

    it.effect("leaves a Cyrillic Alt chord to its own letter", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollDown", "scrollUp"]);

          // `Alt+\u0444` on Linux. The letter of the user must win, and the
          // letter of the US position must not.
          const press = new Press("\u0444", {
            code: "KeyA",
            keyCode: 65,
            altKey: true,
          });
          yield* modes.bubble("keydown", press);

          assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);
        }),
        Effect.provide(
          layerFor({
            mappings: "map <a-a> scrollDown\nmap <a-\u0444> scrollUp",
            applePlatform: false,
          }),
        ),
      ),
    );
  });

  describe("synthetic events", () => {
    it.effect("ignores a keydown that the page dispatched", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollDown"]);

          const press = new Press("j", { isTrusted: false });
          const toPage = yield* modes.bubble("keydown", press);

          assert.deepEqual(yield* Ref.get(calls), []);
          // The page made the event, so the page keeps it.
          assert.isTrue(toPage);
          assert.isFalse(press.defaultPrevented);
        }),
        Effect.provide(layerFor({ mappings: "map j scrollDown" })),
      ),
    );

    it.effect("ignores a synthetic key in the middle of a sequence", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollToTop"]);

          yield* modes.bubble("keydown", new Press("g"));
          yield* modes.bubble("keydown", new Press("g", { isTrusted: false }));
          assert.deepEqual(yield* Ref.get(calls), []);

          // The true key still completes the sequence that the user typed.
          yield* modes.bubble("keydown", new Press("g"));
          assert.deepEqual(yield* Ref.get(calls), ["scrollToTop:1"]);
        }),
        Effect.provide(layerFor({ mappings: "map gg scrollToTop" })),
      ),
    );

    it.effect("ignores a keyup that the page dispatched", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          yield* recorder(["scrollDown"]);

          // A true press, so that the release of `KeyJ` is one that we took.
          yield* modes.bubble("keydown", new Press("j"));

          const release = new Press("j", { isTrusted: false });
          const toPage = yield* modes.bubble("keyup", release);

          assert.isTrue(toPage);
          assert.isFalse(release.propagationStopped);
        }),
        Effect.provide(layerFor({ mappings: "map j scrollDown" })),
      ),
    );

    it.effect("still runs a command for a key that the user pressed", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollDown"]);

          const press = new Press("j");
          const toPage = yield* modes.bubble("keydown", press);

          assert.deepEqual(yield* Ref.get(calls), ["scrollDown:1"]);
          assert.isFalse(toPage);
          assert.isTrue(press.defaultPrevented);
        }),
        Effect.provide(layerFor({ mappings: "map j scrollDown" })),
      ),
    );
  });

  /**
   * A verdict that keeps us off the keys.
   *
   * The page keeps every key while the user excluded it, and while a child
   * frame still waits for the verdict of the top frame.
   */
  describe("a verdict that keeps us off", () => {
    const keepsEveryKey = (verdict: Verdict) =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollDown"]);

          const press = new Press("j");
          const toPage = yield* modes.bubble("keydown", press);

          assert.deepEqual(yield* Ref.get(calls), []);
          assert.isTrue(toPage);
          assert.isFalse(press.defaultPrevented);
        }),
        Effect.provide(layerFor({ mappings: "map j scrollDown", verdict })),
      );

    it.effect("leaves every key to a page that the user excluded", () =>
      keepsEveryKey(Verdict.Known({ rule: EffectiveRule.cases.Disabled.make({}) })),
    );

    it.effect("leaves every key to the page while the verdict is pending", () =>
      keepsEveryKey(Verdict.Pending()),
    );
  });

  /**
   * A binding that is also the prefix of a longer one.
   *
   * The dispatcher accepts it and waits. The next key decides: it extends the
   * sequence, or the accepted binding runs and the key starts again at the
   * root.
   */
  describe("a prefix that is bound", () => {
    const prefixMappings = ["map g scrollUp", "map gg scrollToTop", "map j scrollDown"].join("\n");

    const prefixLayer = layerFor({ mappings: prefixMappings });

    it.effect("runs the longer mapping when the user completes it", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollUp", "scrollToTop", "scrollDown"]);

          yield* modes.bubble("keydown", new Press("g"));
          assert.deepEqual(yield* Ref.get(calls), []);

          yield* modes.bubble("keydown", new Press("g"));
          assert.deepEqual(yield* Ref.get(calls), ["scrollToTop:1"]);
        }),
        Effect.provide(prefixLayer),
      ),
    );

    it.effect("runs the prefix when a mapped key follows it", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollUp", "scrollToTop", "scrollDown"]);

          yield* modes.bubble("keydown", new Press("g"));
          yield* modes.bubble("keydown", new Press("j"));

          // `g` ran, and `j` then started a sequence of its own.
          assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1", "scrollDown:1"]);
        }),
        Effect.provide(prefixLayer),
      ),
    );

    it.effect("runs the prefix when an unmapped key follows it", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollUp", "scrollToTop", "scrollDown"]);

          yield* modes.bubble("keydown", new Press("g"));
          const stray = new Press("x");
          const toPage = yield* modes.bubble("keydown", stray);

          assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);
          // The sequence is over, so the key that ended it belongs to the page.
          assert.isTrue(toPage);
        }),
        Effect.provide(prefixLayer),
      ),
    );

    it.effect("gives the prefix the count that the user typed", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollUp", "scrollToTop", "scrollDown"]);

          yield* modes.bubble(
            "keydown",
            new Press("3", {
              code: "Digit3",
            }),
          );
          yield* modes.bubble("keydown", new Press("g"));
          yield* modes.bubble("keydown", new Press("j"));

          // The count belongs to the binding that the user typed it in front of.
          // The key that ends the sequence starts a count of its own.
          assert.deepEqual(yield* Ref.get(calls), ["scrollUp:3", "scrollDown:1"]);
        }),
        Effect.provide(prefixLayer),
      ),
    );

    it.effect("lets a digit start a count again after the prefix ran", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollUp", "scrollToTop", "scrollDown"]);

          yield* modes.bubble("keydown", new Press("g"));
          yield* modes.bubble(
            "keydown",
            new Press("2", {
              code: "Digit2",
            }),
          );
          assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);

          yield* modes.bubble("keydown", new Press("j"));
          assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1", "scrollDown:2"]);
        }),
        Effect.provide(prefixLayer),
      ),
    );

    it.effect("drops the count when the focus moves", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollUp", "scrollToTop", "scrollDown"]);

          // The count and the focus reset meet here. The indicator showed `5`,
          // and the reset takes the count away with the keys.
          yield* modes.bubble("keydown", new Press("5", { code: "Digit5" }));
          yield* modes.bubble("focus", new Focus());
          yield* modes.bubble("keydown", new Press("j"));

          assert.deepEqual(yield* Ref.get(calls), ["scrollDown:1"]);
        }),
        Effect.provide(prefixLayer),
      ),
    );

    it.effect("drops the accepted binding when the focus moves", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollUp", "scrollToTop", "scrollDown"]);

          yield* modes.bubble("keydown", new Press("g"));
          // The user clicks a text field. Insert mode takes the keys, and this
          // half-typed sequence is over.
          yield* modes.bubble("focus", new Focus());
          yield* modes.bubble("keydown", new Press("j"));

          assert.deepEqual(yield* Ref.get(calls), ["scrollDown:1"]);
        }),
        Effect.provide(prefixLayer),
      ),
    );

    it.effect("keeps a binding that a deeper step accepted none", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollUp", "scrollToTop"]);

          // `ab` is a prefix of `abc` and carries no binding of its own, so the
          // binding on `a` must survive the second key.
          yield* modes.bubble("keydown", new Press("a"));
          yield* modes.bubble("keydown", new Press("b"));
          assert.deepEqual(yield* Ref.get(calls), []);

          yield* modes.bubble("keydown", new Press("x"));
          assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);
        }),
        Effect.provide(
          layerFor({
            mappings: "map a scrollUp\nmap abc scrollToTop",
          }),
        ),
      ),
    );

    /**
     * Three mappings that overlap: `a`, `abc` and `b`.
     *
     * The key `b` after `a` opens two nodes. The node `ab` carries on the
     * sequence, and the node `b` starts a new one. The binding of `b` must not
     * take the place of the binding that `a` accepted.
     */
    describe("a root restart under an accepted binding", () => {
      const overlapping = ["map a scrollUp", "map abc scrollToTop", "map b scrollDown"].join("\n");

      const overlappingLayer = layerFor({ mappings: overlapping });
      const names: ReadonlyArray<CommandName> = ["scrollUp", "scrollToTop", "scrollDown"];

      it.effect("runs the binding that the first key accepted", () =>
        pipe(
          Effect.gen(function* () {
            const modes = yield* Modes;
            const calls = yield* recorder(names);

            yield* modes.bubble("keydown", new Press("a"));
            yield* modes.bubble("keydown", new Press("b"));
            yield* modes.bubble("keydown", new Press("x"));

            // `b` was part of the attempt at `abc`, so only `a` runs.
            assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);
          }),
          Effect.provide(overlappingLayer),
        ),
      );

      it.effect("still runs the longest sequence when the user finishes it", () =>
        pipe(
          Effect.gen(function* () {
            const modes = yield* Modes;
            const calls = yield* recorder(names);

            yield* modes.bubble("keydown", new Press("a"));
            yield* modes.bubble("keydown", new Press("b"));
            yield* modes.bubble("keydown", new Press("c"));

            assert.deepEqual(yield* Ref.get(calls), ["scrollToTop:1"]);
          }),
          Effect.provide(overlappingLayer),
        ),
      );

      it.effect("still runs the new sequence when nothing is accepted", () =>
        pipe(
          Effect.gen(function* () {
            const modes = yield* Modes;
            const calls = yield* recorder(names);

            yield* modes.bubble("keydown", new Press("b"));

            assert.deepEqual(yield* Ref.get(calls), ["scrollDown:1"]);
          }),
          Effect.provide(overlappingLayer),
        ),
      );

      it.effect("gives the accepted binding the count that came first", () =>
        pipe(
          Effect.gen(function* () {
            const modes = yield* Modes;
            const calls = yield* recorder(names);

            // The count, the accepted binding and the root restart meet here.
            yield* modes.bubble("keydown", new Press("2", { code: "Digit2" }));
            yield* modes.bubble("keydown", new Press("a"));
            yield* modes.bubble("keydown", new Press("b"));
            yield* modes.bubble("keydown", new Press("x"));

            // The count belongs to `a`, and `b` did not start a count of its own.
            assert.deepEqual(yield* Ref.get(calls), ["scrollUp:2"]);
          }),
          Effect.provide(overlappingLayer),
        ),
      );

      it.effect("lets Escape cancel the accepted binding", () =>
        pipe(
          Effect.gen(function* () {
            const modes = yield* Modes;
            const calls = yield* recorder(names);

            yield* modes.bubble("keydown", new Press("a"));
            yield* modes.bubble("keydown", new Press("b"));
            const escape = new Press("Escape", { code: "Escape" });
            const toPage = yield* modes.bubble("keydown", escape);

            // Escape ends the attempt. It runs nothing, and it stays with us.
            assert.deepEqual(yield* Ref.get(calls), []);
            assert.isFalse(toPage);

            // The state is clean, so the next key starts a sequence of its own.
            yield* modes.bubble("keydown", new Press("b"));
            assert.deepEqual(yield* Ref.get(calls), ["scrollDown:1"]);
          }),
          Effect.provide(overlappingLayer),
        ),
      );
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
      const names: ReadonlyArray<CommandName> = ["scrollUp", "scrollToTop", "scrollLeft"];

      it.effect("keeps the binding of the branch that lived longest", () =>
        pipe(
          Effect.gen(function* () {
            const modes = yield* Modes;
            const calls = yield* recorder(names);

            // `c` opens `bc`, which is one key deep and carries `scrollLeft`. The
            // attempt at `abcd` is deeper, and it accepted `scrollUp` at `ab`.
            yield* modes.bubble("keydown", new Press("a"));
            yield* modes.bubble("keydown", new Press("b"));
            yield* modes.bubble("keydown", new Press("c"));
            yield* modes.bubble("keydown", new Press("x"));

            assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);
          }),
          Effect.provide(
            layerFor({
              mappings: ["map ab scrollUp", "map abcd scrollToTop", "map bc scrollLeft"].join("\n"),
            }),
          ),
        ),
      );

      /**
       * The branch `ab` dies at the third key, because `abc` is bound nowhere.
       * The binding that `a` accepted dies with that branch. The branch `bc`
       * lives on, so it alone decides what the next keys do.
       */
      describe("a binding whose branch died", () => {
        const deadBranch = layerFor({
          mappings: ["map a scrollUp", "map abz scrollToTop", "map bcd scrollLeft"].join("\n"),
        });

        it.effect("does not run two keys later", () =>
          pipe(
            Effect.gen(function* () {
              const modes = yield* Modes;
              const calls = yield* recorder(names);

              yield* modes.bubble("keydown", new Press("a"));
              yield* modes.bubble("keydown", new Press("b"));
              yield* modes.bubble("keydown", new Press("c"));
              yield* modes.bubble("keydown", new Press("x"));

              // `scrollUp` died at `c`, and `bcd` accepted nothing.
              assert.deepEqual(yield* Ref.get(calls), []);
            }),
            Effect.provide(deadBranch),
          ),
        );

        it.effect("leaves the live branch to finish its own mapping", () =>
          pipe(
            Effect.gen(function* () {
              const modes = yield* Modes;
              const calls = yield* recorder(names);

              yield* modes.bubble("keydown", new Press("a"));
              yield* modes.bubble("keydown", new Press("b"));
              yield* modes.bubble("keydown", new Press("c"));
              yield* modes.bubble("keydown", new Press("d"));

              // The single slot gave this answer as well, so this test holds
              // before the branch model and after it. It is here because the two
              // tests together are the point: the accepted binding of a dead
              // branch must never decide, whichever key comes next.
              assert.deepEqual(yield* Ref.get(calls), ["scrollLeft:1"]);
            }),
            Effect.provide(deadBranch),
          ),
        );
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
          mappings: ["map abz scrollToTop", "map b scrollDown", "map bz scrollLeft"].join("\n"),
        });

        const unevenNames: ReadonlyArray<CommandName> = ["scrollToTop", "scrollDown", "scrollLeft"];

        it.effect("drops a shallower dead branch that holds a binding", () =>
          pipe(
            Effect.gen(function* () {
              const modes = yield* Modes;
              const calls = yield* recorder(unevenNames);

              yield* modes.bubble("keydown", new Press("a"));
              yield* modes.bubble("keydown", new Press("b"));
              const stray = new Press("x");
              yield* modes.bubble("keydown", stray);

              // The deepest dead branch decides, and it accepted nothing.
              assert.deepEqual(yield* Ref.get(calls), []);
              // The key ended a half-typed sequence, so it stays with us.
              assert.isTrue(stray.defaultPrevented);
            }),
            Effect.provide(uneven),
          ),
        );

        it.effect("runs the shallower binding when it is the only branch", () =>
          pipe(
            Effect.gen(function* () {
              const modes = yield* Modes;
              const calls = yield* recorder(unevenNames);

              // The same keys with no `a` in front. The branch `b` is then the
              // only one, so its binding runs. The pair of tests shows that the
              // depth alone decides in the test above.
              yield* modes.bubble("keydown", new Press("b"));
              yield* modes.bubble("keydown", new Press("x"));

              assert.deepEqual(yield* Ref.get(calls), ["scrollDown:1"]);
            }),
            Effect.provide(uneven),
          ),
        );
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
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollDown"]);

          yield* modes.bubble("keydown", new Press("5", { code: "Digit5" }));
          const stray = new Press("x");
          const toPage = yield* modes.bubble("keydown", stray);

          // The count made this key part of a half-typed command. The user is
          // in the middle of a sequence, so the page must not see the key.
          assert.isFalse(toPage);
          assert.isTrue(stray.defaultPrevented);
          assert.deepEqual(yield* Ref.get(calls), []);

          // The stray key ended the count, so the next key counts as one.
          yield* modes.bubble("keydown", new Press("j"));
          assert.deepEqual(yield* Ref.get(calls), ["scrollDown:1"]);
        }),
        Effect.provide(layerFor({ mappings: "map j scrollDown" })),
      ),
    );

    it.effect("takes a pass key that a count starts", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollDown"]);

          // The user gave `j` to the page, so `j` alone goes to the page.
          const promised = new Press("j");
          assert.isTrue(yield* modes.bubble("keydown", promised));
          assert.isFalse(promised.defaultPrevented);
          assert.deepEqual(yield* Ref.get(calls), []);

          yield* modes.bubble("keydown", new Press("3", { code: "Digit3" }));
          const ours = new Press("j");
          const toPage = yield* modes.bubble("keydown", ours);

          // The count started a sequence, so the pass rule no longer applies.
          assert.deepEqual(yield* Ref.get(calls), ["scrollDown:3"]);
          assert.isFalse(toPage);
          assert.isTrue(ours.defaultPrevented);
        }),
        Effect.provide(
          layerFor({
            mappings: "map j scrollDown",
            verdict: passing("j"),
          }),
        ),
      ),
    );
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
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollUp", "scrollToTop", "scrollDown"]);

          yield* modes.bubble("keydown", new Press("g"));
          const promised = new Press("j");
          const toPage = yield* modes.bubble("keydown", promised);

          // `g` ran, because the sequence ended. `j` belongs to the page, and
          // the user promised it before any of this.
          assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);
          assert.isTrue(toPage);
          assert.isFalse(promised.defaultPrevented);
        }),
        Effect.provide(
          layerFor({
            mappings: ["map g scrollUp", "map gg scrollToTop", "map j scrollDown"].join("\n"),
            verdict: passing("j"),
          }),
        ),
      ),
    );

    it.effect("is the key that a deferred passNextKey passes", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const keyboard = yield* Keyboard;
          const commands = yield* Commands;
          const calls = yield* recorder(["scrollToTop", "scrollDown"]);

          // The real body, because the point of the test is the order. The
          // counter must hold the pass before the next key is read.
          yield* commands.register("passNextKey", ({ count }) =>
            pipe(
              calls,
              Ref.update(Array.append(`passNextKey:${count}`)),
              Effect.andThen(keyboard.passNextKey(count)),
            ),
          );

          yield* modes.bubble("keydown", new Press("g"));
          const passed = new Press("x");
          const toPage = yield* modes.bubble("keydown", passed);

          // `x` is the key after the command, so `x` is the key that passes.
          assert.deepEqual(yield* Ref.get(calls), ["passNextKey:1"]);
          assert.isTrue(toPage);
          assert.isFalse(passed.defaultPrevented);

          // The counter held one pass, and `x` used it.
          yield* modes.bubble("keydown", new Press("x"));
          assert.deepEqual(yield* Ref.get(calls), ["passNextKey:1", "scrollDown:1"]);
        }),
        Effect.provide(
          layerFor({
            mappings: ["map g passNextKey", "map gg scrollToTop", "map x scrollDown"].join("\n"),
          }),
        ),
      ),
    );

    it.effect("passes as many keys as the count in front of the command", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const keyboard = yield* Keyboard;
          const commands = yield* Commands;
          const calls = yield* recorder(["scrollToTop", "scrollDown"]);

          yield* commands.register("passNextKey", ({ count }) =>
            pipe(
              calls,
              Ref.update(Array.append(`passNextKey:${count}`)),
              Effect.andThen(keyboard.passNextKey(count)),
            ),
          );

          // The count, the accepted binding and the pass counter meet here.
          yield* modes.bubble("keydown", new Press("2", { code: "Digit2" }));
          yield* modes.bubble("keydown", new Press("g"));

          // `x` ends the sequence, so it is the first of the two keys that pass.
          const first = new Press("x");
          assert.isTrue(yield* modes.bubble("keydown", first));
          assert.isFalse(first.defaultPrevented);
          assert.isTrue(yield* modes.bubble("keydown", new Press("x")));
          assert.deepEqual(yield* Ref.get(calls), ["passNextKey:2"]);

          // The counter is spent, so the third `x` is ours again.
          yield* modes.bubble("keydown", new Press("x"));
          assert.deepEqual(yield* Ref.get(calls), ["passNextKey:2", "scrollDown:1"]);
        }),
        Effect.provide(
          layerFor({
            mappings: ["map g passNextKey", "map gg scrollToTop", "map x scrollDown"].join("\n"),
          }),
        ),
      ),
    );

    it.effect("keeps the promise to pass when the focus moves", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const keyboard = yield* Keyboard;
          const commands = yield* Commands;
          const calls = yield* recorder(["scrollDown"]);

          yield* commands.register("passNextKey", ({ count }) => keyboard.passNextKey(count));

          yield* modes.bubble("keydown", new Press("p"));
          // The focus reset ends a half-typed sequence. The promise to give one
          // key to the page is not a half-typed sequence, so it stands.
          yield* modes.bubble("focus", new Focus());

          const promised = new Press("j");
          const toPage = yield* modes.bubble("keydown", promised);
          assert.isTrue(toPage);
          assert.isFalse(promised.defaultPrevented);
          assert.deepEqual(yield* Ref.get(calls), []);
        }),
        Effect.provide(
          layerFor({
            mappings: "map p passNextKey\nmap j scrollDown",
          }),
        ),
      ),
    );
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
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollUp", "scrollDown"]);

          const press = new Press("j");
          const toPage = yield* modes.bubble("keydown", press);

          assert.deepEqual(yield* Ref.get(calls), []);
          assert.isTrue(toPage);
          assert.isFalse(press.defaultPrevented);
        }),
        Effect.provide(
          layerFor({
            mappings: remap,
            verdict: passing("j"),
          }),
        ),
      ),
    );

    it.effect("runs its command when the exclusion names the target key", () =>
      pipe(
        Effect.gen(function* () {
          const modes = yield* Modes;
          const calls = yield* recorder(["scrollUp", "scrollDown"]);

          // The user gave `k` to the page, and `j` is not `k`.
          yield* modes.bubble("keydown", new Press("j"));
          assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);

          // The physical `k` is the one that the page keeps.
          const kept = new Press("k");
          const toPage = yield* modes.bubble("keydown", kept);
          assert.deepEqual(yield* Ref.get(calls), ["scrollUp:1"]);
          assert.isTrue(toPage);
        }),
        Effect.provide(
          layerFor({
            mappings: remap,
            verdict: passing("k"),
          }),
        ),
      ),
    );
  });
});
