/**
 * The overlay host: one closed shadow root for the entire extension.
 *
 * This is the single highest-leverage design decision for WebKit
 * (IMPLEMENTATION_PLAN.md §6.3). It solves three problems at once:
 *
 * - **Page CSP.** Safari enforces the page's `style-src` on DOM nodes injected
 *   by content scripts, unlike Chrome. Inserting rules through CSSOM
 *   (`adoptedStyleSheets`) is not a `style-src` fetch, so it is not blocked.
 *   Unlike `GM_addElement`, constructable stylesheets exist on every manager.
 * - **Page CSS bleed.** `all: initial` on the host plus a shadow boundary means
 *   no page rule and no inherited property reaches us.
 * - **Detectability.** A `closed` root cannot be walked into, restyled, or
 *   removed by selector from page script.
 *
 * There are deliberately **no iframes**. Upstream Vimium hosts its HUD,
 * Vomnibar, and help dialog in `web_accessible_resources` iframes; a userscript
 * has no such origin, and `frame-src` would block a `blob:` frame anyway.
 */

import type { Capabilities } from "~/platform/capabilities.ts";
import type { UiLayerName, UiRoot, ViewportRect } from "~/core/context.ts";
import { rafCoalesce } from "~/platform/scheduler.ts";
import { BASE_CSS } from "./styles.ts";

/**
 * Host styling, applied through CSSOM rather than as a `style` attribute.
 *
 * A `style` attribute is governed by `style-src-attr` (falling back to
 * `style-src`), so under a `style-src 'self'` policy Safari discards the
 * declarations entirely and reports a violation. CSP does not police CSSOM, so
 * writing the same properties through `element.style.*` is the only way to keep
 * `all: initial`, the stacking context, and the visual-viewport transform on
 * exactly the strict-CSP sites that most need them.
 */
const HOST_STYLE: ReadonlyArray<readonly [string, string]> = [
  ["all", "initial"],
  ["position", "fixed"],
  ["inset", "0"],
  ["pointer-events", "none"],
  ["z-index", "2147483647"],
  ["display", "block"],
  ["margin", "0"],
  ["padding", "0"],
  ["border", "0"],
];

/** Layer stacking order, lowest first. */
const LAYER_ORDER: readonly UiLayerName[] = [
  "hints",
  "find",
  "hud",
  "omnibar",
  "dialog",
];

/** Layers that accept pointer events while populated. */
const INTERACTIVE_LAYERS: ReadonlySet<UiLayerName> = new Set([
  "omnibar",
  "dialog",
]);

export interface UiRootOptions {
  readonly caps: Capabilities;
  /** Injection seam for tests. */
  readonly document?: Document;
}

class ShadowUiRoot implements UiRoot {
  readonly shadow: ShadowRoot;

  readonly #doc: Document;
  readonly #caps: Capabilities;
  readonly #host: HTMLElement;
  readonly #layers = new Map<UiLayerName, HTMLElement>();
  readonly #sheets: CSSStyleSheet[] = [];
  readonly #onViewportChange: (() => void) | null;

  #fallbackStyle: HTMLStyleElement | null = null;
  #destroyed = false;

