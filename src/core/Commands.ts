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

import {
  Array,
  Context,
  Effect,
  HashMap,
  Layer,
  Option,
  Record,
  Ref,
  Result,
  Schema,
  Struct,
  flow,
  pipe,
} from "effect";
import {
  type CommandDef,
  type CommandGroup,
  type CommandName,
  COMMANDS,
} from "~/domain/Command.ts";

export type { CommandDef, CommandGroup, CommandName, CommandTier } from "~/domain/Command.ts";

export const CommandFailureReason = Schema.Literals([
  /** No command of that name is in the catalogue. */
  "unknown",
  /** The command is in the catalogue, and nothing can run it here. */
  "unavailable",
  /** The body ran and it failed. */
  "failed",
]);

export type CommandFailureReason = typeof CommandFailureReason.Type;

export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  reason: CommandFailureReason,
  command: Schema.String,
  detail: Schema.String,
}) {}

export interface CommandInvocation {
  /** The count prefix. It is 1 when the user typed no count. */
  readonly count: number;
  /** Options from the `map` line, for example `LinkHints.activate swap=true`. */
  readonly options: Record.ReadonlyRecord<string, string | boolean>;
  /** The event that started this, when there is one. The clipboard needs it. */
  readonly event: KeyboardEvent | null;
}

/** A command body. It must not fail; it reports to the user instead. */
export type CommandBody<R> = (invocation: CommandInvocation) => Effect.Effect<void, never, R>;

export class Commands extends Context.Service<
  Commands,
  {
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
      bodies: Partial<Record.ReadonlyRecord<CommandName, CommandBody<R>>>,
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
  }
>()("vimium/core/Commands") {
  static readonly layer: Layer.Layer<Commands> = Layer.effect(
    Commands,
    Effect.gen(function* () {
      // Keyed by the name of the command, which a record would widen to a string.
      const bodies = yield* Ref.make(HashMap.empty<CommandName, CommandBody<never>>());

      const register = <R>(
        name: CommandName,
        body: CommandBody<R>,
      ): Effect.Effect<void, never, R> =>
        Effect.gen(function* () {
          const services = yield* Effect.context<R>();
          const bound: CommandBody<never> = flow(body, Effect.provideContext(services));
          yield* pipe(bodies, Ref.update(HashMap.set(name, bound)));
        });

      const run = Effect.fn("Commands.run")(function* (
        name: string,
        invocation: CommandInvocation,
      ) {
        const definition = yield* pipe(
          definitionOf(name),
          Result.fromOption(
            () =>
              new CommandError({
                reason: "unknown",
                command: name,
                detail: `there is no command named ${name}`,
              }),
          ),
          Effect.fromResult,
        );

        const body = yield* pipe(
          Ref.get(bodies),
          Effect.map(HashMap.get(definition.name)),
          Effect.flatMap(
            flow(
              Result.fromOption(
                () =>
                  new CommandError({
                    reason: "unavailable",
                    command: name,
                    detail: definition.unavailableReason ?? `${name} cannot run in this frame`,
                  }),
              ),
              Effect.fromResult,
            ),
          ),
        );

        yield* pipe(
          body(invocation),
          Effect.catchCause(() =>
            Effect.fail(
              new CommandError({
                reason: "failed",
                command: name,
                detail: `${name} failed`,
              }),
            ),
          ),
        );
      });

      return Commands.of({
        register,
        registerAll: (entries) =>
          pipe(
            COMMAND_NAMES,
            Effect.forEach(
              (name) =>
                pipe(
                  entries,
                  Struct.get(name),
                  Option.fromUndefinedOr,
                  Option.match({
                    onNone: () => Effect.void,
                    onSome: (body) => register(name, body),
                  }),
                ),
              { discard: true },
            ),
          ),
        run,
        isRunnable: (name) => pipe(Ref.get(bodies), Effect.map(HashMap.has(name))),
        definition: definitionOf,
        all: COMMAND_LIST,
        names: COMMAND_NAMES,
        byGroup: COMMANDS_BY_GROUP,
      });
    }),
  );
}

/** Every command, by a name that may not be one. */
const COMMANDS_BY_NAME: Record.ReadonlyRecord<string, CommandDef> = COMMANDS;

const COMMAND_LIST: ReadonlyArray<CommandDef> = Record.values(COMMANDS_BY_NAME);

const COMMAND_NAMES: ReadonlyArray<CommandName> = pipe(
  COMMAND_LIST,
  Array.map((definition) => definition.name),
);

/** Every group with its commands, in the order of the first command of each group. */
const COMMANDS_BY_GROUP: ReadonlyMap<CommandGroup, ReadonlyArray<CommandDef>> = pipe(
  COMMAND_LIST,
  Array.map((definition) => definition.group),
  Array.dedupe,
  Array.map(
    (group) =>
      [
        group,
        pipe(
          COMMAND_LIST,
          Array.filter((definition) => definition.group === group),
        ),
      ] as const,
  ),
  (groups) => new Map(groups),
);

const definitionOf = (name: string): Option.Option<CommandDef> =>
  pipe(COMMANDS_BY_NAME, Record.get(name));
