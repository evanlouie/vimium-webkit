/**
 * Reading the overlay.
 *
 * The UI lives in a `closed` shadow root, so `page.locator()` cannot reach it.
 * These helpers go through the `attachShadow` capture installed by
 * `page-harness.ts` (see the note at the top of that file for why that is a
 * harness concern and not a weakening of the production guarantee).
 *
 * Use them sparingly. A spec that asserts on overlay internals is asserting on
 * an implementation detail; a spec that asserts the page navigated is asserting
 * on the thing the user asked for. The one place the overlay genuinely is the
 * subject under test is `csp.spec.ts`, where "did the stylesheet apply" has no
 * observable proxy.
 */

import type { Page } from "@playwright/test";

interface CapturedShadow {
  readonly shadow: ShadowRoot | null;
}
interface ShadowHost {
  __vimiumHarness?: CapturedShadow;
}

export interface OverlayBox {
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly left: number;
}

export interface OverlayNode {
  readonly text: string;
  readonly box: OverlayBox;
}

/** Trimmed `textContent` of the first match inside the overlay, or `null`. */
export const overlayText = (
  page: Page,
  selector: string,
): Promise<string | null> =>
  page.evaluate((query: string): string | null => {
    const host = globalThis as unknown as ShadowHost;
    const shadow = host.__vimiumHarness?.shadow ?? null;
    const node = shadow?.querySelector(query) ?? null;
    return node === null ? null : (node.textContent ?? "").trim();
  }, selector);

export const overlayCount = (page: Page, selector: string): Promise<number> =>
  page.evaluate((query: string): number => {
    const host = globalThis as unknown as ShadowHost;
    const shadow = host.__vimiumHarness?.shadow ?? null;
    return shadow === null ? 0 : shadow.querySelectorAll(query).length;
  }, selector);

/** Border box of the first match, in viewport coordinates. */
export const overlayBox = (
  page: Page,
  selector: string,
): Promise<OverlayBox | null> =>
  page.evaluate((query: string): OverlayBox | null => {
    const host = globalThis as unknown as ShadowHost;
    const shadow = host.__vimiumHarness?.shadow ?? null;
    const node = shadow?.querySelector(query) ?? null;
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
    };
  }, selector);

/** A single resolved CSS property of the first match. */
export const overlayComputedStyle = (
  page: Page,
  selector: string,
  property: string,
): Promise<string | null> =>
  page.evaluate(
    ([query, name]: readonly [string, string]): string | null => {
      const host = globalThis as unknown as ShadowHost;
      const shadow = host.__vimiumHarness?.shadow ?? null;
      const node = shadow?.querySelector(query) ?? null;
      if (!(node instanceof Element)) return null;
      return getComputedStyle(node).getPropertyValue(name);
    },
    [selector, property] as const,
  );

/**
 * Every currently-drawn hint marker, with its text and position.
 *
 * Used only to *discover* which label sits on which element; the assertions
 * that follow are always about what activating it did.
 */
export const visibleHintMarkers = (
  page: Page,
): Promise<readonly OverlayNode[]> =>
  page.evaluate((): readonly OverlayNode[] => {
    const host = globalThis as unknown as ShadowHost;
    const shadow = host.__vimiumHarness?.shadow ?? null;
    if (shadow === null) return [];
    const out: OverlayNode[] = [];
    for (const marker of shadow.querySelectorAll(".vw-hint")) {
      if (marker.classList.contains("vw-hint--hidden")) continue;
      const rect = marker.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      out.push({
        text: (marker.textContent ?? "").trim(),
        box: {
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
        },
      });
    }
    return out;
  });

/** Whatever the HUD is currently showing (message, indicator, or prompt label). */
export const hudText = (page: Page): Promise<string | null> =>
  overlayText(page, '.vw-hud[data-visible="true"]');
