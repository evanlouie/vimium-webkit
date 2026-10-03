/**
 * Modes: the handler stack, and the lifecycle of each of its frames.
 *
 * A mode is a frame of the stack, with an optional singleton group and an
 * indicator. The scope owns the mode, so nothing has to remember to exit it.
 *
 * Every keystroke passes through `bubble`, so its walk is the most important
 * loop in the application.
 */

import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Option, Ref, Scope, Struct, pipe } from "effect";
import {
  CONTINUE_BUBBLING,
  type Handlers,
  PASS_EVENT_TO_PAGE,
  SUPPRESS_EVENT,
  SUPPRESS_PROPAGATION,
} from "~/core/HandlerStack.ts";
import { type ExitReason, KeyPolicy, type ModeOptions, Modes, ModeTier } from "~/core/Modes.ts";

/** Modes, with nothing under it. Nothing here touches a global. */
const layer = Modes.layer;

/** A mode with no indicator, no exit trigger, a shared keyboard and no singleton group. */
const plain = (name: string): ModeOptions => ({
  name,
  indicator: Option.none(),
  exitOn: [],
  keyboard: KeyPolicy.Shared(),
  singleton: Option.none(),
});

/** A plain mode in a singleton group. */
const grouped = (name: string, group: string): ModeOptions =>
  pipe(plain(name), Struct.assign({ singleton: Option.some(group) }));

/** A plain mode that shows an indicator. */
const shown = (name: string, indicator: string): ModeOptions =>
  pipe(plain(name), Struct.assign({ indicator: Option.some(indicator) }));

/** A plain mode on one tier of the stack. */
const onTier = (name: string, tier: ModeTier): ModeOptions =>
  pipe(plain(name), Struct.assign({ tier }));

/**
 * A `keydown` event for the walk.
 *
 * Node has no `KeyboardEvent`, so the test gives a double of its own. The mode
 * handler reads a property of the event only when an exit condition asks for
 * it, so the values of a plain, unmodified key are enough to make the walk run
 * a body. `defaultPrevented` and `propagationStopped` record what the walk did
 * to the event.
 */
class KeyEventDouble implements KeyboardEvent {
  readonly type = "keydown";
  readonly bubbles = true;
  cancelBubble = false;
  readonly cancelable = true;
  readonly composed = true;
  readonly currentTarget = null;
  defaultPrevented = false;
  propagationStopped = false;
  readonly eventPhase = 0;
  readonly isTrusted = true;
  returnValue = true;
  readonly srcElement = null;
  readonly target = null;
  readonly timeStamp = 0;
  readonly NONE = 0;
  readonly CAPTURING_PHASE = 1;
  readonly AT_TARGET = 2;
  readonly BUBBLING_PHASE = 3;
  readonly detail = 0;
  readonly view = null;
  readonly which = 0;
  readonly key = "x";
  readonly code = "KeyX";
  readonly keyCode = 88;
  readonly charCode = 0;
  readonly location = 0;
  readonly altKey = false;
  readonly ctrlKey = false;
  readonly metaKey = false;
  readonly shiftKey = false;
  readonly isComposing = false;
  readonly repeat = false;
  readonly DOM_KEY_LOCATION_STANDARD = 0;
  readonly DOM_KEY_LOCATION_LEFT = 1;
  readonly DOM_KEY_LOCATION_RIGHT = 2;
  readonly DOM_KEY_LOCATION_NUMPAD = 3;

  composedPath(): EventTarget[] {
    return [];
  }

  getModifierState(): boolean {
    return false;
  }

  initEvent(): void {}

  initUIEvent(): void {}

  initKeyboardEvent(): void {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true;
  }

  stopPropagation(): void {}
}

const keyEvent = (): KeyEventDouble => new KeyEventDouble();

/** Bodies that write the name of the mode into `seen` and let the walk continue. */
const recording = (name: string, seen: Ref.Ref<readonly string[]>): Handlers => ({
  keydown: () => pipe(seen, Ref.update(Array.append(name)), Effect.as(CONTINUE_BUBBLING)),
});

