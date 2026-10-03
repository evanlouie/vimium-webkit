/**
 * Read exactly one more keystroke.
 *
 * `m` and `` ` `` use it. It is a mode, and not a bare handler, although the
 * interaction is one key. A bare handler was invisible to `exitAll`, so a soft
 * navigation between `m` and the letter left it armed across the navigation. It
 * also replaced whatever indicator a live mode owned, instead of taking part in
 * the indicator stack, and a failing callback took the keystroke with it.
 *
 * The mode owns the keyboard outright while it waits. A stray `j` between `m`
 * and the letter must not scroll the page.
 */

import { Deferred, Effect, Option, flow, pipe } from "effect";
import { SUPPRESS_EVENT } from "~/core/HandlerStack.ts";
import { ExitTrigger, KeyPolicy, Modes } from "~/core/Modes.ts";
import { isComposing, isModifierKey, type KeyContext, keyNotation } from "~/domain/Key.ts";
import { whenSome } from "~/domain/Prelude.ts";

export interface CaptureKeyOptions {
  /** The text that the HUD shows while the mode waits, for example `Set mark:`. */
  readonly prompt: string;
  /**
   * How to read the key: the layout option of the user, and the platform.
   *
   * The caller supplies it, because a caller that has no `Settings` dependency
   * must still be able to ask for one key.
   */
  readonly context: KeyContext;
}

/**
 * The notation of a keystroke that completes a character.
 *
 * A dead key or an input method is in the middle of a character, and a
 * modifier alone is no character. Neither answers, so the mode stays armed and
 * waits for the result.
 */
const typedNotation = (context: KeyContext): ((event: KeyboardEvent) => Option.Option<string>) =>
  flow(
    Option.liftPredicate((event: KeyboardEvent) => !isComposing(event) && !isModifierKey(event)),
    Option.flatMap((event) => keyNotation(event, context)),
  );

/**
 * Wait for one keystroke, and give its notation.
 *
 * `None` means that the user left the mode instead: Escape, a click, or a
 * navigation that exited every mode.
 */
export const captureNextKey: (
  options: CaptureKeyOptions,
) => Effect.Effect<Option.Option<string>, never, Modes> = Effect.fnUntraced(function* (
  options: CaptureKeyOptions,
) {
  const modes = yield* Modes;
  const answer = yield* Deferred.make<Option.Option<string>>();

  const handle = yield* modes.enter(
    {
      name: "capture-next-key",
      indicator: Option.some(options.prompt),
      exitOn: [ExitTrigger.Escape()],
      keyboard: KeyPolicy.Owned(),
      singleton: Option.some("capture-next-key"),
    },
    {
      keydown: flow(
        typedNotation(options.context),
        whenSome((notation) =>
          pipe(answer, Deferred.succeed(Option.some(notation)), Effect.asVoid),
        ),
        Effect.as(SUPPRESS_EVENT),
      ),
    },
  );

  // The mode can also end without a key. The caller must never wait for a
  // keystroke that can no longer arrive.
  yield* handle.onExit(() => pipe(answer, Deferred.succeed(Option.none<string>()), Effect.asVoid));

  const notation = yield* Deferred.await(answer);
  yield* handle.exit("explicit");
  return notation;
}, Effect.scoped);
