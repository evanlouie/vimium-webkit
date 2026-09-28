/**
 * Modes: stack frames with a lifecycle.
 *
 * A mode owns a handler-stack frame, an optional singleton group and an
 * indicator. The scope owns the mode, so nothing has to remember to exit it.
 */

import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Layer, Option, Ref, Struct, SubscriptionRef, pipe } from "effect";
import { HandlerStack } from "~/core/HandlerStack.ts";
import { type ExitReason, KeyPolicy, type ModeOptions, Modes } from "~/core/Modes.ts";

/** Modes over its one dependency. Nothing here touches a global. */
const layer = Layer.provideMerge(Modes.layer, HandlerStack.layer);

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

/**
 * A `keydown` event for the walk.
 *
 * Node has no `KeyboardEvent`, so the test gives a double of its own. The mode
 * handler reads a property of the event only when an exit condition asks for
 * it, so the values of a plain, unmodified key are enough to make the walk run
 * a body.
 */
class KeyEventDouble implements KeyboardEvent {
  readonly type = "keydown";
  readonly bubbles = true;
  cancelBubble = false;
  readonly cancelable = true;
  readonly composed = true;
  readonly currentTarget = null;
  defaultPrevented = false;
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

  stopImmediatePropagation(): void {}

  stopPropagation(): void {}
}

const keyEvent = (): KeyboardEvent => new KeyEventDouble();

describe("Modes", () => {
  it.effect("enters a mode, exits it, and enters it again", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const stack = yield* HandlerStack;

        assert.strictEqual(yield* stack.depth, 0);

        const first = yield* modes.enter<never>(plain("demo"));
        assert.isTrue(yield* first.isActive);
        assert.strictEqual(yield* stack.depth, 1);
        assert.deepEqual(yield* modes.activeNames, ["demo"]);

        yield* first.exit();
        assert.isFalse(yield* first.isActive);
        assert.strictEqual(yield* stack.depth, 0);

        const second = yield* modes.enter<never>(plain("demo"));
        assert.isTrue(yield* second.isActive);
        assert.strictEqual(yield* stack.depth, 1);

        yield* second.exit();
        assert.strictEqual(yield* stack.depth, 0);
        assert.deepEqual(yield* modes.activeNames, []);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("does not grow the stack over repeated cycles", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const stack = yield* HandlerStack;

        yield* pipe(
          Array.range(1, 8),
          Effect.forEach(
            () =>
              Effect.gen(function* () {
                const mode = yield* modes.enter<never>(plain("cycle"));
                assert.strictEqual(yield* stack.depth, 1);
                yield* mode.exit();
                assert.strictEqual(yield* stack.depth, 0);
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
        const stack = yield* HandlerStack;

        const first = yield* modes.enter<never>(grouped("first", "group"));
        assert.deepEqual(yield* modes.activeNames, ["first"]);

        const second = yield* modes.enter<never>(grouped("second", "group"));
        assert.isFalse(yield* first.isActive);
        assert.isTrue(yield* second.isActive);
        assert.deepEqual(yield* modes.activeNames, ["second"]);
        assert.strictEqual(yield* stack.depth, 1);

        const third = yield* modes.enter<never>(grouped("third", "group"));
        assert.isFalse(yield* second.isActive);
        assert.deepEqual(yield* modes.activeNames, ["third"]);
        assert.strictEqual(yield* stack.depth, 1);

        yield* third.exit();
        assert.strictEqual(yield* stack.depth, 0);
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
        assert.deepEqual(yield* SubscriptionRef.get(modes.indicator), Option.some("OUTER"));

        const silent = yield* modes.enter<never>(plain("silent"));
        assert.deepEqual(yield* SubscriptionRef.get(modes.indicator), Option.some("OUTER"));

        const inner = yield* modes.enter<never>(shown("inner", "INNER"));
        assert.deepEqual(yield* SubscriptionRef.get(modes.indicator), Option.some("INNER"));

        yield* inner.exit();
        assert.deepEqual(yield* SubscriptionRef.get(modes.indicator), Option.some("OUTER"));

        yield* outer.exit();
        assert.deepEqual(yield* SubscriptionRef.get(modes.indicator), Option.none());

        yield* silent.exit();
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("clears the stack whatever the nesting is", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const stack = yield* HandlerStack;

        const first = yield* modes.enter<never>(plain("a"));
        const second = yield* modes.enter<never>(plain("b"));
        const third = yield* modes.enter<never>(plain("c"));
        assert.strictEqual(yield* stack.depth, 3);

        yield* modes.exitAll();
        assert.strictEqual(yield* stack.depth, 0);
        assert.deepEqual(yield* modes.activeNames, []);
        assert.isFalse(yield* first.isActive);
        assert.isFalse(yield* second.isActive);
        assert.isFalse(yield* third.isActive);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("exits the whole mode when its handler fails", () =>
    pipe(
      Effect.gen(function* () {
        // The stack drops a frame whose body failed. The mode holds an
        // indicator, a singleton group and its exit bodies, and only the mode
        // can release those. A frame that goes away in silence leaves them.
        const modes = yield* Modes;
        const stack = yield* HandlerStack;
        const reasons = yield* Ref.make<readonly ExitReason[]>([]);
        const options = pipe(
          grouped("defective", "group"),
          Struct.assign({ indicator: Option.some("DEFECTIVE") }),
        );

        const mode = yield* modes.enter<never>(options, {
          keydown: () => Effect.die(new Error("boom")),
        });
        yield* mode.onExit((reason) => pipe(reasons, Ref.update(Array.append(reason))));
        assert.deepEqual(yield* SubscriptionRef.get(modes.indicator), Option.some("DEFECTIVE"));

        // The event still reaches the page, because a failed frame decides
        // nothing.
        assert.isTrue(yield* stack.bubble("keydown", keyEvent()));

        assert.isFalse(yield* mode.isActive);
        assert.deepEqual(yield* modes.activeNames, []);
        assert.strictEqual(yield* stack.depth, 0);
        assert.deepEqual(yield* SubscriptionRef.get(modes.indicator), Option.none());
        assert.deepEqual(yield* Ref.get(reasons), ["defect"]);

        // The singleton group is free again, so the feature can be used again.
        const next = yield* modes.enter<never>(grouped("next", "group"));
        assert.isTrue(yield* next.isActive);
        assert.deepEqual(yield* modes.activeNames, ["next"]);
        yield* next.exit();
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("exits the mode when its handler fails again", () =>
    pipe(
      Effect.gen(function* () {
        // A second walk must not find the frame, and a second exit must not run
        // the exit bodies twice.
        const modes = yield* Modes;
        const stack = yield* HandlerStack;
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

        yield* stack.bubble("keydown", keyEvent());
        yield* stack.bubble("keydown", keyEvent());

        assert.strictEqual(yield* Ref.get(fired), 1);
        assert.strictEqual(yield* stack.depth, 0);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("exits the mode when its scope closes", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;
        const stack = yield* HandlerStack;
        const reasons = yield* Ref.make<readonly ExitReason[]>([]);

        const handle = yield* Effect.scoped(
          Effect.gen(function* () {
            const mode = yield* modes.enter<never>(plain("scoped"));
            yield* mode.onExit((reason) => pipe(reasons, Ref.update(Array.append(reason))));
            assert.strictEqual(yield* stack.depth, 1);
            return mode;
          }),
        );

        assert.isFalse(yield* handle.isActive);
        assert.strictEqual(yield* stack.depth, 0);
        assert.deepEqual(yield* Ref.get(reasons), ["navigation"]);
      }),
      Effect.provide(layer),
    ),
  );
});
