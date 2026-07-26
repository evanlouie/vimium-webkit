/**
 * The omnibar overlay.
 *
 * Lives in the `"omnibar"` layer of the single closed shadow root, so page CSS
 * cannot reach it and page script cannot walk into it. Two consequences the
 * rest of the subsystem is built around:
 *
 * - The input is a **real in-page element** and therefore participates in the
 *   page's focus. Focus alone cannot be trusted to route keys here, which is
 *   why `OmnibarMode` claims the keyboard on the handler stack instead.
 * - The panel is positioned against `app.ui.viewport()`, never
 *   `window.innerHeight`: on iOS the keyboard shrinks the visual viewport while
 *   the layout viewport is unchanged, and a panel positioned against the latter
 *   ends up underneath the keyboard the user is typing on (§7.8).
 */

import type { AppContext } from "~/core/context.ts";
import { rafCoalesce } from "~/platform/scheduler.ts";
import type { Completion } from "./completers.ts";

/** Fraction of the viewport height the panel's top edge sits at. */
const TOP_FRACTION = 0.12;

export interface OmnibarViewConfig {
  readonly app: AppContext;
  readonly placeholder: string;
  readonly onInput: (value: string) => void;
  /** A row was clicked. `newTab` mirrors Shift+Enter. */
  readonly onActivate: (index: number, newTab: boolean) => void;
  /** Focus left the overlay entirely. */
  readonly onDismiss: () => void;
}

export class OmnibarView {
  readonly #config: OmnibarViewConfig;
  readonly #container: HTMLElement;
  readonly #panel: HTMLElement;
  readonly #prefix: HTMLElement;
  readonly #input: HTMLInputElement;
  readonly #list: HTMLElement;
  readonly #footer: HTMLElement;
  readonly #reposition: (() => void) & { cancel: () => void };
  /** Restored on dispose so closing the omnibar does not steal the page's focus. */
  readonly #previousFocus: Element | null;

  #rows: readonly HTMLElement[] = [];
  #disposed = false;

  constructor(config: OmnibarViewConfig) {
    this.#config = config;
    this.#previousFocus = document.activeElement;

    const container = document.createElement("div");
    container.className = "vw-omnibar";

    const panel = document.createElement("div");
    panel.className = "vw-omnibar__panel";
    container.appendChild(panel);

    const field = document.createElement("div");
    field.className = "vw-omnibar__field";
    panel.appendChild(field);

    const prefix = document.createElement("span");
    prefix.className = "vw-omnibar__prefix";
    field.appendChild(prefix);

    const input = document.createElement("input");
    input.className = "vw-omnibar__input";
    input.type = "text";
    input.placeholder = config.placeholder;
    // The page's autofill and spellcheck have no business inside our overlay,
    // and an autocomplete dropdown here would sit on top of our own list.
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    field.appendChild(input);

    const list = document.createElement("ul");
    list.className = "vw-omnibar__list";
    panel.appendChild(list);

    const footer = document.createElement("div");
    footer.className = "vw-omnibar__footer";
    panel.appendChild(footer);

    this.#container = container;
    this.#panel = panel;
    this.#prefix = prefix;
    this.#input = input;
    this.#list = list;
    this.#footer = footer;

    config.app.ui.layer("omnibar").appendChild(container);

    this.#reposition = rafCoalesce(() => this.#applyViewport());
    this.#addListeners();
    this.#applyViewport();
  }

  get value(): string {
    return this.#input.value;
  }

  /** True while our own input holds focus; keeps insert mode from claiming it. */
  ownsFocus(target: EventTarget | null): boolean {
    return target === this.#input;
  }

  setValue(value: string): void {
    this.#input.value = value;
    const end = value.length;
    this.#input.setSelectionRange(end, end);
  }

  setPrefix(text: string): void {
    this.#prefix.textContent = text;
  }

  setFooter(text: string): void {
    this.#footer.textContent = text;
    this.#footer.hidden = text.length === 0;
  }

  focus(): void {
    // `preventScroll`: focusing an element inside a fixed overlay otherwise
    // makes WebKit scroll the *page* to reveal it.
    this.#input.focus({ preventScroll: true });
  }

