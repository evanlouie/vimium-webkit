/**
 * Modes: stack frames with a lifecycle.
 *
 * A mode owns a handler-stack frame, an optional singleton group and an
 * indicator. The scope owns the mode, so nothing has to remember to exit it.
 */

import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Layer, Ref, SubscriptionRef, pipe } from "effect";
import { HandlerStack } from "~/core/HandlerStack.ts";
import { type ExitReason, Modes } from "~/core/Modes.ts";

/** Modes over its one dependency. Nothing here touches a global. */
const layer = Layer.provideMerge(Modes.layer, HandlerStack.layer);

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

        const first = yield* modes.enter<never>({ name: "demo" });
        assert.isTrue(yield* first.isActive);
        assert.strictEqual(yield* stack.depth, 1);
        assert.deepEqual(yield* modes.activeNames, ["demo"]);

        yield* first.exit();
        assert.isFalse(yield* first.isActive);
        assert.strictEqual(yield* stack.depth, 0);

        const second = yield* modes.enter<never>({ name: "demo" });
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
                const mode = yield* modes.enter<never>({ name: "cycle" });
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

        const mode = yield* modes.enter<never>({ name: "reasons" });
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

        const mode = yield* modes.enter<never>({ name: "late" });
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

        const mode = yield* modes.enter<never>({ name: "queued" });
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

        const mode = yield* modes.enter<never>({ name: "failing" });
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

        const first = yield* modes.enter<never>({
          name: "first",
          singleton: "group",
        });
        assert.deepEqual(yield* modes.activeNames, ["first"]);

        const second = yield* modes.enter<never>({
          name: "second",
          singleton: "group",
        });
        assert.isFalse(yield* first.isActive);
        assert.isTrue(yield* second.isActive);
        assert.deepEqual(yield* modes.activeNames, ["second"]);
        assert.strictEqual(yield* stack.depth, 1);

        const third = yield* modes.enter<never>({
          name: "third",
          singleton: "group",
        });
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

        const first = yield* modes.enter<never>({
          name: "first",
          singleton: "group",
        });
        yield* first.onExit((reason) => pipe(reasons, Ref.update(Array.append(reason))));
        yield* modes.enter<never>({ name: "second", singleton: "group" });

        assert.deepEqual(yield* Ref.get(reasons), ["singleton"]);
      }),
      Effect.provide(layer),
    ),
  );

  it.effect("shows the innermost indicator that is not null", () =>
    pipe(
      Effect.gen(function* () {
        const modes = yield* Modes;

        const outer = yield* modes.enter<never>({
          name: "outer",
          indicator: "OUTER",
        });
        assert.strictEqual(yield* SubscriptionRef.get(modes.indicator), "OUTER");

        const silent = yield* modes.enter<never>({ name: "silent" });
        assert.strictEqual(yield* SubscriptionRef.get(modes.indicator), "OUTER");

        const inner = yield* modes.enter<never>({
          name: "inner",
          indicator: "INNER",
        });
        assert.strictEqual(yield* SubscriptionRef.get(modes.indicator), "INNER");

        yield* inner.exit();
        assert.strictEqual(yield* SubscriptionRef.get(modes.indicator), "OUTER");

        yield* outer.exit();
        assert.isNull(yield* SubscriptionRef.get(modes.indicator));

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

        const first = yield* modes.enter<never>({ name: "a" });
        const second = yield* modes.enter<never>({ name: "b" });
        const third = yield* modes.enter<never>({ name: "c" });
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

        const mode = yield* modes.enter<never>(
          { name: "defective", indicator: "DEFECTIVE", singleton: "group" },
          { keydown: () => Effect.die(new Error("boom")) },
        );
        yield* mode.onExit((reason) => pipe(reasons, Ref.update(Array.append(reason))));
        assert.strictEqual(yield* SubscriptionRef.get(modes.indicator), "DEFECTIVE");

        // The event still reaches the page, because a failed frame decides
        // nothing.
        assert.isTrue(yield* stack.bubble("keydown", keyEvent()));

        assert.isFalse(yield* mode.isActive);
        assert.deepEqual(yield* modes.activeNames, []);
        assert.strictEqual(yield* stack.depth, 0);
        assert.isNull(yield* SubscriptionRef.get(modes.indicator));
        assert.deepEqual(yield* Ref.get(reasons), ["defect"]);

        // The singleton group is free again, so the feature can be used again.
        const next = yield* modes.enter<never>({
          name: "next",
          singleton: "group",
        });
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

        const mode = yield* modes.enter<never>(
          { name: "defective" },
          { keydown: () => Effect.die(new Error("boom")) },
        );
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
            const mode = yield* modes.enter<never>({ name: "scoped" });
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
