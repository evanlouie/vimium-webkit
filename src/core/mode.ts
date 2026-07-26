/**
 * Modes: stack frames with a lifecycle.
 *
 * Ported from upstream Vimium's `content_scripts/mode.js` (MIT). A mode is a
 * handler plus the standard exit conditions (escape / blur / click / focus) and
 * an optional singleton group, so that entering find mode automatically leaves
 * visual mode without either knowing about the other.
 */

import {
  CONTINUE_BUBBLING,
  type Handler,
  type HandlerId,
  type HandlerResult,
  HandlerStack,
  SUPPRESS_EVENT,
} from "./handler-stack.ts";

export type ModeIndicator = string | null;

export interface ModeOptions {
  readonly name: string;
  /** Text shown in the HUD while the mode is active. `null` shows nothing. */
  readonly indicator?: ModeIndicator;
  readonly exitOnEscape?: boolean;
  readonly exitOnBlur?: EventTarget | null;
  readonly exitOnClick?: boolean;
  readonly exitOnFocus?: boolean;
  /**
   * Swallow every keyboard event while active. Used by the "cache all keydowns"
   * bootstrap mode and by modal overlays that own the keyboard outright.
   */
  readonly suppressAllKeyboardEvents?: boolean;
  /**
   * Only one mode per group may be live; pushing a second exits the first.
   * Mirrors Vimium's `singleton` option.
   */
  readonly singleton?: string;
}

export interface ModeHost {
  readonly handlerStack: HandlerStack;
  /** Called whenever the top-most indicator changes; wired to the HUD. */
  setIndicator(indicator: ModeIndicator): void;
}

const singletons = new Map<string, Mode>();

/** Live modes, innermost last. Used to compute the current indicator. */
const active: Mode[] = [];

export class Mode {
  readonly name: string;
  readonly indicator: ModeIndicator;

  readonly #host: ModeHost;
  readonly #options: ModeOptions;
  readonly #exitHandlers: Array<(reason: ExitReason) => void> = [];

  #handlerId: HandlerId | null = null;
  #exited = false;

  constructor(host: ModeHost, options: ModeOptions) {
    this.#host = host;
    this.#options = options;
    this.name = options.name;
    this.indicator = options.indicator ?? null;
  }

  get isActive(): boolean {
    return this.#handlerId !== null && !this.#exited;
  }

  /** Subclasses override; the base implementation ignores everything. */
  protected handlers(): Omit<Handler, "name"> {
    return {};
  }

