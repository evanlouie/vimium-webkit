/**
 * Insert mode.
 *
 * Ported from upstream Vimium's `content_scripts/mode_insert.js` (MIT).
 *
 * Two flavours, as upstream: *element* insert mode, entered implicitly when an
 * editable element takes focus, and *global* insert mode, entered explicitly
 * with `i`. Both pass every key to the page except Escape.
 */

import {
  CONTINUE_BUBBLING,
  type Handler,
  type HandlerResult,
  PASS_EVENT_TO_PAGE,
  SUPPRESS_EVENT,
} from "~/core/handler-stack.ts";
import { isEscape, Mode, type ModeHost } from "~/core/mode.ts";
import type { AppContext, InsertApi } from "~/core/context.ts";

const EDITABLE_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "search",
  "email",
  "url",
  "number",
  "password",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
  "tel",
]);

export const isEditable = (node: EventTarget | null): node is HTMLElement => {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  if (node instanceof HTMLTextAreaElement) {
    return !node.disabled && !node.readOnly;
  }
  if (node instanceof HTMLSelectElement) return !node.disabled;
  if (node instanceof HTMLInputElement) {
    if (node.disabled || node.readOnly) return false;
    return EDITABLE_INPUT_TYPES.has(node.type.toLowerCase());
  }
  return false;
};

/**
 * The deepest focused element, piercing **open** shadow roots.
 *
 * `document.activeElement` retargets to the shadow host, so without this walk
 * a text field inside a web component looks like a plain custom element and we
 * would keep intercepting the user's typing.
 */
export const deepActiveElement = (): Element | null => {
  let element: Element | null = document.activeElement;
  while (element?.shadowRoot?.activeElement) {
    element = element.shadowRoot.activeElement;
  }
  return element;
};

/** Text-entry targets `gi` should consider, in document order. */
export const focusableInputs = (root: ParentNode = document): HTMLElement[] => {
  const out: HTMLElement[] = [];
  const walk = (scope: ParentNode): void => {
    for (const element of scope.querySelectorAll("*")) {
      if (isEditable(element) && isVisible(element)) out.push(element);
      const shadow = element.shadowRoot;
      if (shadow) walk(shadow);
    }
  };
  walk(root);
  return out;
};

const isVisible = (element: Element): boolean => {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none";
};

class InsertModeImpl extends Mode {
  readonly #app: AppContext;
  /** `null` means global insert mode: every key goes to the page. */
  #element: HTMLElement | null = null;
  #global = false;

  constructor(app: AppContext, host: ModeHost) {
    super(host, {
      name: "insert",
      indicator: null,
      singleton: "insert",
    });
    this.#app = app;
  }

  protected override handlers(): Omit<Handler, "name"> {
    return {
      keydown: (event) => this.#onKeydown(event),
      focus: (event) => this.#onFocus(event),
      blur: (event) => this.#onBlur(event),
    };
  }

  isInserting(): boolean {
    return this.#global || this.#element !== null;
  }

  /** `i` — global insert mode, independent of what has focus. */
  enterGlobal(): void {
    this.#global = true;
    this.#app.hud.setIndicator("Insert mode");
  }

  exitInsert(): void {
    this.#global = false;
    if (this.#element) {
      try {
        this.#element.blur();
      } catch {
        // The page may have detached it.
      }
    }
    this.#element = null;
    this.#app.hud.setIndicator(null);
  }

  #onKeydown(event: KeyboardEvent): HandlerResult {
    if (!this.isInserting()) return CONTINUE_BUBBLING;

