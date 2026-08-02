/**
 * The command registry.
 *
 * The catalogue is pure data, and this service holds the bodies. A feature
 * puts its body in when its layer is built, so the key handler never imports a
 * feature.
 */

import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Layer, Option, Ref } from "effect";
import { COMMANDS } from "~/domain/Command.ts";
import { type CommandInvocation, Commands } from "~/core/Commands.ts";

/** A press with no count, no options and no event. */
const invocation: CommandInvocation = { count: 1, options: {}, event: null };

/** A service that a command body needs, to prove that `register` captures it. */
class Counter extends Context.Service<Counter, {
  readonly bump: Effect.Effect<void>;
  readonly value: Effect.Effect<number>;
}>()("test/Counter") {
  static readonly layer: Layer.Layer<Counter> = Layer.effect(
    Counter,
    Effect.map(Ref.make(0), (ref) =>
      Counter.of({
        bump: Ref.update(ref, (count) => count + 1),
        value: Ref.get(ref),
      })),
  );
}

describe("Commands", () => {
  it.effect("runs a body that was registered", () =>
    Effect.gen(function*() {
      const commands = yield* Commands;
      const ran = yield* Ref.make<readonly number[]>([]);

      yield* commands.register("scrollDown", (call) =>
        Ref.update(ran, (current) => [...current, call.count]));

      assert.isTrue(yield* commands.isRunnable("scrollDown"));
      yield* commands.run("scrollDown", { ...invocation, count: 3 });
      assert.deepEqual(yield* Ref.get(ran), [3]);
    }).pipe(Effect.provide(Commands.layer)));

  it.effect("captures the services that a body needs", () =>
    Effect.gen(function*() {
      const commands = yield* Commands;
      const counter = yield* Counter;

      // The body needs `Counter`, and `run` needs nothing. The registration is
      // where the service is supplied.
      yield* commands.register("scrollUp", () => counter.bump);
      yield* commands.run("scrollUp", invocation);
      assert.strictEqual(yield* counter.value, 1);
    }).pipe(Effect.provide(Commands.layer), Effect.provide(Counter.layer)));

  it.effect("registers several commands at once", () =>
    Effect.gen(function*() {
      const commands = yield* Commands;
      const ran = yield* Ref.make<readonly string[]>([]);

      yield* commands.registerAll({
        scrollDown: () => Ref.update(ran, (c) => [...c, "down"]),
        scrollUp: () => Ref.update(ran, (c) => [...c, "up"]),
      });

      yield* commands.run("scrollUp", invocation);
      yield* commands.run("scrollDown", invocation);
      assert.deepEqual(yield* Ref.get(ran), ["up", "down"]);
    }).pipe(Effect.provide(Commands.layer)));

  it.effect("fails with `unknown` for a name that is not in the catalogue", () =>
    Effect.gen(function*() {
      const commands = yield* Commands;
      const outcome = yield* Effect.flip(
        commands.run("noSuchCommand", invocation),
      );
      assert.strictEqual(outcome.reason, "unknown");
      assert.strictEqual(outcome.command, "noSuchCommand");
    }).pipe(Effect.provide(Commands.layer)));

  it.effect("fails with `unavailable` for a command that has no body", () =>
    Effect.gen(function*() {
      const commands = yield* Commands;
      assert.isFalse(yield* commands.isRunnable("scrollDown"));

      const outcome = yield* Effect.flip(
        commands.run("scrollDown", invocation),
      );
      assert.strictEqual(outcome.reason, "unavailable");
      assert.include(outcome.detail, "scrollDown");
    }).pipe(Effect.provide(Commands.layer)));

  it.effect("gives the reason of a tier C command as the detail", () =>
    Effect.gen(function*() {
      // A press of `J` must explain why tab control is impossible.
      const commands = yield* Commands;
      const outcome = yield* Effect.flip(
        commands.run("previousTab", invocation),
      );
      assert.strictEqual(outcome.reason, "unavailable");
      assert.strictEqual(
        outcome.detail,
        COMMANDS.previousTab.unavailableReason,
      );
    }).pipe(Effect.provide(Commands.layer)));

  it.effect("fails with `failed` when the body fails", () =>
    Effect.gen(function*() {
      const commands = yield* Commands;
      yield* commands.register(
        "scrollDown",
        () => Effect.die(new Error("boom")),
      );

      const outcome = yield* Effect.flip(
        commands.run("scrollDown", invocation),
      );
      assert.strictEqual(outcome.reason, "failed");
      assert.strictEqual(outcome.command, "scrollDown");
    }).pipe(Effect.provide(Commands.layer)));

  it.effect("replaces a body that was registered before", () =>
    Effect.gen(function*() {
      const commands = yield* Commands;
      const ran = yield* Ref.make<readonly string[]>([]);

      yield* commands.register(
        "scrollDown",
        () => Ref.update(ran, (current) => [...current, "first"]),
      );
      yield* commands.register(
        "scrollDown",
        () => Ref.update(ran, (current) => [...current, "second"]),
      );

      yield* commands.run("scrollDown", invocation);
      assert.deepEqual(yield* Ref.get(ran), ["second"]);
    }).pipe(Effect.provide(Commands.layer)));

  it.effect("gives the catalogue through its accessors", () =>
    Effect.gen(function*() {
      const commands = yield* Commands;

      assert.lengthOf(commands.all, Object.keys(COMMANDS).length);
      assert.lengthOf(commands.names, commands.all.length);
      assert.include(commands.names, "scrollDown");

      const definition = commands.definition("scrollDown");
      assert.isTrue(Option.isSome(definition));
      if (Option.isNone(definition)) return;
      assert.strictEqual(definition.value.group, "scrolling");
      assert.isTrue(Option.isNone(commands.definition("noSuchCommand")));

      const scrolling = commands.byGroup.get("scrolling") ?? [];
      assert.isAbove(scrolling.length, 0);
      const total = [...commands.byGroup.values()]
        .reduce((sum, group) => sum + group.length, 0);
      assert.strictEqual(total, commands.all.length);
    }).pipe(Effect.provide(Commands.layer)));
});