  /**
   * Enter, or re-enter after an exit.
   *
   * Modes are explicitly **re-usable**: the feature singletons in `stage1.ts`
   * are memoised objects, and every one of them is exited and re-entered across
   * a soft navigation or an exclusion change. Latching `#exited` on the first
   * `exit()` therefore made `isActive` lie, made a second `exit()` return early
   * and leave the handler on the stack forever, and made `onExit()` fire its
   * handler at registration time (CORE-02, PRF-15).
   *
   * Calling `enter()` on a live mode is a no-op, so it doubles as "make sure
   * this is entered".
   */
  enter(): this {
    if (this.#handlerId !== null) return this;
    this.#exited = false;

    const singleton = this.#options.singleton;
    if (singleton !== undefined) {
      singletons.get(singleton)?.exit("singleton");
      singletons.set(singleton, this);
    }

    const own = this.handlers();
    const handler: Handler = {
      name: this.name,
      ...own,
      keydown: (event) => this.#onKeydown(event, own.keydown),
      keypress: (event) => this.#onKeyboardEvent(event, own.keypress),
      keyup: (event) => this.#onKeyboardEvent(event, own.keyup),
      click: (event) => this.#onClick(event, own.click),
      focus: (event) => this.#onFocus(event, own.focus),
      blur: (event) => this.#onBlur(event, own.blur),
    };

    this.#handlerId = this.#host.handlerStack.push(handler);
    active.push(this);
    this.#refreshIndicator();
    return this;
  }

  exit(reason: ExitReason = "explicit"): void {
    if (this.#exited) return;
    this.#exited = true;

    if (this.#handlerId !== null) {
      this.#host.handlerStack.remove(this.#handlerId);
      this.#handlerId = null;
    }

    const index = active.indexOf(this);
    if (index !== -1) active.splice(index, 1);

    const singleton = this.#options.singleton;
    if (singleton !== undefined && singletons.get(singleton) === this) {
      singletons.delete(singleton);
    }

    for (const handler of this.#exitHandlers.splice(0)) {
      try {
        handler(reason);
      } catch (cause) {
        console.error("[vimium-webkit] mode exit handler threw", cause);
      }
    }

    this.#refreshIndicator();
  }

  onExit(handler: (reason: ExitReason) => void): void {
    if (this.#exited) handler("explicit");
    else this.#exitHandlers.push(handler);
  }

  #refreshIndicator(): void {
    for (let i = active.length - 1; i >= 0; i--) {
      const mode = active[i];
      if (mode !== undefined && mode.indicator !== null) {
        this.#host.setIndicator(mode.indicator);
        return;
      }
    }
    this.#host.setIndicator(null);
  }

  #onKeydown(
    event: KeyboardEvent,
    own: ((event: KeyboardEvent) => HandlerResult) | undefined,
  ): HandlerResult {
    if (this.#options.exitOnEscape === true && isEscape(event)) {
      this.exit("escape");
      // Suppressed so the page does not also react — matching Vimium, and
      // matching what a user pressing Escape to leave *our* mode expects.
      return SUPPRESS_EVENT;
    }
    return this.#onKeyboardEvent(event, own);
  }

  #onKeyboardEvent(
    event: KeyboardEvent,
    own: ((event: KeyboardEvent) => HandlerResult) | undefined,
  ): HandlerResult {
    const result = own?.call(this, event);
    if (result !== undefined) return result;
    return this.#options.suppressAllKeyboardEvents === true
      ? SUPPRESS_EVENT
      : CONTINUE_BUBBLING;
  }

  #onClick(
    event: MouseEvent,
    own: ((event: MouseEvent) => HandlerResult) | undefined,
  ): HandlerResult {
    if (this.#options.exitOnClick === true) this.exit("click");
    return own?.call(this, event) ?? CONTINUE_BUBBLING;
  }

  #onFocus(
    event: FocusEvent,
    own: ((event: FocusEvent) => HandlerResult) | undefined,
  ): HandlerResult {
    if (this.#options.exitOnFocus === true) this.exit("focus");
    return own?.call(this, event) ?? CONTINUE_BUBBLING;
  }

  #onBlur(
    event: FocusEvent,
    own: ((event: FocusEvent) => HandlerResult) | undefined,
  ): HandlerResult {
    const target = this.#options.exitOnBlur;
    if (target !== null && target !== undefined && event.target === target) {
      this.exit("blur");
    }
    return own?.call(this, event) ?? CONTINUE_BUBBLING;
  }
}

export type ExitReason =
  | "explicit"
  | "escape"
  | "blur"
  | "click"
  | "focus"
  | "singleton"
  | "navigation";

/**
 * Escape detection.
 *
 * `<c-[>` is accepted as an Escape synonym exactly as in Vim and in upstream
 * Vimium; on a Mac laptop without a physical Escape it is the only ergonomic
 * way out of a mode.
 */
export const isEscape = (event: KeyboardEvent): boolean =>
  event.key === "Escape" ||
  (event.ctrlKey && (event.key === "[" || event.code === "BracketLeft"));

/** Exit every live mode. Used on navigation and on `pagehide`. */
export const exitAllModes = (reason: ExitReason = "navigation"): void => {
  for (const mode of [...active].reverse()) mode.exit(reason);
};

/** The innermost live mode's name. Diagnostics and tests. */
export const activeModeNames = (): readonly string[] =>
  active.map((mode) => mode.name);
