/**
 * The bridge from the browser's key dispatch into the mode stack.
 *
 * Everything on this path runs inside the browser's own dispatch, because
 * `preventDefault` works nowhere else. `Dom.listen` gives that guarantee: it
 * runs the handler with `runSyncExit`, so the whole effect completes before the
 * browser continues.
 *
 * The rule that comes with the guarantee: nothing that this file can reach may
 * suspend. Read `ARCHITECTURE.md` section 3.
 */

import { Effect, Option, type Scope, flow, pipe } from "effect";
import type { HandlerEventMap, HandlerEventName } from "~/core/HandlerStack.ts";
import { Keyboard } from "~/core/Keyboard.ts";
import { Modes } from "~/core/Modes.ts";
import { whenSome } from "~/domain/Prelude.ts";
import { Dom, type ListenOptions } from "~/platform/Dom.ts";
import { isUserEvent } from "~/platform/Elements.ts";

/** Every listener of the bridge runs in the capture phase, before the page's own. */
const CAPTURE: ListenOptions = { capture: true };

/** Run `body` for an event that the user made, and drop an event that the page made. */
const fromUser = <E extends Event, R>(
  body: (event: E) => Effect.Effect<void, never, R>,
): ((event: E) => Effect.Effect<void, never, R>) =>
  flow(Option.liftPredicate(isUserEvent), whenSome(body));

/**
 * Attach every listener that the mode stack needs.
 *
 * `click`, `focus` and `blur` are here, and not in the guard. They mean
 * something only once modes exist. `focus` and `blur` also occur constantly on
 * a busy page.
 *
 * A key event, a `focus` or a `blur` that the page made is dropped here. The page can dispatch a `KeyboardEvent` that names any key. A mapped
 * key then runs a command, and a command can open a tab, navigate or write the
 * clipboard. `isTrusted` separates the user from the page, and only the browser
 * can set it.
 *
 * A page-made `focus` or `blur` is as dangerous as a page-made key. A `blur`
 * that names the focused field leaves insert mode. The next true key of the
 * user then runs a command inside a text field. A `focus` on any text field
 * starts insert mode and stops every binding.
 *
 * `keypress` goes through the stack as well. A mode that owns the keyboard
 * takes it, and the find prompt and the omnibar take every `keypress` that is
 * not aimed at their own field. The browser sends no `keypress` for a
 * `keydown` that a mode suppressed.
 *
 * `click` keeps every event. Hint activation dispatches its own pointer events,
 * and a mode that exits on a click must see them.
 *
 * `focus` and `blur` keep the composed path. A focus inside an open shadow root
 * is retargeted to the host before a window listener sees it. A handler that
 * needs the true node therefore reads `event.composedPath()`.
 * `features/Insert.ts` does that.
 */
export const attachKeyBridge: Effect.Effect<void, never, Dom | Keyboard | Modes | Scope.Scope> =
  Effect.gen(function* () {
    const dom = yield* Dom;
    const modes = yield* Modes;
    const keyboard = yield* Keyboard;

    /**
     * Give the event to the mode stack.
     *
     * The stack stops the event itself when a mode asks, so its answer is not
     * needed here.
     */
    const bubble =
      <K extends HandlerEventName>(name: K) =>
      (event: HandlerEventMap[K]): Effect.Effect<void> =>
        Effect.asVoid(modes.bubble(name, event));

    yield* dom.listen("window", "keydown", fromUser(bubble("keydown")), CAPTURE);
    yield* dom.listen("window", "keypress", fromUser(bubble("keypress")), CAPTURE);
    yield* dom.listen("window", "keyup", fromUser(bubble("keyup")), CAPTURE);
    yield* dom.listen("window", "click", bubble("click"), CAPTURE);
    yield* dom.listen("window", "focus", fromUser(bubble("focus")), CAPTURE);
    yield* dom.listen("window", "blur", fromUser(bubble("blur")), CAPTURE);

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
      fromUser(() => keyboard.forgetSuppressed),
    );
  });

/** Replay the keys that the guard held while the application started. */
export const replayBufferedKeys = Effect.fnUntraced(function* (
  events: ReadonlyArray<KeyboardEvent>,
): Effect.fn.Return<void, never, Modes> {
  const modes = yield* Modes;
  yield* pipe(
    events,
    Effect.forEach((event) => modes.bubble("keydown", event), { discard: true }),
  );
});
