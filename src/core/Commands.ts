/**
 * The command registry.
 *
 * The catalogue — every command, its description, its tier and its group — is
 * pure data in `~/domain/Command.ts`. This service holds the *bodies*, and a
 * feature layer puts its own bodies in when it is built.
 *
 * That split is what keeps the graph a tree. The key handler reads the
 * registry, so it never imports a feature. A feature registers into the
 * registry, so it never imports another feature. The help dialog and the
 * mapping compiler read the catalogue, so neither needs a body at all.
 *
 * A tier C command has no body on purpose. It is still in the catalogue, so the
 * help dialog shows it, greyed out, beside the native browser shortcut, and a
 * key press gives an explanation instead of silence.
 */

import { Context, Effect, Layer, Option, Ref, Schema } from "effect";
import {
  type CommandDef,
  type CommandGroup,
  type CommandName,
  COMMANDS,
} from "~/domain/Command.ts";

export type {
  CommandDef,
  CommandGroup,
  CommandName,
  CommandTier,
} from "~/domain/Command.ts";

export const CommandFailureReason = Schema.Literals([
  /** No command of that name is in the catalogue. */
  "unknown",
  /** The command is in the catalogue, and nothing can run it here. */
  "unavailable",
  /** The body ran and it failed. */
  "failed",
]);

export type CommandFailureReason = typeof CommandFailureReason.Type;

export class CommandError extends Schema.TaggedErrorClass<CommandError>()(
  "CommandError",
  {
    reason: CommandFailureReason,
    command: Schema.String,
    detail: Schema.String,
  },
) {}

export interface CommandInvocation {
  /** The count prefix. It is 1 when the user typed no count. */
  readonly count: number;
  /** Options from the `map` line, for example `LinkHints.activate swap=true`. */
  readonly options: Readonly<Record<string, string | boolean>>;
  /** The event that started this, when there is one. The clipboard needs it. */
  readonly event: KeyboardEvent | null;
}

/** A command body. It must not fail; it reports to the user instead. */
export type CommandBody<R> = (
  invocation: CommandInvocation,
) => Effect.Effect<void, never, R>;

export class Commands extends Context.Service<Commands, {
  /**
   * Give a body to one command.
   *
   * The services that the body needs are captured once, here. The key path then
   * runs the body with nothing left to supply.
   */
  readonly register: <R>(
    name: CommandName,
    body: CommandBody<R>,
  ) => Effect.Effect<void, never, R>;

  /** Give a body to several commands that share one implementation. */
  readonly registerAll: <R>(
    bodies: Partial<Record<CommandName, CommandBody<R>>>,
  ) => Effect.Effect<void, never, R>;

  readonly run: (
    name: string,
    invocation: CommandInvocation,
  ) => Effect.Effect<void, CommandError>;

  /** True when a body is present for this command in this frame. */
  readonly isRunnable: (name: CommandName) => Effect.Effect<boolean>;

  readonly definition: (name: string) => Option.Option<CommandDef>;
  readonly all: ReadonlyArray<CommandDef>;
  readonly names: ReadonlyArray<CommandName>;
  readonly byGroup: ReadonlyMap<CommandGroup, ReadonlyArray<CommandDef>>;
}>()("vimium/core/Commands") {
  static readonly layer: Layer.Layer<Commands> = Layer.effect(
    Commands,
    Effect.gen(function*() {
      const bodies = yield* Ref.make<
        ReadonlyMap<CommandName, CommandBody<never>>
      >(new Map());

      const register = <R>(
        name: CommandName,
        body: CommandBody<R>,
      ): Effect.Effect<void, never, R> =>
        Effect.gen(function*() {
          const services = yield* Effect.context<R>();
          const bound: CommandBody<never> = (invocation) =>
            Effect.provideContext(body(invocation), services);
          yield* Ref.update(bodies, (current) => {
            const next = new Map(current);
            next.set(name, bound);
            return next;
          });
        });

      const run = Effect.fn("Commands.run")(
        function*(name: string, invocation: CommandInvocation) {
          const definition = definitionOf(name);
          if (Option.isNone(definition)) {
            return yield* new CommandError({
              reason: "unknown",
              command: name,
              detail: `there is no command named ${name}`,
            });
          }

          const body = (yield* Ref.get(bodies)).get(definition.value.name);
          if (body === undefined) {
            return yield* new CommandError({
              reason: "unavailable",
              command: name,
              detail: definition.value.unavailableReason ??
                `${name} cannot run in this frame`,
            });
          }

          const outcome = yield* Effect.exit(body(invocation));
          if (outcome._tag === "Failure") {
            return yield* new CommandError({
              reason: "failed",
              command: name,
              detail: `${name} failed`,
            });
          }
        },
      );

      return Commands.of({
        register,
        registerAll: <R>(
          entries: Partial<Record<CommandName, CommandBody<R>>>,
        ) =>
          Effect.forEach(
            Object.entries(entries) as ReadonlyArray<
              readonly [CommandName, CommandBody<R>]
            >,
            ([name, body]) => register(name, body),
            { discard: true },
          ),
        run,
        isRunnable: (name) =>
          Effect.map(Ref.get(bodies), (current) => current.has(name)),
        definition: definitionOf,
        all: COMMAND_LIST,
        names: COMMAND_NAMES,
        byGroup: COMMANDS_BY_GROUP,
      });
    }),
  );
}

const COMMAND_LIST: ReadonlyArray<CommandDef> = Object.values(COMMANDS);

const COMMAND_NAMES: ReadonlyArray<CommandName> = COMMAND_LIST.map(
  (definition) => definition.name,
);

const COMMANDS_BY_GROUP: ReadonlyMap<
  CommandGroup,
  ReadonlyArray<CommandDef>
> = (() => {
  const grouped = new Map<CommandGroup, CommandDef[]>();
  for (const definition of COMMAND_LIST) {
    const bucket = grouped.get(definition.group);
    if (bucket === undefined) grouped.set(definition.group, [definition]);
    else bucket.push(definition);
  }
  return grouped;
})();

const definitionOf = (name: string): Option.Option<CommandDef> =>
  Option.fromNullishOr(
    (COMMANDS as Readonly<Record<string, CommandDef>>)[name] ?? null,
  );
