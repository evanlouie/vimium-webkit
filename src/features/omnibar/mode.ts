/**
 * The omnibar mode: who owns the keyboard while the overlay is open.
 *
 * The overlay's input is a real in-page element inside our closed shadow root,
 * so the handler stack sees every keystroke the user aims at it. That is a
 * problem and an opportunity:
 *
 * - **Problem.** `SUPPRESS_EVENT` calls `preventDefault`, so blanket-suppressing
 *   would stop the input receiving any text at all.
 * - **Opportunity.** Because we see the events first, we can consume exactly
 *   the navigation keys and hand everything else on with `PASS_EVENT_TO_PAGE`,
 *   which stops the stack walk — so normal mode and insert mode never see a
 *   character typed into the omnibar — while leaving the default action intact
 *   so the input still types it.
 *
 * The mode is declared `suppressAllKeyboardEvents`, which is the backstop: any
 * keyboard event this class does not explicitly classify is swallowed rather
 * than leaking into the page's bindings.
 */

import type { AppContext } from "~/core/context.ts";
import {
  CONTINUE_BUBBLING,
  type Handler,
  type HandlerResult,
  PASS_EVENT_TO_PAGE,
  SUPPRESS_EVENT,
  SUPPRESS_PROPAGATION,
} from "~/core/handler-stack.ts";
import { isComposing } from "~/core/key-notation.ts";
import { isEscape, Mode } from "~/core/mode.ts";

export type OmnibarKeyAction =
  | "previous"
  | "next"
  | "accept"
  | "accept-new-tab"
  | "cancel";

export interface OmnibarModeConfig {
  readonly app: AppContext;
  /** True while the event target is the overlay's own input. */
  readonly ownsFocus: (target: EventTarget | null) => boolean;
  readonly onAction: (action: OmnibarKeyAction) => void;
}

/**
 * Classify a keydown into an omnibar action.
 *
 * Pure and exported so the binding table can be read — and changed — without
 * reasoning about the handler stack. `Ctrl+N`/`Ctrl+P` are accepted alongside
 * the arrows for the same reason readline has them, and for consistency with
 * find mode's history cycling.
 */
export const omnibarAction = (
  event: KeyboardEvent,
): OmnibarKeyAction | null => {
  if (isEscape(event)) return "cancel";

  switch (event.key) {
    case "ArrowUp":
      return "previous";
    case "ArrowDown":
      return "next";
    case "Tab":
      return event.shiftKey ? "previous" : "next";
    case "Enter":
      return event.shiftKey ? "accept-new-tab" : "accept";
    default:
      break;
  }

  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    if (event.key === "p") return "previous";
    if (event.key === "n") return "next";
  }
  return null;
};

export class OmnibarMode extends Mode {
  readonly #config: OmnibarModeConfig;

  constructor(config: OmnibarModeConfig) {
    super(config.app.modeHost, {
      name: "omnibar",
      indicator: null,
      // Escape is handled below rather than by the base class, so that the
      // overlay is torn down and focus restored before the mode frame goes.
      exitOnEscape: false,
      // The backstop, not the mechanism: see the module comment.
      suppressAllKeyboardEvents: true,
      singleton: "omnibar",
    });
    this.#config = config;
  }

  protected override handlers(): Omit<Handler, "name"> {
    return {
      keydown: (event: KeyboardEvent): HandlerResult => this.#onKeydown(event),
      keypress: (event: KeyboardEvent): HandlerResult =>
        this.#passIfOurs(event),
      keyup: (event: KeyboardEvent): HandlerResult => this.#passIfOurs(event),
      focus: (event: FocusEvent): HandlerResult =>
        // Stop insert mode, which sits below us, from treating focus on our own
        // input as the page asking for insert mode.
        this.#config.ownsFocus(event.target)
          ? SUPPRESS_PROPAGATION
          : CONTINUE_BUBBLING,
    };
  }

  #onKeydown(event: KeyboardEvent): HandlerResult {
    // An IME is mid-composition; every key belongs to the composition session.
    if (isComposing(event)) return this.#passIfOurs(event);

    const action = omnibarAction(event);
    if (action !== null) {
      this.#config.onAction(action);
      // `preventDefault` matters for more than tidiness here: without it Tab
      // moves focus out of the overlay and Up/Down move the input's caret.
      return SUPPRESS_EVENT;
    }

    return this.#passIfOurs(event);
  }

  /**
   * Let the overlay's input have the key; swallow anything from elsewhere.
   *
   * `PASS_EVENT_TO_PAGE` stops the stack walk without touching the event, which
   * is precisely "our input types this, nothing else reacts". Page listeners on
   * `document` do still observe it, retargeted to our shadow host — unavoidable
   * without the extension-origin iframe upstream Vimium uses and we cannot.
   */
  #passIfOurs(event: KeyboardEvent): HandlerResult {
    return this.#config.ownsFocus(event.target)
      ? PASS_EVENT_TO_PAGE
      : SUPPRESS_EVENT;
  }
}
