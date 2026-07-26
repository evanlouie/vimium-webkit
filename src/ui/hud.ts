/**
 * The HUD: transient messages, the mode indicator, and the single-line prompt.
 *
 * Upstream Vimium renders this in a `web_accessible_resources` iframe. We
 * cannot, so the input below is a *real in-page element* participating in the
 * page's focus. Two consequences are designed around here:
 *
 * - `ownsFocus()` exists so `InsertMode` can tell our input apart from the
 *   page's and not treat focusing it as entering insert mode.
 * - Page listeners on `document` still observe keydowns aimed at this input,
 *   retargeted to the shadow host. That is unavoidable without an
 *   extension-origin iframe (§6.3) and is accepted.
 */

import type { HudApi, HudPromptOptions, UiLayerName } from "~/core/context.ts";
import type { ShadowUiRoot } from "./root.ts";

const HUD_LAYER: UiLayerName = "hud";

/** How long an unqualified `show()` message stays up. Matches upstream. */
export const DEFAULT_HUD_DURATION_MS = 2200;

export interface HudOptions {
  readonly root: ShadowUiRoot;
  /** `hideHud` in settings; the indicator and prompt still work. */
  hidden(): boolean;
}

class Hud implements HudApi {
  readonly #root: ShadowUiRoot;
  readonly #hidden: () => boolean;
  readonly #element: HTMLDivElement;
  readonly #text: HTMLSpanElement;

  #timer: number | null = null;
  #indicator: string | null = null;
  /** A transient `show()`/`error()` message is on screen and still within its
   * timer. Tracked separately from the sticky indicator because entering or
   * leaving a mode refreshes the indicator, and that must not wipe a message
   * the user has not had time to read. */
  #transient = false;
  #prompt: ActivePrompt | null = null;

  constructor(options: HudOptions) {
    this.#root = options.root;
    this.#hidden = options.hidden;

    const doc = options.root.shadow.ownerDocument;
    this.#element = doc.createElement("div");
    this.#element.className = "vw-hud";
    this.#element.dataset["visible"] = "false";

    this.#text = doc.createElement("span");
    this.#element.appendChild(this.#text);

    options.root.layer(HUD_LAYER).appendChild(this.#element);
  }

  show(text: string, durationMs: number = DEFAULT_HUD_DURATION_MS): void {
    if (this.#hidden()) return;
    this.#transient = true;
    this.#render(text, "info");
    this.#arm(durationMs);
  }

  error(text: string): void {
    // Errors ignore `hideHud`: silently swallowing a capability refusal is
    // exactly the failure mode goal G3 exists to prevent.
    this.#transient = true;
    this.#render(text, "error");
    this.#arm(DEFAULT_HUD_DURATION_MS * 2);
  }

  /**
   * Does this event target belong to our overlay?
   *
   * Delegated to the UI root, which knows about closed-shadow-root retargeting.
   * Deliberately broader than "the find prompt has focus": every consumer wants
   * the same question answered — `InsertMode` must not claim any of our fields,
   * and every modal mode needs to know whether a keystroke was aimed at its own
   * input or at the page.
   */
  ownsFocus(target: EventTarget | null): boolean {
    return this.#root.owns(target);
  }

  setIndicator(text: string | null): void {
    this.#indicator = text;
    if (this.#prompt !== null) {
      // A prompt is open, so the indicator belongs beside the input rather than
      // replacing it. This is how find's live `3/17` count is displayed.
      this.#prompt.setStatus(text ?? "");
      return;
    }
    // A live message outranks the indicator: modes routinely enter and exit in
    // the same task that produced the message.
    if (this.#transient) return;
    this.#restore();
  }

  hide(): void {
    if (this.#prompt !== null) return;
    this.#clearTimer();
    this.#transient = false;
    this.#restore();
  }

  /** Fall back to the sticky indicator, or nothing. */
  #restore(): void {
    if (this.#indicator !== null) {
      this.#render(this.#indicator, "info");
      return;
    }
    this.#element.dataset["visible"] = "false";
  }

  /** Live match count / status shown to the right of the prompt. */
  setPromptStatus(text: string): void {
    this.#prompt?.setStatus(text);
  }

  prompt(options: HudPromptOptions): Promise<string | null> {
    this.#prompt?.cancel();
    this.#clearTimer();

    const doc = this.#root.shadow.ownerDocument;
    const active = new ActivePrompt(doc, options, () => {
      this.#prompt = null;
      this.#element.dataset["tone"] = "info";
      this.hide();
    });

    this.#prompt = active;
    this.#text.textContent = "";
    this.#element.replaceChildren(this.#text, active.container);
    this.#element.dataset["visible"] = "true";
    this.#element.dataset["tone"] = "info";
    // The HUD layer must accept pointer events while the prompt is live so a
    // click into the field does not fall through to the page.
    this.#root.setInteractive(HUD_LAYER, true);

    active.focus();
    return active.result.finally(() => {
      this.#root.setInteractive(HUD_LAYER, false);
      this.#element.replaceChildren(this.#text);
    });
  }

  #render(text: string, tone: "info" | "error"): void {
    // Written even while a prompt is open: the message slot sits beside the
    // input, so an error raised mid-search stays visible instead of vanishing.
    this.#text.textContent = text;
    this.#element.dataset["tone"] = tone;
    this.#element.dataset["visible"] = "true";
  }

  #arm(durationMs: number): void {
    this.#clearTimer();
    if (durationMs <= 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#transient = false;
      this.#restore();
    }, durationMs);
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  destroy(): void {
    this.#prompt?.cancel();
    this.#clearTimer();
    this.#element.remove();
  }
}

class ActivePrompt {
  readonly container: HTMLSpanElement;
  readonly input: HTMLInputElement;
  readonly result: Promise<string | null>;

