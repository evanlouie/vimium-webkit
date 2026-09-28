/**
 * The handler stack.
 *
 * Every keystroke passes through this service, so its walk is the most
 * important loop in the application. The tests use the `scroll` handler and a
 * plain `Event`, because Node has `Event` and has no `KeyboardEvent`. The
 * behaviour of the walk does not depend on the type of the event.
 */

import { assert, describe, it } from "@effect/vitest";
import { Array, Boolean, Effect, Ref, pipe } from "effect";
import {
  CONTINUE_BUBBLING,
  type Handler,
  HandlerStack,
  PASS_EVENT_TO_PAGE,
  RESTART_BUBBLING,
  SUPPRESS_EVENT,
  SUPPRESS_PROPAGATION,
} from "~/core/HandlerStack.ts";

const event = (): Event => new Event("scroll", { cancelable: true });

/** A handler that writes its name into `seen` and lets the walk continue. */
const record = (name: string, seen: Ref.Ref<readonly string[]>): Handler<never> => ({
  name,
  scroll: () => pipe(seen, Ref.update(Array.append(name)), Effect.as(CONTINUE_BUBBLING)),
});

describe("HandlerStack", () => {
  it.effect("lets push and unshift decide who sees an event first", () =>
    pipe(
      Effect.gen(function* () {
        const stack = yield* HandlerStack;
        const seen = yield* Ref.make<readonly string[]>([]);

        yield* stack.push(record("first", seen));
        yield* stack.push(record("second", seen));
        yield* stack.unshift(record("bottom", seen));

        assert.strictEqual(yield* stack.depth, 3);
        assert.deepEqual(yield* stack.names, ["bottom", "first", "second"]);

        yield* stack.bubble("scroll", event());
        // The innermost handler first, and the bottom handler last.
        assert.deepEqual(yield* Ref.get(seen), ["second", "first", "bottom"]);
      }),
      Effect.provide(HandlerStack.layer),
    ),
  );

  it.effect("runs every handler below the top exactly once", () =>
    pipe(
      Effect.gen(function* () {
        // The walk takes a snapshot. A handler that removes an entry below
        // itself would otherwise move every lower entry up by one, so one entry
        // is visited twice and one is not visited at all.
        const stack = yield* HandlerStack;
        const seen = yield* Ref.make<readonly string[]>([]);

        yield* stack.push(record("A", seen));
        const middle = yield* stack.push(record("B", seen));
        yield* stack.push({
          name: "C",
          scroll: () =>
            Effect.gen(function* () {
              yield* pipe(seen, Ref.update(Array.append("C")));
              yield* stack.remove(middle);
              return CONTINUE_BUBBLING;
            }),
        });

        yield* stack.bubble("scroll", event());
        assert.deepEqual(yield* Ref.get(seen), ["C", "A"]);
      }),
      Effect.provide(HandlerStack.layer),
    ),
  );

  it.effect("does not give the event to a handler that was removed", () =>
    pipe(
      Effect.gen(function* () {
        const stack = yield* HandlerStack;
        const seen = yield* Ref.make<readonly string[]>([]);

        const victim = yield* stack.unshift(record("victim", seen));
        yield* stack.push({
          name: "remover",
          scroll: () =>
            Effect.gen(function* () {
              yield* pipe(seen, Ref.update(Array.append("remover")));
              yield* stack.remove(victim);
              return CONTINUE_BUBBLING;
            }),
        });

        yield* stack.bubble("scroll", event());
        assert.deepEqual(yield* Ref.get(seen), ["remover"]);
        assert.isFalse(yield* stack.has(victim));
      }),
      Effect.provide(HandlerStack.layer),
    ),
  );

  it.effect("suppresses the default action and the propagation", () =>
    pipe(
      Effect.gen(function* () {
        const stack = yield* HandlerStack;
        const seen = yield* Ref.make<readonly string[]>([]);

        yield* stack.push(record("below", seen));
        yield* stack.push({
          name: "top",
          scroll: () => Effect.succeed(SUPPRESS_EVENT),
        });

        const target = event();
        assert.isFalse(yield* stack.bubble("scroll", target));
        assert.isTrue(target.defaultPrevented);
        assert.deepEqual(yield* Ref.get(seen), []);
      }),
      Effect.provide(HandlerStack.layer),
    ),
  );

  it.effect("leaves the default action alone for a propagation stop", () =>
    pipe(
      Effect.gen(function* () {
        const stack = yield* HandlerStack;
        yield* stack.push({
          name: "top",
          scroll: () => Effect.succeed(SUPPRESS_PROPAGATION),
        });

        const target = event();
        assert.isFalse(yield* stack.bubble("scroll", target));
        assert.isFalse(target.defaultPrevented);
      }),
      Effect.provide(HandlerStack.layer),
    ),
  );

  it.effect("stops the walk and leaves the event alone for the page", () =>
    pipe(
      Effect.gen(function* () {
        const stack = yield* HandlerStack;
        const seen = yield* Ref.make<readonly string[]>([]);

        yield* stack.push(record("below", seen));
        yield* stack.push({
          name: "top",
          scroll: () => Effect.succeed(PASS_EVENT_TO_PAGE),
        });

        const target = event();
        assert.isTrue(yield* stack.bubble("scroll", target));
        assert.isFalse(target.defaultPrevented);
        assert.deepEqual(yield* Ref.get(seen), []);
      }),
      Effect.provide(HandlerStack.layer),
    ),
  );

  it.effect("runs the whole stack again after a restart", () =>
    pipe(
      Effect.gen(function* () {
        const stack = yield* HandlerStack;
        const seen = yield* Ref.make<readonly string[]>([]);
        const opened = yield* Ref.make(false);
        // Whether the opener opened its handler before.
        const reopened = pipe(opened, Ref.getAndSet(true));

        // The handler that the opener pushes. It must see the event that
        // pushed it.
        const pushed: Handler<never> = {
          name: "opened",
          scroll: () => pipe(seen, Ref.update(Array.append("opened")), Effect.as(SUPPRESS_EVENT)),
        };

        yield* stack.push({
          name: "opener",
          scroll: () =>
            pipe(
              seen,
              Ref.update(Array.append("opener")),
              Effect.andThen(reopened),
              Effect.flatMap(
                Boolean.match({
                  onFalse: () => pipe(stack.push(pushed), Effect.as(RESTART_BUBBLING)),
                  onTrue: () => Effect.succeed(CONTINUE_BUBBLING),
                }),
              ),
            ),
        });

        assert.isFalse(yield* stack.bubble("scroll", event()));
        assert.deepEqual(yield* Ref.get(seen), ["opener", "opened"]);
      }),
      Effect.provide(HandlerStack.layer),
    ),
  );

  it.effect("lets an event with no interested handler reach the page", () =>
    pipe(
      Effect.gen(function* () {
        const stack = yield* HandlerStack;
        // The handler answers for `keydown` only, and the event is a `scroll`.
        yield* stack.push({
          name: "keys-only",
          keydown: () => Effect.succeed(SUPPRESS_EVENT),
        });
        const target = event();
        assert.isTrue(yield* stack.bubble("scroll", target));
        assert.isFalse(target.defaultPrevented);
      }),
      Effect.provide(HandlerStack.layer),
    ),
  );

  it.effect("drops a handler that fails and continues the walk", () =>
    pipe(
      Effect.gen(function* () {
        const stack = yield* HandlerStack;
        const seen = yield* Ref.make<readonly string[]>([]);

        yield* stack.push(record("below", seen));
        const failing = yield* stack.push({
          name: "failing",
          scroll: () => Effect.die(new Error("boom")),
        });

        assert.isTrue(yield* stack.bubble("scroll", event()));
        assert.deepEqual(
          yield* Ref.get(seen),
          ["below"],
          "a failing frame must not block the key path",
        );
        assert.isFalse(yield* stack.has(failing), "and it must not stay on the stack");
      }),
      Effect.provide(HandlerStack.layer),
    ),
  );

  it.effect("tells the owner of a handler that failed", () =>
    pipe(
      Effect.gen(function* () {
        // A frame is one part of something larger. Only the owner can release
        // the rest of it, so the stack must not drop the frame in silence.
        const stack = yield* HandlerStack;
        const cleaned = yield* Ref.make<readonly string[]>([]);

        const failing = yield* stack.push({
          name: "owned",
          scroll: () => Effect.die(new Error("boom")),
          onDefect: () => pipe(cleaned, Ref.update(Array.append("owned"))),
        });

        assert.isTrue(yield* stack.bubble("scroll", event()));
        assert.deepEqual(yield* Ref.get(cleaned), ["owned"]);
        assert.isFalse(yield* stack.has(failing));
      }),
      Effect.provide(HandlerStack.layer),
    ),
  );

  it.effect("continues the walk when the cleanup itself fails", () =>
    pipe(
      Effect.gen(function* () {
        const stack = yield* HandlerStack;
        const seen = yield* Ref.make<readonly string[]>([]);

        yield* stack.push(record("below", seen));
        yield* stack.push({
          name: "owned",
          scroll: () => Effect.die(new Error("boom")),
          onDefect: () => Effect.die(new Error("cleanup boom")),
        });

        assert.isTrue(yield* stack.bubble("scroll", event()));
        assert.deepEqual(yield* Ref.get(seen), ["below"]);
      }),
      Effect.provide(HandlerStack.layer),
    ),
  );

  it.effect("lets a handler remove itself while it runs", () =>
    pipe(
      Effect.gen(function* () {
        const stack = yield* HandlerStack;
        const self = yield* Ref.make(0);

        const id = yield* stack.push({
          name: "self-removing",
          scroll: () =>
            Effect.gen(function* () {
              yield* stack.remove(yield* Ref.get(self));
              return CONTINUE_BUBBLING;
            }),
        });
        yield* pipe(self, Ref.set(id));

        yield* stack.bubble("scroll", event());
        assert.isFalse(yield* stack.has(id));
        assert.strictEqual(yield* stack.depth, 0);
      }),
      Effect.provide(HandlerStack.layer),
    ),
  );

  it.effect("drops everything on a reset", () =>
    pipe(
      Effect.gen(function* () {
        const stack = yield* HandlerStack;
        const seen = yield* Ref.make<readonly string[]>([]);

        yield* stack.push(record("a", seen));
        yield* stack.push(record("b", seen));
        yield* stack.reset;

        assert.strictEqual(yield* stack.depth, 0);
        assert.deepEqual(yield* stack.names, []);
      }),
      Effect.provide(HandlerStack.layer),
    ),
  );

  it.effect("gives each handler its own identity", () =>
    pipe(
      Effect.gen(function* () {
        const stack = yield* HandlerStack;
        const seen = yield* Ref.make<readonly string[]>([]);

        const first = yield* stack.push(record("same", seen));
        const second = yield* stack.push(record("same", seen));
        assert.notStrictEqual(first, second);

        yield* stack.remove(first);
        assert.isFalse(yield* stack.has(first));
        assert.isTrue(yield* stack.has(second));
      }),
      Effect.provide(HandlerStack.layer),
    ),
  );
});
