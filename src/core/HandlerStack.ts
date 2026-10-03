/**
 * What a mode handler answers.
 *
 * Modes are the frames of a stack, and `core/Modes.ts` keeps that stack. A
 * handler of a mode answers each event with a value that says what must happen
 * to the event next.
 *
 * The design comes from upstream Vimium's `lib/handler_stack.js` (MIT).
 *
 * A handler body is an `Effect`, and it must not suspend. The stack runs it
 * inside the browser's own dispatch, because `preventDefault` works nowhere
 * else. Read the section "The keyboard path is synchronous" of
 * `ARCHITECTURE.md`.
 */

import type { Effect } from "effect";

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/**
 * What must happen to the event next.
 *
 * A string union, and not a set of symbols. A `unique symbol` widens to plain
 * `symbol` whenever it passes through a generic, so a handler that gave the
 * wrong answer still typechecked, and sixteen call sites needed a cast to say
 * what they had already said. A string union survives inference, reads in a log
 * and crosses no boundary that a symbol would.
 */
export type HandlerResult =
  /** Continue down the stack. */
  | "continue"
  /** Stop here. The page still sees the event. */
  | "pass-to-page"
  /** `stopImmediatePropagation` and `preventDefault`. */
  | "suppress"
  /** `stopImmediatePropagation` only. The default action still happens. */
  | "suppress-propagation";

export const CONTINUE_BUBBLING: HandlerResult = "continue";
export const PASS_EVENT_TO_PAGE: HandlerResult = "pass-to-page";
export const SUPPRESS_EVENT: HandlerResult = "suppress";
export const SUPPRESS_PROPAGATION: HandlerResult = "suppress-propagation";

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** The events that the key bridge gives the stack. */
export interface HandlerEventMap {
  readonly keydown: KeyboardEvent;
  readonly keypress: KeyboardEvent;
  readonly keyup: KeyboardEvent;
  readonly click: MouseEvent;
  readonly focus: FocusEvent;
  readonly blur: FocusEvent;
}

export type HandlerEventName = keyof HandlerEventMap;

/**
 * The bodies of a mode, one for each event that it answers.
 *
 * `R` is what the bodies need. `Modes.enter` captures those services once, so
 * a body needs nothing when the key path runs it.
 */
export type Handlers<R = never> = {
  readonly [K in HandlerEventName]?: (
    event: HandlerEventMap[K],
  ) => Effect.Effect<HandlerResult, never, R>;
};
