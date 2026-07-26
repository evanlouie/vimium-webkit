/**
 * Match highlighting.
 *
 * Rects live in the `"find"` layer of the single closed shadow root, which is
 * viewport-fixed and carries `z-index: 2147483647`. `Range.getClientRects()`
 * returns one rect per line box, so a match wrapped across a line produces two
 * rects and both have to be drawn — the naive `getBoundingClientRect()` would
 * paint a block over the intervening text.
 *
 * Positions are corrected for scroll the same way `hints/markers.ts` does it:
 * rects are measured once against the layout viewport and the container is
 * translated by the scroll delta afterwards, rather than re-measuring hundreds
 * of ranges on every scroll frame. On iOS the visual-viewport offset is
 * subtracted too, because the UI host is translated by it to emulate
 * `position: device-fixed`.
 */

import type { AppContext } from "~/core/context.ts";
import { rafCoalesce } from "~/platform/scheduler.ts";
import type { FindMatch } from "./engine.ts";

/**
 * Ceiling on drawn rects.
 *
 * A query of `e` matches thousands of times; past a few hundred the highlights
 * stop conveying anything and start costing a frame. The current match is drawn
 * unconditionally, so the cap never hides the one rect that matters.
 */
export const MAX_RENDERED_RECTS = 400;

/** Rects this far outside the viewport are still drawn, for a smooth scroll-in. */
const VIEWPORT_MARGIN = 400;

interface PlacedRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly current: boolean;
}

export class FindHighlighter {
  readonly #app: AppContext;
  readonly #container: HTMLElement;
  readonly #rects: HTMLElement[] = [];
  readonly #reposition: (() => void) & { cancel: () => void };

  #originX = 0;
  #originY = 0;
  #disposed = false;

  constructor(app: AppContext) {
    this.#app = app;
    this.#originX = globalThis.scrollX;
    this.#originY = globalThis.scrollY;

    const container = document.createElement("div");
    container.className = "vw-find";
    app.ui.layer("find").appendChild(container);
    this.#container = container;

    this.#reposition = rafCoalesce(() => this.#applyOffset());
    this.#addListeners();
    this.#applyOffset();
  }

  /** Re-measure and draw. `currentIndex` may be out of range, meaning "none". */
  render(matches: readonly FindMatch[], currentIndex: number): void {
    if (this.#disposed) return;

    // Re-measuring resets the scroll baseline; everything after this render is
    // a delta from here.
    this.#originX = globalThis.scrollX;
    this.#originY = globalThis.scrollY;

    this.#paint(this.#measure(matches, currentIndex));
    this.#applyOffset();
  }

  clear(): void {
    for (const rect of this.#rects) {
      rect.className = "vw-find__rect vw-find__rect--hidden";
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#reposition.cancel();
    this.#removeListeners();
    this.#container.remove();
    this.#rects.length = 0;
  }

  #measure(
    matches: readonly FindMatch[],
    currentIndex: number,
  ): readonly PlacedRect[] {
    const viewport = this.#app.ui.viewport();
    const minTop = -VIEWPORT_MARGIN;
    const maxTop = viewport.height + VIEWPORT_MARGIN;
    const placed: PlacedRect[] = [];

    // The current match first, so the cap can never evict it.
    const order = [currentIndex, ...matches.keys()];
    const drawn = new Set<number>();

    for (const index of order) {
      if (placed.length >= MAX_RENDERED_RECTS) break;
      if (drawn.has(index)) continue;
      const match = matches[index];
      if (match === undefined) continue;
      drawn.add(index);

      const current = index === currentIndex;
      for (const rect of match.range.getClientRects()) {
        if (rect.width === 0 || rect.height === 0) continue;
        if (!current && (rect.bottom < minTop || rect.top > maxTop)) continue;
        placed.push({
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          current,
        });
      }
    }

    return placed;
  }

  #paint(placed: readonly PlacedRect[]): void {
    while (this.#rects.length < placed.length) {
      const element = document.createElement("div");
      element.className = "vw-find__rect";
      this.#container.appendChild(element);
      this.#rects.push(element);
    }

    for (let index = 0; index < this.#rects.length; index++) {
      const element = this.#rects[index];
      if (element === undefined) continue;
      const rect = placed[index];
      if (rect === undefined) {
        element.className = "vw-find__rect vw-find__rect--hidden";
        continue;
      }
      element.className = rect.current
        ? "vw-find__rect vw-find__rect--current"
        : "vw-find__rect";
      element.style.width = `${rect.width}px`;
      element.style.height = `${rect.height}px`;
      element.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
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
    // Capture phase: `scroll` does not bubble out of a scrolling sub-element,
    // and a match inside an inner scroller has to track it too.
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