    if (isEscape(event)) {
      this.exitInsert();
      // Suppressed: many pages treat Escape as "close this widget", and the
      // user pressing Escape to leave insert mode does not mean that.
      return SUPPRESS_EVENT;
    }
    // `PASS_EVENT_TO_PAGE` rather than `CONTINUE_BUBBLING`: normal mode sits
    // below us on the stack and must not get a look at the keystroke.
    return PASS_EVENT_TO_PAGE;
  }

  #onFocus(event: FocusEvent): HandlerResult {
    const target = event.target;
    // Our own HUD/omnibar inputs live in the page's focus tree because we have
    // no extension-origin iframe (§6.3); they must not trigger insert mode.
    if (this.#app.hud.ownsFocus(target)) return CONTINUE_BUBBLING;
    if (isEditable(target)) {
      this.#element = target;
      this.#app.hud.setIndicator("Insert mode");
    }
    return CONTINUE_BUBBLING;
  }

  #onBlur(event: FocusEvent): HandlerResult {
    if (event.target === this.#element) {
      this.#element = null;
      if (!this.#global) this.#app.hud.setIndicator(null);
    }
    return CONTINUE_BUBBLING;
  }

  /**
   * `gi` — focus a text input.
   *
   * With a count, jump straight to the nth. With more than one candidate and no
   * count, hand off to link hints restricted to inputs, which is both faster
   * and less surprising than upstream's separate overlay.
   */
  focusInput(count: number): void {
    const inputs = focusableInputs();
    if (inputs.length === 0) {
      this.#app.hud.show("No text inputs on this page");
      return;
    }

    const index = Math.min(Math.max(1, count), inputs.length) - 1;
    const target = inputs[index];
    if (!target) return;

    target.focus({ preventScroll: false });
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      const end = target.value.length;
      try {
        target.setSelectionRange(end, end);
      } catch {
        // `setSelectionRange` throws on input types that do not support it.
      }
    }
    this.#element = target;
    this.#app.hud.setIndicator("Insert mode");
  }

  /**
   * Adopt whatever already has focus.
   *
   * Insert mode otherwise only ever learns about focus from live `focus`
   * events, and Stage 1 boots long after the page has autofocused its search
   * box. On DuckDuckGo, on most login pages, and on anything with
   * `<input autofocus>`, that meant the user's first keystrokes were read as
   * commands (OSU-02).
   */
  seedFromFocus(): void {
    const active = deepActiveElement();
    if (this.#app.hud.ownsFocus(active)) return;
    if (isEditable(active)) {
      this.#element = active;
      this.#app.hud.setIndicator("Insert mode");
    }
  }

  /**
   * `grabBackFocus`: some pages steal focus into a search box on load, which
   * silently swallows the user's first keystrokes. Blur it once, and only once,
   * and only if the user has not typed yet.
   */
  grabBackFocus(): void {
    const active = deepActiveElement();
    if (isEditable(active)) {
      active.blur();
      this.#element = null;
      this.#app.hud.setIndicator(null);
    }
  }
}

export type { InsertModeImpl };

/**
 * The public façade.
 *
 * Deliberately not the `Mode` subclass itself: `Mode` already has an `isActive`
 * accessor meaning "is this stack frame live", which is a different question
 * from `InsertApi.isActive()`'s "is the user typing into something".
 */
export interface InsertFeature extends InsertApi {
  /**
   * Make sure the underlying stack frame is live.
   *
   * The feature object is memoised in `stage1.ts`, so after a soft navigation
   * exits every mode the memoised value is an *exited* mode. Constructing it
   * again is not an option — that is the memoisation — so re-entry has to be
   * reachable from outside (CORE-01).
   */
  ensureEntered(): void;
  /** Adopt an element the page focused before Stage 1 existed. */
  seedFromFocus(): void;
  /** Blur a field the page auto-focused on load (`grabBackFocus`). */
  grabBackFocus(): void;
}

export const createInsert = (
  app: AppContext,
  host: ModeHost,
): InsertFeature => {
  const mode = new InsertModeImpl(app, host);
  mode.enter();
  return {
    enter: () => mode.enterGlobal(),
    exit: () => mode.exitInsert(),
    isActive: () => mode.isInserting(),
    focusInput: (count) => mode.focusInput(count),
    ensureEntered: () => void mode.enter(),
    seedFromFocus: () => mode.seedFromFocus(),
    grabBackFocus: () => mode.grabBackFocus(),
  };
};