describe("Modes", () => {
  it.effect("enters a mode, exits it, and enters it again", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;

        assert.deepEqual(yield* modes.activeNames, []);

        const first = yield* modes.enter<never>(plain("demo"));
        assert.isTrue(yield* first.isActive);
        assert.deepEqual(yield* modes.activeNames, ["demo"]);

        yield* first.exit();
        assert.isFalse(yield* first.isActive);
        assert.deepEqual(yield* modes.activeNames, []);

        const second = yield* modes.enter<never>(plain("demo"));
        assert.isTrue(yield* second.isActive);
        assert.deepEqual(yield* modes.activeNames, ["demo"]);

        yield* second.exit();
        assert.deepEqual(yield* modes.activeNames, []);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("does not grow the stack over repeated cycles", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;

        yield* pipe(
          Array.range(1, 8),
          Effect.forEach(
            () =>
              Effect.gen(function* () {
                const mode = yield* modes.enter<never>(plain("cycle"));
                assert.deepEqual(yield* modes.activeNames, ["cycle"]);
                yield* mode.exit();
                assert.deepEqual(yield* modes.activeNames, []);
              }),
            { discard: true },
          ),
        );
        assert.deepEqual(yield* modes.activeNames, []);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("ignores a second exit", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const reasons = yield* Ref.make<readonly ExitReason[]>([]);

        const mode = yield* modes.enter<never>(plain("reasons"));
        yield* mode.onExit((reason) => pipe(reasons, Ref.update(Array.append(reason))));

        yield* mode.exit("escape");
        assert.deepEqual(yield* Ref.get(reasons), ["escape"]);

        // A mode that has already exited must not run its bodies again.
        yield* mode.exit("explicit");
        assert.deepEqual(yield* Ref.get(reasons), ["escape"]);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("runs an exit body at once when the mode already exited", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const fired = yield* Ref.make(0);

        const mode = yield* modes.enter<never>(plain("late"));
        yield* mode.exit();

        yield* mode.onExit(() =>
          pipe(
            fired,
            Ref.update((count) => count + 1),
          ),
        );
        assert.strictEqual(yield* Ref.get(fired), 1);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("queues an exit body while the mode is live", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const fired = yield* Ref.make(0);

        const mode = yield* modes.enter<never>(plain("queued"));
        yield* mode.onExit(() =>
          pipe(
            fired,
            Ref.update((count) => count + 1),
          ),
        );
        assert.strictEqual(yield* Ref.get(fired), 0);

        yield* mode.exit();
        assert.strictEqual(yield* Ref.get(fired), 1);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("runs the other exit bodies when one of them fails", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const seen = yield* Ref.make<readonly string[]>([]);

        const mode = yield* modes.enter<never>(plain("failing"));
        yield* mode.onExit(() =>
          pipe(
            seen,
            Ref.update(Array.append("first")),
            Effect.andThen(Effect.die(new Error("boom"))),
          ),
        );
        yield* mode.onExit(() => pipe(seen, Ref.update(Array.append("second"))));

        yield* mode.exit();
        assert.deepEqual(yield* Ref.get(seen), ["first", "second"]);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("keeps exactly one live mode in a singleton group", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;

        const first = yield* modes.enter<never>(grouped("first", "group"));
        assert.deepEqual(yield* modes.activeNames, ["first"]);

        const second = yield* modes.enter<never>(grouped("second", "group"));
        assert.isFalse(yield* first.isActive);
        assert.isTrue(yield* second.isActive);
        assert.deepEqual(yield* modes.activeNames, ["second"]);

        const third = yield* modes.enter<never>(grouped("third", "group"));
        assert.isFalse(yield* second.isActive);
        assert.deepEqual(yield* modes.activeNames, ["third"]);

        yield* third.exit();
        assert.deepEqual(yield* modes.activeNames, []);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("gives the singleton exit its own reason", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const reasons = yield* Ref.make<readonly ExitReason[]>([]);

        const first = yield* modes.enter<never>(grouped("first", "group"));
        yield* first.onExit((reason) => pipe(reasons, Ref.update(Array.append(reason))));
        yield* modes.enter<never>(grouped("second", "group"));

        assert.deepEqual(yield* Ref.get(reasons), ["singleton"]);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("shows the innermost indicator that a mode gives", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;

        const outer = yield* modes.enter<never>(shown("outer", "OUTER"));
        assert.deepEqual(yield* modes.indicator.get, Option.some("OUTER"));

        const silent = yield* modes.enter<never>(plain("silent"));
        assert.deepEqual(yield* modes.indicator.get, Option.some("OUTER"));

        const inner = yield* modes.enter<never>(shown("inner", "INNER"));
        assert.deepEqual(yield* modes.indicator.get, Option.some("INNER"));

        yield* inner.exit();
        assert.deepEqual(yield* modes.indicator.get, Option.some("OUTER"));

        yield* outer.exit();
        assert.deepEqual(yield* modes.indicator.get, Option.none());

        yield* silent.exit();
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("places a mode by its tier, and not by when it was entered", () =>
    pipe(
      Effect.gen(function* () {
        // Normal mode and insert mode are entered when their layers are built,
        // and a command can open a mode before either. The tier keeps the
        // order: a key typed into a text field must reach insert mode before
        // it reaches a binding.
        const modes = yield* Modes;
        const seen = yield* Ref.make<readonly string[]>([]);

        yield* modes.enter(plain("find"), recording("find", seen));
        yield* modes.enter(onTier("insert", ModeTier.Insert()), recording("insert", seen));
        yield* modes.enter(onTier("normal", ModeTier.Base()), recording("normal", seen));
        yield* modes.enter(plain("hints"), recording("hints", seen));

        assert.deepEqual(yield* modes.activeNames, ["normal", "insert", "find", "hints"]);

        yield* modes.bubble("keydown", keyEvent());
        assert.deepEqual(yield* Ref.get(seen), ["hints", "find", "insert", "normal"]);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("exits every transient mode, and leaves normal and insert mode", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;

        const normal = yield* modes.enter<never>(onTier("normal", ModeTier.Base()));
        const insert = yield* modes.enter<never>(onTier("insert", ModeTier.Insert()));
        const first = yield* modes.enter<never>(plain("a"));
        const second = yield* modes.enter<never>(plain("b"));

        yield* modes.exitAll();
        assert.deepEqual(yield* modes.activeNames, ["normal", "insert"]);
        assert.isTrue(yield* normal.isActive);
        assert.isTrue(yield* insert.isActive);
        assert.isFalse(yield* first.isActive);
        assert.isFalse(yield* second.isActive);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("exits the whole mode when its handler fails", () =>
    pipe(
      Effect.gen(function* () {
        // A failing body must not block the key path. The mode holds an
        // indicator, a singleton group and its exit bodies, and a mode that
        // goes away in silence leaves them.
        const modes = yield* Modes;
        const reasons = yield* Ref.make<readonly ExitReason[]>([]);
        const seen = yield* Ref.make<readonly string[]>([]);
        const options = pipe(
          grouped("defective", "group"),
          Struct.assign({ indicator: Option.some("DEFECTIVE") }),
        );

        yield* modes.enter(onTier("below", ModeTier.Base()), recording("below", seen));
        const mode = yield* modes.enter<never>(options, {
          keydown: () => Effect.die(new Error("boom")),
        });
        yield* mode.onExit((reason) => pipe(reasons, Ref.update(Array.append(reason))));
        assert.deepEqual(yield* modes.indicator.get, Option.some("DEFECTIVE"));

        // The event still reaches the mode below, and then the page, because a
        // failed mode decides nothing.
        assert.isTrue(yield* modes.bubble("keydown", keyEvent()));
        assert.deepEqual(yield* Ref.get(seen), ["below"]);

        assert.isFalse(yield* mode.isActive);
        assert.deepEqual(yield* modes.activeNames, ["below"]);
        assert.deepEqual(yield* modes.indicator.get, Option.none());
        assert.deepEqual(yield* Ref.get(reasons), ["defect"]);

        // The singleton group is free again, so the feature can be used again.
        const next = yield* modes.enter<never>(grouped("next", "group"));
        assert.isTrue(yield* next.isActive);
        assert.deepEqual(yield* modes.activeNames, ["below", "next"]);
        yield* next.exit();
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("continues the walk when an exit body of a failed mode fails too", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const seen = yield* Ref.make<readonly string[]>([]);

        yield* modes.enter(plain("below"), recording("below", seen));
        const mode = yield* modes.enter<never>(plain("defective"), {
          keydown: () => Effect.die(new Error("boom")),
        });
        yield* mode.onExit(() => Effect.die(new Error("cleanup boom")));

        assert.isTrue(yield* modes.bubble("keydown", keyEvent()));
        assert.deepEqual(yield* Ref.get(seen), ["below"]);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("exits the mode when its handler fails again", () =>
    pipe(
      Effect.gen(function* () {
        // A second walk must not find the mode, and a second exit must not run
        // the exit bodies twice.
        const modes = yield* Modes;
        const fired = yield* Ref.make(0);

        const mode = yield* modes.enter<never>(plain("defective"), {
          keydown: () => Effect.die(new Error("boom")),
        });
        yield* mode.onExit(() =>
          pipe(
            fired,
            Ref.update((count) => count + 1),
          ),
        );

        yield* modes.bubble("keydown", keyEvent());
        yield* modes.bubble("keydown", keyEvent());

        assert.strictEqual(yield* Ref.get(fired), 1);
        assert.deepEqual(yield* modes.activeNames, []);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("exits the mode when its scope closes", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const reasons = yield* Ref.make<readonly ExitReason[]>([]);

        const handle = yield* Effect.scoped(
          Effect.gen(function* () {
            const mode = yield* modes.enter<never>(plain("scoped"));
            yield* mode.onExit((reason) => pipe(reasons, Ref.update(Array.append(reason))));
            assert.deepEqual(yield* modes.activeNames, ["scoped"]);
            return mode;
          }),
        );

        assert.isFalse(yield* handle.isActive);
        assert.deepEqual(yield* modes.activeNames, []);
        assert.deepEqual(yield* Ref.get(reasons), ["navigation"]);
      }),
      Effect.provide(layer),
    ),
  );
});

describe("the walk of the stack", () => {
  it.effect("visits every mode below the top exactly once", () =>
    pipe(
      Effect.gen(function* () {
        // The walk takes a snapshot. A body that exits a mode below its own
        // would otherwise move every lower mode up by one, so one mode is
        // visited twice and one is not visited at all.
        const modes = yield* Modes;
        const seen = yield* Ref.make<readonly string[]>([]);

        yield* modes.enter(plain("A"), recording("A", seen));
        const middle = yield* modes.enter(plain("B"), recording("B", seen));
        yield* modes.enter(plain("C"), {
          keydown: () =>
            pipe(
              seen,
              Ref.update(Array.append("C")),
              Effect.andThen(middle.exit()),
              Effect.as(CONTINUE_BUBBLING),
            ),
        });

        yield* modes.bubble("keydown", keyEvent());
        assert.deepEqual(yield* Ref.get(seen), ["C", "A"]);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("lets a mode exit itself while its body runs", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const seen = yield* Ref.make<readonly string[]>([]);
        const self = yield* Ref.make<Effect.Effect<void>>(Effect.void);

        yield* modes.enter(plain("below"), recording("below", seen));
        const mode = yield* modes.enter(plain("self-exiting"), {
          keydown: () => pipe(Ref.get(self), Effect.flatten, Effect.as(CONTINUE_BUBBLING)),
        });
        yield* pipe(self, Ref.set(mode.exit()));

        yield* modes.bubble("keydown", keyEvent());
        assert.isFalse(yield* mode.isActive);
        assert.deepEqual(yield* Ref.get(seen), ["below"]);
        assert.deepEqual(yield* modes.activeNames, ["below"]);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("suppresses the default action and the propagation", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const seen = yield* Ref.make<readonly string[]>([]);

        yield* modes.enter(plain("below"), recording("below", seen));
        yield* modes.enter(plain("top"), { keydown: () => Effect.succeed(SUPPRESS_EVENT) });

        const event = keyEvent();
        assert.isFalse(yield* modes.bubble("keydown", event));
        assert.isTrue(event.defaultPrevented);
        assert.isTrue(event.propagationStopped);
        assert.deepEqual(yield* Ref.get(seen), []);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("leaves the default action alone for a propagation stop", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        yield* modes.enter(plain("top"), { keydown: () => Effect.succeed(SUPPRESS_PROPAGATION) });

        const event = keyEvent();
        assert.isFalse(yield* modes.bubble("keydown", event));
        assert.isFalse(event.defaultPrevented);
        assert.isTrue(event.propagationStopped);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("stops the walk and leaves the event alone for the page", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const seen = yield* Ref.make<readonly string[]>([]);

        yield* modes.enter(plain("below"), recording("below", seen));
        yield* modes.enter(plain("top"), { keydown: () => Effect.succeed(PASS_EVENT_TO_PAGE) });

        const event = keyEvent();
        assert.isTrue(yield* modes.bubble("keydown", event));
        assert.isFalse(event.defaultPrevented);
        assert.isFalse(event.propagationStopped);
        assert.deepEqual(yield* Ref.get(seen), []);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("gives a key that no body answers to the page, or to an owning mode", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;

        // A shared mode with no key body lets the key through.
        const shared = yield* modes.enter<never>(plain("shared"));
        const passed = keyEvent();
        assert.isTrue(yield* modes.bubble("keydown", passed));
        assert.isFalse(passed.defaultPrevented);
        yield* shared.exit();

        // A mode that owns the keyboard takes it.
        yield* modes.enter<never>(
          pipe(plain("owned"), Struct.assign({ keyboard: KeyPolicy.Owned() })),
        );
        const taken = keyEvent();
        assert.isFalse(yield* modes.bubble("keydown", taken));
        assert.isTrue(taken.defaultPrevented);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("runs a body without the scope of the code that entered the mode", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const found = yield* Ref.make<ReadonlyArray<boolean>>([]);
        yield* modes.enter(plain("top"), {
          keydown: () =>
            pipe(
              Effect.serviceOption(Scope.Scope),
              Effect.flatMap((scope) =>
                pipe(found, Ref.update(Array.append(Option.isSome(scope)))),
              ),
              Effect.as(CONTINUE_BUBBLING),
            ),
        });

        yield* modes.bubble("keydown", keyEvent());
        assert.deepEqual(yield* Ref.get(found), [false]);
      }),
      Effect.provide(layer),
    ),
  );
});

describe("the release of a key", () => {
  it.effect("goes to the page exactly when its press did", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const takes = yield* Ref.make(true);
        yield* modes.enter(onTier("normal", ModeTier.Base()), {
          keydown: () =>
            pipe(
              Ref.get(takes),
              Effect.map((taken) => (taken ? SUPPRESS_EVENT : PASS_EVENT_TO_PAGE)),
            ),
        });

        // A press that a mode takes keeps its release from the page, whatever
        // a mode above answers for the release. `/` opens find this way.
        assert.isFalse(yield* modes.bubble("keydown", keyEvent()));
        const find = yield* modes.enter(plain("find"), {
          keyup: () => Effect.succeed(PASS_EVENT_TO_PAGE),
        });
        const release = keyEvent();
        assert.isFalse(yield* modes.bubble("keyup", release));
        assert.isTrue(release.defaultPrevented);
        yield* find.exit();

        // macOS sends no release for a key pressed with ⌘. The next press that
        // reaches the page, in a text field say, gives the page its release.
        assert.isFalse(yield* modes.bubble("keydown", keyEvent()));
        yield* pipe(takes, Ref.set(false));
        assert.isTrue(yield* modes.bubble("keydown", keyEvent()));
        const typed = keyEvent();
        assert.isTrue(yield* modes.bubble("keyup", typed));
        assert.isFalse(typed.defaultPrevented);

        // A blur of the window forgets the presses whose release may not come.
        yield* pipe(takes, Ref.set(true));
        assert.isFalse(yield* modes.bubble("keydown", keyEvent()));
        yield* modes.forgetSuppressed;
        assert.isTrue(yield* modes.bubble("keyup", keyEvent()));
      }),
      Effect.provide(layer),
    ),
  );
});