  readonly #status: HTMLSpanElement;
  #settle: ((value: string | null) => void) | null = null;
  #done = false;

  constructor(
    doc: Document,
    options: HudPromptOptions,
    onSettled: () => void,
  ) {
    this.container = doc.createElement("span");

    const label = doc.createElement("span");
    label.className = "vw-hud-label";
    label.textContent = options.label;

    this.input = doc.createElement("input");
    this.input.className = "vw-hud-input";
    this.input.type = "text";
    this.input.value = options.initialValue ?? "";
    this.input.placeholder = options.placeholder ?? "";
    // Every autofill/correction affordance is actively harmful for a command
    // line, and iOS turns them all on by default.
    this.input.autocapitalize = "off";
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.setAttribute("autocorrect", "off");

    this.#status = doc.createElement("span");
    this.#status.className = "vw-hud-count";

    this.container.append(label, this.input, this.#status);

    this.result = new Promise<string | null>((resolve) => {
      this.#settle = resolve;
    });

    this.input.addEventListener("input", () => {
      options.onInput?.(this.input.value);
    });

    // Capture phase, and `stopPropagation` on every key: the prompt owns the
    // keyboard outright while it is open, and the handler stack must not see
    // these events at all.
    this.input.addEventListener("keydown", (event: KeyboardEvent) => {
      event.stopPropagation();
      if (options.onKeydown?.(event, this.input.value) === true) {
        event.preventDefault();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        this.#finish(this.input.value);
      } else if (
        event.key === "Escape" || (event.ctrlKey && event.key === "[")
      ) {
        event.preventDefault();
        this.#finish(null);
      }
    }, true);

    this.input.addEventListener("blur", () => {
      // Losing focus means the page or the user moved on; treat it as a cancel
      // rather than leaving an invisible modal owning the keyboard.
      if (!this.#done) this.#finish(null);
    });

    this.result.finally(onSettled);
  }

  setStatus(text: string): void {
    this.#status.textContent = text;
  }

  focus(): void {
    // `preventScroll` matters: focusing without it scrolls the page to the
    // overlay, which is at the bottom of the viewport.
    this.input.focus({ preventScroll: true });
    this.input.setSelectionRange(
      this.input.value.length,
      this.input.value.length,
    );
  }

  cancel(): void {
    this.#finish(null);
  }

  #finish(value: string | null): void {
    if (this.#done) return;
    this.#done = true;
    this.container.remove();
    this.#settle?.(value);
    this.#settle = null;
  }
}

export type { Hud };

export const createHud = (options: HudOptions): Hud => new Hud(options);