  constructor(options: UiRootOptions) {
    this.#doc = options.document ?? document;
    this.#caps = options.caps;

    this.#host = this.#doc.createElement("vimium-webkit-overlay");
    for (const [property, value] of HOST_STYLE) {
      // `setProperty` rather than the camelCase accessors: `all` and `inset`
      // are shorthands that some engines do not surface as IDL attributes.
      this.#host.style.setProperty(property, value);
    }
    // Assistive tech should not see an empty positioning container; individual
    // layers opt back in when they render something meaningful.
    this.#host.setAttribute("aria-hidden", "true");

    this.shadow = this.#host.attachShadow({ mode: "closed" });
    this.#installStyle(BASE_CSS);

    for (const name of LAYER_ORDER) {
      const layer = this.#doc.createElement("div");
      layer.className = "vw-layer";
      layer.dataset["layer"] = name;
      if (INTERACTIVE_LAYERS.has(name)) layer.dataset["interactive"] = "false";
      this.shadow.appendChild(layer);
      this.#layers.set(name, layer);
    }

    this.#attach();

    // The visual viewport moves independently of the layout viewport under
    // iOS's dynamic toolbar and during pinch-zoom; anything positioned `fixed`
    // has to be nudged to compensate. See §7.8.
    const visual = globalThis.visualViewport;
    if (visual) {
      const update = rafCoalesce(() => this.#syncViewport());
      this.#onViewportChange = () => update();
      visual.addEventListener("resize", this.#onViewportChange);
      visual.addEventListener("scroll", this.#onViewportChange);
      this.#syncViewport();
    } else {
      this.#onViewportChange = null;
    }
  }

  /**
   * (Re-)insert the host.
   *
   * Called on construction and again from `layer()`, because single-page apps
   * routinely replace `document.body` — and some replace `documentElement` —
   * which silently detaches us. An `isConnected` check is a single bit read, so
   * paying it per access is cheaper than any observer would be.
   */
  #attach(): void {
    if (this.#destroyed || this.#host.isConnected) return;
    const parent = this.#doc.documentElement ?? this.#doc.body;
    // At `document-start` in a well-behaved manager there may be no
    // `documentElement` yet. Callers are lazy, so simply doing nothing here is
    // correct: the next `layer()` call re-tries.
    parent?.appendChild(this.#host);
  }

  layer(name: UiLayerName): HTMLElement {
    this.#attach();
    const layer = this.#layers.get(name);
    if (layer) return layer;
    // Unreachable given LAYER_ORDER, but the map lookup is typed as optional
    // and fabricating a detached element beats throwing inside a key handler.
    const orphan = this.#doc.createElement("div");
    orphan.className = "vw-layer";
    return orphan;
  }

  /** Mark a layer as accepting pointer events (used while a modal is open). */
  setInteractive(name: UiLayerName, interactive: boolean): void {
    const layer = this.#layers.get(name);
    if (layer) layer.dataset["interactive"] = String(interactive);
  }

  addStyle(css: string): void {
    this.#installStyle(css);
  }

  /**
   * Does this event target belong to our overlay?
   *
   * The root is `closed`, so an event originating inside it is **retargeted to
   * the host** before any `window`-level listener sees it. Comparing against the
   * inner element therefore always fails from outside, which is how a
   * capture-phase handler ends up swallowing the very keystrokes our own text
   * field was supposed to receive. Both forms are accepted here: the host, and
   * the real node as seen from a listener attached inside the shadow tree.
   */
  owns(target: EventTarget | null): boolean {
    if (target === null) return false;
    if (target === this.#host) return true;
    return target instanceof Node && this.shadow.contains(target);
  }

  #installStyle(css: string): void {
    if (this.#caps.adoptedStyleSheets) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        this.#sheets.push(sheet);
        this.shadow.adoptedStyleSheets = this.#sheets;
        return;
      } catch {
        // Fall through to the element path below.
      }
    }

    // Documented fallback for engines below Safari 16.4 / Chrome 111.
    // A `<style>` element inside a shadow root is still subject to the page's
    // `style-src` on Safari, so this path is CSP-fragile by construction —
    // `capabilities.ts` warns the user when we land here.
    this.#fallbackStyle ??= (() => {
      const element = this.#doc.createElement("style");
      this.shadow.insertBefore(element, this.shadow.firstChild);
      return element;
    })();
    this.#fallbackStyle.textContent += `\n${css}`;
  }

  /**
   * Translate the whole overlay so `position: fixed` children line up with the
   * *visual* viewport rather than the layout viewport.
   */
  #syncViewport(): void {
    const visual = globalThis.visualViewport;
    if (!visual) return;
    const { offsetLeft, offsetTop, scale } = visual;
    this.#host.style.transform = offsetLeft === 0 && offsetTop === 0
      ? ""
      : `translate(${offsetLeft}px, ${offsetTop}px)`;
    this.#host.style.width = `${visual.width}px`;
    this.#host.style.height = `${visual.height}px`;
    this.#host.style.setProperty("--vw-scale", String(scale));
  }

  viewport(): ViewportRect {
    const visual = globalThis.visualViewport;
    if (visual) {
      return {
        offsetLeft: visual.offsetLeft,
        offsetTop: visual.offsetTop,
        width: visual.width,
        height: visual.height,
        scale: visual.scale,
      };
    }
    return {
      offsetLeft: 0,
      offsetTop: 0,
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
      scale: 1,
    };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    const visual = globalThis.visualViewport;
    if (visual && this.#onViewportChange) {
      visual.removeEventListener("resize", this.#onViewportChange);
      visual.removeEventListener("scroll", this.#onViewportChange);
    }
    this.#host.remove();
    this.#layers.clear();
  }
}

export type { ShadowUiRoot };

export const createUiRoot = (options: UiRootOptions): ShadowUiRoot =>
  new ShadowUiRoot(options);
