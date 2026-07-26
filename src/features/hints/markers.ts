/**
 * Marker rendering.
 *
 * Markers live in the `"hints"` layer of the single closed shadow root, which
 * is `position: fixed` and carries `z-index: 2147483647`. That already escapes
 * every page stacking context, so there is deliberately no `popover` use here:
 * its support varies across the WebKit versions we target and it would buy us
 * nothing we do not already have.
 *
 * Because the layer is viewport-fixed (upstream's markers are document-absolute)
 * two corrections are needed that Vimium does not need:
 *
 * 1. **Scroll.** Rects were measured against the layout viewport at detection
 *    time; if the page scrolls underneath us the whole layer is translated by
 *    the delta rather than re-measuring thousands of elements.
 * 2. **Visual viewport.** On iOS the UI host is translated by the visual
 *    viewport's offset to emulate `position: device-fixed`, so marker
 *    coordinates — which are layout-viewport relative — have to be translated
 *    back by the same amount.
 */

import type { AppContext } from "~/core/context.ts";
import { rafCoalesce } from "~/platform/scheduler.ts";
import type { HintRect } from "./detect.ts";

export interface MarkerSpec {
  readonly rect: HintRect;
  readonly hintString: string;
  /** Leading characters already typed; rendered dimmed. */
  readonly matchedLength: number;
  readonly secondary: boolean;
  /** Filter mode: the candidate `Enter` would activate. */
  readonly active: boolean;
  /** Filter mode: shown beside the number when the hint has no visible text. */
  readonly linkText: string;
  readonly showLinkText: boolean;
  readonly hidden: boolean;
}

/** Keep the marker inside the viewport when a hint sits hard against an edge. */
const MARKER_INSET = 2;

export class MarkerLayer {
  readonly #app: AppContext;
  readonly #container: HTMLElement;
  readonly #markers: HTMLElement[] = [];
  readonly #reposition: (() => void) & { cancel: () => void };

  #originX: number;
  #originY: number;
  #disposed = false;

  constructor(app: AppContext) {
    this.#app = app;
    this.#originX = globalThis.scrollX;
    this.#originY = globalThis.scrollY;

    const layer = app.ui.layer("hints");
    const container = document.createElement("div");
    container.className = "vw-hints";
    layer.appendChild(container);
    this.#container = container;

    // rAF-coalesced: scroll fires far faster than we can usefully repaint, and
    // WebKit throttles rAF to 30 fps in cross-origin frames and Low Power Mode,
    // which is exactly the back-pressure we want here.
    this.#reposition = rafCoalesce(() => this.#applyOffset());
    this.#addListeners();
    this.#applyOffset();
  }

  /**
   * Render `specs`, reusing marker elements across calls.
   *
   * Filter mode re-renders on every keystroke, so allocating a fresh element
   * per marker would mean thousands of node creations per session.
   */
  render(specs: readonly MarkerSpec[]): void {
    if (this.#disposed) return;

    while (this.#markers.length < specs.length) {
      const marker = document.createElement("div");
      marker.className = "vw-hint";
      this.#container.appendChild(marker);
      this.#markers.push(marker);
    }

    for (let index = 0; index < this.#markers.length; index++) {
      const marker = this.#markers[index];
      if (marker === undefined) continue;
      const spec = specs[index];
      if (spec === undefined) {
        marker.className = "vw-hint vw-hint--hidden";
        continue;
      }
      this.#paint(marker, spec);
    }
  }

  clear(): void {
    for (const marker of this.#markers) {
      marker.className = "vw-hint vw-hint--hidden";
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#reposition.cancel();
    this.#removeListeners();
    this.#container.remove();
    this.#markers.length = 0;
  }

  #paint(marker: HTMLElement, spec: MarkerSpec): void {
    const classes = ["vw-hint"];
    if (spec.hidden) classes.push("vw-hint--hidden");
    if (spec.secondary) classes.push("vw-hint--secondary");
    if (spec.active) classes.push("vw-hint--active");
    marker.className = classes.join(" ");
    if (spec.hidden) return;

    const left = Math.max(MARKER_INSET, spec.rect.left);
    const top = Math.max(MARKER_INSET, spec.rect.top);
    // Whole pixels: a marker on a fractional boundary renders blurry, and hint
    // text at 11px has no legibility to spare.
    marker.style.transform = `translate(${Math.round(left)}px, ${
      Math.round(top)
    }px)`;

    this.#paintText(marker, spec);
  }

  #paintText(marker: HTMLElement, spec: MarkerSpec): void {
    const matched = spec.hintString.slice(0, spec.matchedLength);
    const rest = spec.hintString.slice(spec.matchedLength);
    const label = spec.showLinkText ? spec.linkText.slice(0, 40) : "";

    // `textContent` on the parts, never `innerHTML`: link text is page-supplied
    // and would otherwise be an injection vector into our own overlay.
    marker.replaceChildren();
    if (matched.length > 0) {
      const dim = document.createElement("span");
      dim.className = "vw-hint__matched";
      dim.textContent = matched;
      marker.appendChild(dim);
    }
    marker.appendChild(document.createTextNode(rest));
    if (label.length > 0) {
      const text = document.createElement("span");
      text.className = "vw-hint__text";
      text.textContent = label;
      marker.appendChild(text);
    }
  }

  #applyOffset(): void {
    if (this.#disposed) return;
    const viewport = this.#app.ui.viewport();
    const dx = globalThis.scrollX - this.#originX + viewport.offsetLeft;
    const dy = globalThis.scrollY - this.#originY + viewport.offsetTop;
    this.#container.style.transform = `translate(${-dx}px, ${-dy}px)`;
  }

  #addListeners(): void {
    // Capture phase: scroll does not bubble from a scrolling sub-element, and a
    // hint on an inner scroller has to track it too.
    document.addEventListener("scroll", this.#reposition, {
      capture: true,
      passive: true,
    });
    globalThis.addEventListener("resize", this.#reposition, { passive: true });
    const visual = globalThis.visualViewport;
    if (visual) {
      visual.addEventListener("resize", this.#reposition, { passive: true });
      visual.addEventListener("scroll", this.#reposition, { passive: true });
    }
  }

  #removeListeners(): void {
    document.removeEventListener("scroll", this.#reposition, { capture: true });
    globalThis.removeEventListener("resize", this.#reposition);
    const visual = globalThis.visualViewport;
    if (visual) {
      visual.removeEventListener("resize", this.#reposition);
      visual.removeEventListener("scroll", this.#reposition);
    }
  }
}