  render(completions: readonly Completion[], selected: number): void {
    if (this.#disposed) return;

    if (completions.length === 0) {
      this.#rows = [];
      const empty = document.createElement("li");
      empty.className = "vw-omnibar__empty";
      empty.textContent = "No matches";
      this.#list.replaceChildren(empty);
      return;
    }

    const rows = completions.map((completion, index) =>
      this.#buildRow(completion, index === selected)
    );
    this.#rows = rows;
    this.#list.replaceChildren(...rows);

    const active = rows[selected];
    if (active !== undefined) {
      active.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#reposition.cancel();
    this.#removeListeners();
    this.#container.remove();
    this.#rows = [];

    const previous = this.#previousFocus;
    if (previous instanceof HTMLElement && previous.isConnected) {
      previous.focus({ preventScroll: true });
    }
  }

  #buildRow(completion: Completion, selected: boolean): HTMLElement {
    const row = document.createElement("li");
    const classes = ["vw-omnibar__row"];
    if (selected) classes.push("vw-omnibar__row--selected");
    if (completion.muted) classes.push("vw-omnibar__row--muted");
    row.className = classes.join(" ");

    const badge = document.createElement("span");
    badge.className = "vw-omnibar__badge";
    badge.textContent = completion.badge;
    row.appendChild(badge);

    const body = document.createElement("span");
    body.className = "vw-omnibar__body";
    row.appendChild(body);

    // `textContent` throughout, never `innerHTML`: titles come from pages we
    // visited and suggestions come off the network, so both are untrusted and
    // would otherwise be an injection vector into our own overlay.
    const title = document.createElement("span");
    title.className = "vw-omnibar__title";
    title.textContent = completion.title;
    body.appendChild(title);

    if (completion.detail.length > 0) {
      const detail = document.createElement("span");
      detail.className = "vw-omnibar__detail";
      detail.textContent = completion.detail;
      body.appendChild(detail);
    }

    if (completion.nativeAlternative !== null) {
      const native = document.createElement("span");
      native.className = "vw-omnibar__native";
      native.textContent = completion.nativeAlternative;
      row.appendChild(native);
    }

    return row;
  }

  #onInput = (): void => {
    this.#config.onInput(this.#input.value);
  };

  /**
   * Keep focus in the input when the user reaches for a row.
   *
   * Without this, `mousedown` blurs the input, the blur handler dismisses the
   * omnibar, and the `click` never lands on anything.
   */
  #onPanelMouseDown = (event: MouseEvent): void => {
    if (event.target !== this.#input) event.preventDefault();
  };

  #onPanelClick = (event: MouseEvent): void => {
    const index = this.#rows.findIndex((row) =>
      event.target instanceof Node && row.contains(event.target)
    );
    if (index === -1) return;
    this.#config.onActivate(index, event.shiftKey || event.metaKey);
  };

  #onBlur = (): void => {
    // Deferred by a task: a click on a row blurs the input for a tick before
    // focus comes back, so only a focus that has genuinely left our shadow
    // root counts as a dismissal.
    setTimeout(() => {
      if (this.#disposed) return;
      if (this.ownsFocus(this.#shadowActiveElement())) return;
      this.#config.onDismiss();
    }, 0);
  };

  /** The focused node *inside* our closed shadow root, which `document` hides. */
  #shadowActiveElement(): Element | null {
    const root = this.#container.getRootNode();
    return root instanceof ShadowRoot ? root.activeElement : null;
  }

  #applyViewport(): void {
    if (this.#disposed) return;
    const viewport = this.#config.app.ui.viewport();
    const style = this.#container.style;
    style.transform =
      `translate(${viewport.offsetLeft}px, ${viewport.offsetTop}px)`;
    style.width = `${viewport.width}px`;
    style.height = `${viewport.height}px`;
    style.paddingTop = `${Math.round(viewport.height * TOP_FRACTION)}px`;
  }

  #addListeners(): void {
    this.#input.addEventListener("input", this.#onInput);
    this.#input.addEventListener("blur", this.#onBlur);
    this.#panel.addEventListener("mousedown", this.#onPanelMouseDown);
    this.#panel.addEventListener("click", this.#onPanelClick);
    globalThis.addEventListener("resize", this.#reposition, { passive: true });
    const visual = globalThis.visualViewport;
    if (visual) {
      visual.addEventListener("resize", this.#reposition, { passive: true });
      visual.addEventListener("scroll", this.#reposition, { passive: true });
    }
  }

  #removeListeners(): void {
    this.#input.removeEventListener("input", this.#onInput);
    this.#input.removeEventListener("blur", this.#onBlur);
    this.#panel.removeEventListener("mousedown", this.#onPanelMouseDown);
    this.#panel.removeEventListener("click", this.#onPanelClick);
    globalThis.removeEventListener("resize", this.#reposition);
    const visual = globalThis.visualViewport;
    if (visual) {
      visual.removeEventListener("resize", this.#reposition);
      visual.removeEventListener("scroll", this.#reposition);
    }
  }
}
