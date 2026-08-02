/**
 * Modes: stack frames with a lifecycle.
 *
 * A mode owns a handler-stack frame, an optional singleton group and an
 * indicator. The scope owns the mode, so nothing has to remember to exit it.
 *
 * The escape, blur, click and focus exits need a real `KeyboardEvent`, a
 * `FocusEvent` or a `MouseEvent`. Node has none of them, so the Playwright
 * suite in `test/e2e/` covers those paths.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Ref, SubscriptionRef } from "effect";
import { HandlerStack } from "~/core/HandlerStack.ts";
import { type ExitReason, Modes } from "~/core/Modes.ts";

/** Modes over its one dependency. Nothing here touches a global. */
const layer = Layer.provideMerge(Modes.layer, HandlerStack.layer);

/**
 * A `keydown` event for the walk.
 *
 * Node has `Event` and has no `KeyboardEvent`. The mode handler reads a
 * property of the event only when an exit condition asks for it, so a plain
 * event is enough to make the walk run a body.
 */
const keyEvent = (): KeyboardEvent =>
  new Event("keydown", { cancelable: true }) as unknown as KeyboardEvent;

describe("Modes", () => {
  it.effect("enters a mode, exits it, and enters it again", () =>
    Effect.gen(function*() {
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
    }).pipe(Effect.provide(layer)));

  it.effect("does not grow the stack over repeated cycles", () =>
    Effect.gen(function*() {
      const modes = yield* Modes;
      const stack = yield* HandlerStack;

      for (let index = 0; index < 8; index++) {
        const mode = yield* modes.enter<never>({ name: "cycle" });
        assert.strictEqual(yield* stack.depth, 1);
        yield* mode.exit();
        assert.strictEqual(yield* stack.depth, 0);
      }
      assert.deepEqual(yield* modes.activeNames, []);
    }).pipe(Effect.provide(layer)));

  it.effect("ignores a second exit", () =>
    Effect.gen(function*() {
      const modes = yield* Modes;
      const reasons = yield* Ref.make<readonly ExitReason[]>([]);

      const mode = yield* modes.enter<never>({ name: "reasons" });
      yield* mode.onExit((reason) =>
        Ref.update(reasons, (current) => [...current, reason])
      );

      yield* mode.exit("escape");
      assert.deepEqual(yield* Ref.get(reasons), ["escape"]);

      // A mode that has already exited must not run its bodies again.
      yield* mode.exit("explicit");
      assert.deepEqual(yield* Ref.get(reasons), ["escape"]);
    }).pipe(Effect.provide(layer)));

  it.effect("runs an exit body at once when the mode already exited", () =>
    Effect.gen(function*() {
      const modes = yield* Modes;
      const fired = yield* Ref.make(0);

      const mode = yield* modes.enter<never>({ name: "late" });
      yield* mode.exit();

      yield* mode.onExit(() => Ref.update(fired, (count) => count + 1));
      assert.strictEqual(yield* Ref.get(fired), 1);
    }).pipe(Effect.provide(layer)));

  it.effect("queues an exit body while the mode is live", () =>
    Effect.gen(function*() {
      const modes = yield* Modes;
      const fired = yield* Ref.make(0);

      const mode = yield* modes.enter<never>({ name: "queued" });
      yield* mode.onExit(() => Ref.update(fired, (count) => count + 1));
      assert.strictEqual(yield* Ref.get(fired), 0);

      yield* mode.exit();
      assert.strictEqual(yield* Ref.get(fired), 1);
    }).pipe(Effect.provide(layer)));

  it.effect("runs the other exit bodies when one of them fails", () =>
    Effect.gen(function*() {
      const modes = yield* Modes;
      const seen = yield* Ref.make<readonly string[]>([]);

      const mode = yield* modes.enter<never>({ name: "failing" });
      yield* mode.onExit(() =>
        Effect.andThen(
          Ref.update(seen, (current) => [...current, "first"]),
          Effect.die(new Error("boom")),
        )
      );
      yield* mode.onExit(() =>
        Ref.update(seen, (current) => [...current, "second"])
      );

      yield* mode.exit();
      assert.deepEqual(yield* Ref.get(seen), ["first", "second"]);
    }).pipe(Effect.provide(layer)));

  it.effect("keeps exactly one live mode in a singleton group", () =>
    Effect.gen(function*() {
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
    }).pipe(Effect.provide(layer)));

  it.effect("gives the singleton exit its own reason", () =>
    Effect.gen(function*() {
      const modes = yield* Modes;
      const reasons = yield* Ref.make<readonly ExitReason[]>([]);

      const first = yield* modes.enter<never>({
        name: "first",
        singleton: "group",
      });
      yield* first.onExit((reason) =>
        Ref.update(reasons, (current) => [...current, reason])
      );
      yield* modes.enter<never>({ name: "second", singleton: "group" });

      assert.deepEqual(yield* Ref.get(reasons), ["singleton"]);
    }).pipe(Effect.provide(layer)));

  it.effect("shows the innermost indicator that is not null", () =>
    Effect.gen(function*() {
      const modes = yield* Modes;

      const outer = yield* modes.enter<never>({
        name: "outer",
        indicator: "OUTER",
      });
      assert.strictEqual(
        yield* SubscriptionRef.get(modes.indicator),
        "OUTER",
      );

      const silent = yield* modes.enter<never>({ name: "silent" });
      assert.strictEqual(
        yield* SubscriptionRef.get(modes.indicator),
        "OUTER",
      );

      const inner = yield* modes.enter<never>({
        name: "inner",
        indicator: "INNER",
      });
      assert.strictEqual(
        yield* SubscriptionRef.get(modes.indicator),
        "INNER",
      );

      yield* inner.exit();
      assert.strictEqual(
        yield* SubscriptionRef.get(modes.indicator),
        "OUTER",
      );

      yield* outer.exit();
      assert.isNull(yield* SubscriptionRef.get(modes.indicator));

      yield* silent.exit();
    }).pipe(Effect.provide(layer)));

  it.effect("clears the stack whatever the nesting is", () =>
    Effect.gen(function*() {
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
    }).pipe(Effect.provide(layer)));

  it.effect("exits the whole mode when its handler fails", () =>
    Effect.gen(function*() {
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
      yield* mode.onExit((reason) =>
        Ref.update(reasons, (current) => [...current, reason])
      );
      assert.strictEqual(
        yield* SubscriptionRef.get(modes.indicator),
        "DEFECTIVE",
      );

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
    }).pipe(Effect.provide(layer)));

  it.effect("exits the mode when its handler fails again", () =>
    Effect.gen(function*() {
      // A second walk must not find the frame, and a second exit must not run
      // the exit bodies twice.
      const modes = yield* Modes;
      const stack = yield* HandlerStack;
      const fired = yield* Ref.make(0);

      const mode = yield* modes.enter<never>(
        { name: "defective" },
        { keydown: () => Effect.die(new Error("boom")) },
      );
      yield* mode.onExit(() => Ref.update(fired, (count) => count + 1));

      yield* stack.bubble("keydown", keyEvent());
      yield* stack.bubble("keydown", keyEvent());

      assert.strictEqual(yield* Ref.get(fired), 1);
      assert.strictEqual(yield* stack.depth, 0);
    }).pipe(Effect.provide(layer)));

  it.effect("exits the mode when its scope closes", () =>
    Effect.gen(function*() {
      const modes = yield* Modes;
      const stack = yield* HandlerStack;
      const reasons = yield* Ref.make<readonly ExitReason[]>([]);

      const handle = yield* Effect.scoped(Effect.gen(function*() {
        const mode = yield* modes.enter<never>({ name: "scoped" });
        yield* mode.onExit((reason) =>
          Ref.update(reasons, (current) => [...current, reason])
        );
        assert.strictEqual(yield* stack.depth, 1);
        return mode;
      }));

      assert.isFalse(yield* handle.isActive);
      assert.strictEqual(yield* stack.depth, 0);
      assert.deepEqual(yield* Ref.get(reasons), ["navigation"]);
    }).pipe(Effect.provide(layer)));
});
