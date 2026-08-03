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

import { Deferred, Effect, Option } from "effect";
import { SUPPRESS_EVENT } from "~/core/HandlerStack.ts";
import { Modes } from "~/core/Modes.ts";
import { isComposing, isModifierKey, keyNotation } from "~/domain/Key.ts";

export interface CaptureKeyOptions {
  /** The text that the HUD shows while the mode waits, for example `Set mark:`. */
  readonly prompt: string;
  /**
   * Read the physical key, and not the character of the layout.
   *
   * The caller supplies it, because a caller that has no `Settings` dependency
   * must still be able to ask for one key.
   */
  readonly ignoreKeyboardLayout?: boolean;
}

/**
 * Wait for one keystroke, and give its notation.
 *
 * `None` means that the user left the mode instead: Escape, a click, or a
 * navigation that exited every mode.
 */
export const captureNextKey = (
  options: CaptureKeyOptions,
): Effect.Effect<Option.Option<string>, never, Modes> =>
  Effect.scoped(Effect.gen(function*() {
    const modes = yield* Modes;
    const answer = yield* Deferred.make<Option.Option<string>>();

    const handle = yield* modes.enter({
      name: "capture-next-key",
      indicator: options.prompt,
      exitOnEscape: true,
      suppressAllKeyboardEvents: true,
      singleton: "capture-next-key",
    }, {
      keydown: (event) =>
        Effect.gen(function*() {
          // A dead key or an input method is in the middle of a character.
          // Stay armed and wait for the result.
          if (isComposing(event) || isModifierKey(event)) {
            return SUPPRESS_EVENT;
          }
          const notation = keyNotation(
            event,
            options.ignoreKeyboardLayout ?? false,
          );
          if (Option.isNone(notation)) return SUPPRESS_EVENT;
          yield* Deferred.succeed(answer, notation);
          return SUPPRESS_EVENT;
        }),
    });

    // The mode can also end without a key. The caller must never wait for a
    // keystroke that can no longer arrive.
    yield* handle.onExit(() =>
      Effect.asVoid(Deferred.succeed(answer, Option.none()))
    );

    const notation = yield* Deferred.await(answer);
    yield* handle.exit("explicit");
    return notation;
  }));
