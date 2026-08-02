/**
 * The bridge from the browser's key dispatch into the handler stack.
 *
 * Everything on this path runs inside the browser's own dispatch, because
 * `preventDefault` works nowhere else. `Dom.listen` gives that guarantee: it
 * runs the handler with `runSyncExit`, so the whole effect completes before the
 * browser continues.
 *
 * The rule that comes with the guarantee: nothing that this file can reach may
 * suspend. Read `ARCHITECTURE.md` section 3.
 */

import { Effect, type Scope } from "effect";
import { HandlerStack } from "~/core/HandlerStack.ts";
import { isUserEvent, Keyboard } from "~/core/Keyboard.ts";
import { Dom } from "~/platform/Dom.ts";

/**
 * Attach every listener that the handler stack needs.
 *
 * `click`, `focus` and `blur` are here, and not in the guard, because they only
 * mean something once modes exist, and because `focus` and `blur` occur
 * constantly on a busy page.
 *
 * A `keydown` or a `keyup` that the page made is dropped here. The page can
 * dispatch a `KeyboardEvent` that names any key, and a mapped key runs a
 * command that can open a tab, navigate or write the clipboard. `isTrusted`
 * separates the user from the page, and only the browser can set it.
 *
 * `focus` and `blur` keep the composed path. A focus inside an open shadow root
 * is retargeted to the host before a window listener sees it, so a handler that
 * needs the true node reads `event.composedPath()`. `features/Insert.ts` does
 * that.
 */
export const attachKeyBridge: Effect.Effect<
  void,
  never,
  Dom | HandlerStack | Keyboard | Scope.Scope
> = Effect.gen(function*() {
  const dom = yield* Dom;
  const stack = yield* HandlerStack;
  const keyboard = yield* Keyboard;

  yield* dom.listen(
    "window",
    "keydown",
    (event) =>
      isUserEvent(event)
        ? Effect.asVoid(stack.bubble("keydown", event))
        : Effect.void,
    { capture: true },
  );

  yield* dom.listen(
    "window",
    "keyup",
    (event) =>
      isUserEvent(event)
        ? Effect.asVoid(stack.bubble("keyup", event))
        : Effect.void,
    { capture: true },
  );

  yield* dom.listen(
    "window",
    "click",
    (event) => Effect.asVoid(stack.bubble("click", event)),
    { capture: true },
  );

  yield* dom.listen(
    "window",
    "focus",
    (event) => Effect.asVoid(stack.bubble("focus", event)),
    { capture: true },
  );

  yield* dom.listen(
    "window",
    "blur",
    (event) => Effect.asVoid(stack.bubble("blur", event)),
    { capture: true },
  );

  // A press whose release we will never see leaves normal mode waiting for a
  // `keyup` that never comes. The everyday case is a window switch in the
  // middle of a keystroke. The next release of that physical key would then be
  // taken from a page that was entitled to it.
  yield* dom.listen("window", "blur", () => keyboard.forgetSuppressed);
});

/** Replay the keys that the guard held while the application started. */
export const replayBufferedKeys = (
  events: ReadonlyArray<KeyboardEvent>,
): Effect.Effect<void, never, HandlerStack> =>
  Effect.gen(function*() {
    const stack = yield* HandlerStack;
    for (const event of events) {
      yield* stack.bubble("keydown", event);
    }
  });
