/**
 * The command registry.
 *
 * The catalogue — every command, its description, its availability and its
 * group — is pure data in `~/domain/Command.ts`. This service holds the
 * *bodies*, and a feature layer puts its own bodies in when it is built.
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
  CommandAvailability,
  type CommandDef,
  type CommandName,
  COMMANDS,
} from "~/domain/Command.ts";
import { recoverEvenIfInterrupted } from "./Recovery.ts";

export const CommandFailureReason = Schema.Literals([
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
  /** The key event that started this, when there is one. The scroller reads it. */
  readonly event: Option.Option<KeyboardEvent>;
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
      name: CommandName,
      invocation: CommandInvocation,
    ) => Effect.Effect<void, CommandError>;

    readonly all: ReadonlyArray<CommandDef>;
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
        name: CommandName,
        invocation: CommandInvocation,
      ) {
        const body = yield* pipe(
          Ref.get(bodies),
          Effect.map(HashMap.get(name)),
          Effect.flatMap(
            flow(
              Result.fromOption(
                () =>
                  new CommandError({
                    reason: "unavailable",
                    command: name,
                    detail: pipe(
                      COMMANDS,
                      Struct.get(name),
                      Struct.get("availability"),
                      CommandAvailability.$match({
                        Available: () => `${name} cannot run in this frame`,
                        Unavailable: ({ reason }) => reason,
                      }),
                    ),
                  }),
              ),
              Effect.fromResult,
            ),
          ),
        );

        yield* pipe(
          body(invocation),
          recoverEvenIfInterrupted(
            `the command ${name}`,
            Effect.failSync(
              () =>
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
        all: COMMAND_LIST,
      });
    }),
  );
}

const COMMAND_LIST: ReadonlyArray<CommandDef> = Record.values(COMMANDS);

const COMMAND_NAMES: ReadonlyArray<CommandName> = Record.keys(COMMANDS);
