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
import { Scroller } from "~/features/Scroller.ts";
import { Dom } from "~/platform/Dom.ts";

/**
 * Attach every listener that the handler stack needs.
 *
 * `click`, `focus` and `blur` are here, and not in the guard. They mean
 * something only once modes exist. `focus` and `blur` also occur constantly on
 * a busy page.
 *
 * A `keydown`, a `keyup`, a `focus` or a `blur` that the page made is dropped
 * here. The page can dispatch a `KeyboardEvent` that names any key. A mapped
 * key then runs a command, and a command can open a tab, navigate or write the
 * clipboard. `isTrusted` separates the user from the page, and only the browser
 * can set it.
 *
 * A page-made `focus` or `blur` is as dangerous as a page-made key. A `blur`
 * that names the focused field leaves insert mode. The next true key of the
 * user then runs a command inside a text field. A `focus` on any text field
 * starts insert mode and stops every binding.
 *
 * `click` keeps every event. Hint activation dispatches its own pointer events,
 * and a mode that exits on a click must see them.
 *
 * `focus` and `blur` keep the composed path. A focus inside an open shadow root
 * is retargeted to the host before a window listener sees it. A handler that
 * needs the true node therefore reads `event.composedPath()`.
 * `features/Insert.ts` does that.
 *
 * The scroller learns about each press here, before the stack decides what the
 * press means. It counts the presses and it holds the set of keys that are
 * down, and it needs both to answer "is this the same press as the animation
 * that runs now". Nothing called those two methods, so every command looked
 * like the same press, and a new command could merge into an animation for an
 * old target. Both methods only write a `Ref`, so the key path stays
 * synchronous. Read `ARCHITECTURE.md` section 3.
 */
export const attachKeyBridge: Effect.Effect<
  void,
  never,
  Dom | HandlerStack | Keyboard | Scroller | Scope.Scope
> = Effect.gen(function*() {
  const dom = yield* Dom;
  const stack = yield* HandlerStack;
  const keyboard = yield* Keyboard;
  const scroller = yield* Scroller;

  yield* dom.listen(
    "window",
    "keydown",
    (event) =>
      isUserEvent(event)
        ? Effect.gen(function*() {
          // Before the dispatch. A command body reads the generation that
          // this call increases.
          yield* scroller.noteKeydown(event);
          yield* stack.bubble("keydown", event);
        })
        : Effect.void,
    { capture: true },
  );

  yield* dom.listen(
    "window",
    "keyup",
    (event) =>
      isUserEvent(event)
        ? Effect.gen(function*() {
          // Before the dispatch, like the press. The order inside one
          // dispatch is not observable to the animation, which reads the set
          // on a frame, but one rule for both is easier to keep.
          yield* scroller.noteKeyup(event);
          yield* stack.bubble("keyup", event);
        })
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
    (event) =>
      isUserEvent(event)
        ? Effect.asVoid(stack.bubble("focus", event))
        : Effect.void,
    { capture: true },
  );

  yield* dom.listen(
    "window",
    "blur",
    (event) =>
      isUserEvent(event)
        ? Effect.asVoid(stack.bubble("blur", event))
        : Effect.void,
    { capture: true },
  );

  // A press whose release we will never see leaves normal mode waiting for a
  // `keyup` that never comes. The everyday case is a window switch in the
  // middle of a keystroke. The next release of that physical key would then be
  // taken from a page that was entitled to it.
  //
  // The page must not reach this either. A page-made `blur` would give the page
  // the release of a press that we took.
  yield* dom.listen(
    "window",
    "blur",
    (event) => isUserEvent(event) ? keyboard.forgetSuppressed : Effect.void,
  );
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
