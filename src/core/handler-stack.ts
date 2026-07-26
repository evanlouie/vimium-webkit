/**
 * The handler stack.
 *
 * A direct port of upstream Vimium's `lib/handler_stack.js` (MIT). The design
 * is engine-neutral and load-bearing: modes are stack frames, and a handler
 * returns a sentinel describing what should happen to the event next. Making
 * those sentinels unique symbols (rather than Vimium's plain booleans) means
 * the compiler catches a handler that forgets to return one.
 */

// ---------------------------------------------------------------------------
// Sentinels
// ---------------------------------------------------------------------------

/** Keep walking down the stack. */
export const CONTINUE_BUBBLING = Symbol("continueBubbling");
/** Stop here; the page still sees the event. */
export const PASS_EVENT_TO_PAGE = Symbol("passEventToPage");
/** `stopImmediatePropagation` + `preventDefault`. */
export const SUPPRESS_EVENT = Symbol("suppressEvent");
/** `stopImmediatePropagation` only — the default action still happens. */
export const SUPPRESS_PROPAGATION = Symbol("suppressPropagation");
/** Re-run the whole stack from the top; used after a mode pushes another mode. */
export const RESTART_BUBBLING = Symbol("restartBubbling");

export type HandlerResult =
  | typeof CONTINUE_BUBBLING
  | typeof PASS_EVENT_TO_PAGE
  | typeof SUPPRESS_EVENT
  | typeof SUPPRESS_PROPAGATION
  | typeof RESTART_BUBBLING;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export interface HandlerEventMap {
  keydown: KeyboardEvent;
  keypress: KeyboardEvent;
  keyup: KeyboardEvent;
  click: MouseEvent;
  mousedown: MouseEvent;
  focus: FocusEvent;
  blur: FocusEvent;
  scroll: Event;
}

export type HandlerEventName = keyof HandlerEventMap;

export type Handler =
  & { readonly name: string }
  & {
    [K in HandlerEventName]?: (event: HandlerEventMap[K]) => HandlerResult;
  };

export type HandlerId = number;

interface StackEntry {
  readonly id: HandlerId;
  readonly handler: Handler;
}

/**
 * `stopImmediatePropagation`, not `stopPropagation`.
 *
 * We may lose the listener-registration race to page scripts — `document-start`
 * is unreliable on WebKit (§7.1) — so a page listener registered *before* ours
 * on the same target would still run under plain `stopPropagation`.
 */
const suppressPropagation = (event: Event): void => {
  event.stopImmediatePropagation();
};

const suppressEvent = (event: Event): void => {
  event.preventDefault();
  event.stopImmediatePropagation();
};

export class HandlerStack {
  #stack: StackEntry[] = [];
  #nextId: HandlerId = 0;
  #currentId: HandlerId | null = null;

  /** Handler ids pushed during the current `bubbleEvent`, for `RESTART_BUBBLING`. */
  #generation = 0;

  get depth(): number {
    return this.#stack.length;
  }

  /** Names of the live handlers, innermost last. Diagnostics only. */
  get names(): readonly string[] {
    return this.#stack.map((entry) => entry.handler.name);
  }

  /** Push onto the top of the stack; it sees events first. */
  push(handler: Handler): HandlerId {
    const id = ++this.#nextId;
    this.#stack.push({ id, handler });
    this.#generation++;
    return id;
  }

  /** Insert at the bottom of the stack; it sees events last. */
  unshift(handler: Handler): HandlerId {
    const id = ++this.#nextId;
    this.#stack.unshift({ id, handler });
    this.#generation++;
    return id;
  }

  remove(id: HandlerId | null = this.#currentId): void {
    if (id === null) return;
    const index = this.#stack.findIndex((entry) => entry.id === id);
    if (index !== -1) {
      this.#stack.splice(index, 1);
      this.#generation++;
    }
  }

  has(id: HandlerId): boolean {
    return this.#stack.some((entry) => entry.id === id);
  }

  /**
   * Walk the stack from the top, giving each handler a chance at the event.
   *
   * @returns `true` if the event should continue to the page.
   */
  bubbleEvent<K extends HandlerEventName>(
    name: K,
    event: HandlerEventMap[K],
  ): boolean {
    // Iterate over a snapshot: handlers routinely push and pop modes.
    let index = this.#stack.length - 1;

    while (index >= 0) {
      const entry = this.#stack[index];
      index--;
      if (entry === undefined) continue;

      const fn = entry.handler[name];
      if (typeof fn !== "function") continue;

      const previousId = this.#currentId;
      this.#currentId = entry.id;
      let result: HandlerResult;
      try {
        result = (fn as (e: HandlerEventMap[K]) => HandlerResult).call(
          entry.handler,
          event,
        );
      } catch (cause) {
        // A throwing handler must not wedge the key pipeline for the whole
        // page; drop the frame and keep bubbling.
        this.#reportHandlerError(entry.handler.name, name, cause);
        this.remove(entry.id);
        result = CONTINUE_BUBBLING;
      } finally {
        this.#currentId = previousId;
      }

      switch (result) {
        case CONTINUE_BUBBLING:
          continue;
        case PASS_EVENT_TO_PAGE:
          return true;
        case SUPPRESS_EVENT:
          suppressEvent(event);
          return false;
        case SUPPRESS_PROPAGATION:
          suppressPropagation(event);
          return false;
        case RESTART_BUBBLING:
          index = this.#stack.length - 1;
          continue;
      }
    }

    return true;
  }

  #onError: ((message: string, cause: unknown) => void) | null = null;

  /** Wire this to the HUD/console once Stage 1 is up. */
  onHandlerError(listener: (message: string, cause: unknown) => void): void {
    this.#onError = listener;
  }

  #reportHandlerError(
    handlerName: string,
    eventName: string,
    cause: unknown,
  ): void {
    const message = `handler "${handlerName}" threw during ${eventName}`;
    if (this.#onError) this.#onError(message, cause);
    else console.error(`[vimium-webkit] ${message}`, cause);
  }

  /** Drop every handler. Used on `pagehide` and by the exclusion machinery. */
  reset(): void {
    this.#stack = [];
    this.#generation++;
  }
}

/** Wrap a side-effecting function so it always continues bubbling. */
export const alwaysContinue = <A extends readonly unknown[]>(
  fn: (...args: A) => unknown,
): (...args: A) => HandlerResult =>
(...args: A) => {
  fn(...args);
  return CONTINUE_BUBBLING;
};

/** Wrap a side-effecting function so it always suppresses the event. */
export const alwaysSuppress = <A extends readonly unknown[]>(
  fn: (...args: A) => unknown,
): (...args: A) => HandlerResult =>
(...args: A) => {
  fn(...args);
  return SUPPRESS_EVENT;
};
