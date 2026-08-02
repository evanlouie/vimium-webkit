/**
 * The Playwright fixture: a page with the shipped bundle and a stubbed manager.
 *
 * Import `test` and `expect` from here rather than from `@playwright/test`;
 * every spec needs the injection, and a spec that forgot it would exercise a
 * bare fixture page and pass for the wrong reason.
 */

import { expect, test as base } from "@playwright/test";
import type { Frame, Page } from "@playwright/test";
import type { Settings } from "~/settings/schema.ts";
import { readBundle } from "./bundle.ts";
import { hudText, visibleHintMarkers } from "./overlay.ts";
import {
  type CspViolation,
  type GmVariant,
  type HarnessSnapshot,
  type HarnessState,
  installPageHarness,
} from "./page-harness.ts";
import { effectiveSettings, seedWithSettings } from "./settings-seed.ts";

export { expect };
export type { CspViolation, GmVariant, HarnessSnapshot };

/**
 * Run async steps strictly in order.
 *
 * Keyboard input is inherently sequential; `no-await-in-loop` exists to catch
 * accidental serialisation, which this is the opposite of.
 */
const inOrder = async (
  steps: readonly (() => Promise<unknown>)[],
): Promise<void> => {
  for (const step of steps) {
    // eslint-disable-next-line no-await-in-loop
    await step();
  }
};

interface SnapshotHost {
  __vimiumHarness?: HarnessState;
}

/** How long to wait for Stage 1 to build the overlay after a wake. */
const BOOT_TIMEOUT_MS = 15_000;

/**
 * Settle time after the overlay host appears.
 *
 * `createUiRoot` runs a few statements before `normalMode.enter()`, and there
 * is no observable signal in between. A short fixed wait is honest about that;
 * polling for something else would just be the same wait with more ceremony.
 */
const BOOT_SETTLE_MS = 60;

/**
 * Which hint marker sits on the element labelled `needle`, in this frame.
 *
 * Runs inside the page. Deliberately positional: markers are painted at their
 * element's top-left, so the nearest marker to a matched element is that
 * element's. Matching the element itself prefers the *smallest* candidate,
 * because an ancestor paragraph has the same `textContent` as the link inside
 * it and only the link takes a hint.
 */
const hintLabelForText = (needle: string): string | null => {
  const host = globalThis as unknown as {
    __vimiumHarness?: { shadow: ShadowRoot | null };
  };
  const shadow = host.__vimiumHarness?.shadow ?? null;
  if (shadow === null) return null;

  const labelsOf = (element: Element): readonly string[] => {
    const out = [(element.textContent ?? "").trim()];
    const aria = element.getAttribute("aria-label");
    if (aria !== null) out.push(aria.trim());
    const title = element.getAttribute("title");
    if (title !== null) out.push(title.trim());
    if (element instanceof HTMLImageElement) out.push(element.alt.trim());
    if (element instanceof HTMLAreaElement) out.push(element.alt.trim());
    if (element instanceof HTMLInputElement) {
      out.push(element.placeholder.trim());
      for (const label of element.labels ?? []) {
        out.push((label.textContent ?? "").trim().replace(/:$/, ""));
      }
    }
    return out;
  };

  const candidates: Element[] = [];
  const walk = (root: ParentNode): void => {
    for (const element of root.querySelectorAll("*")) {
      if (labelsOf(element).includes(needle)) candidates.push(element);
      const inner = element.shadowRoot;
      if (inner) walk(inner);
    }
  };
  walk(document);
  if (candidates.length === 0) return null;

  const rectOf = (element: Element): DOMRect => {
    // An `<area>` lives in a detached `<map>` and has no layout box of its own,
    // so its own rect is 0×0 at the origin — which would match whichever marker
    // happens to be nearest the top-left corner. Derive it from the image the
    // same way detection does.
    if (element instanceof HTMLAreaElement) {
      const map = element.closest("map");
      const name = map?.getAttribute("name") ?? "";
      const image = name === ""
        ? null
        : document.querySelector<HTMLImageElement>(
          `img[usemap="#${CSS.escape(name)}"]`,
        );
      if (image === null) return element.getBoundingClientRect();

      const base = image.getBoundingClientRect();
      const coords = element.coords.split(",").map((part) =>
        Number.parseInt(part.trim(), 10)
      );
      const shape = element.shape.toLowerCase();
      let left = coords[0] ?? 0;
      let top = coords[1] ?? 0;
      if (shape === "circle" || shape === "circ") {
        // The inscribed square, matching how detection derives an area's rect:
        // a circle's hint sits on the largest axis-aligned box inside it.
        const inset = (coords[2] ?? 0) / Math.SQRT2;
        left = (coords[0] ?? 0) - inset;
        top = (coords[1] ?? 0) - inset;
      }
      return new DOMRect(base.left + left, base.top + top, 1, 1);
    }
    return element.getBoundingClientRect();
  };

  const area = (element: Element): number => {
    const rect = rectOf(element);
    return rect.width * rect.height;
  };
  const target = candidates.reduce((best, element) =>
    area(element) < area(best) ? element : best
  );
  const rect = rectOf(target);

  // An element with no layout box is not rendered — `content-visibility: hidden`,
  // `display: none`, a closed shadow root's contents — so it has no hint, and
  // its rect at the origin would otherwise match whichever marker happens to be
  // nearest the top-left corner.
  if (rect.width === 0 && rect.height === 0) return null;

  // A marker is painted at exactly `max(2, rect.left/top)`, rounded, so the
  // match is a coincidence test rather than a proximity one: anything further
  // than a pixel or two away is a *different* element's marker.
  const expectedLeft = Math.max(2, rect.left);
  const expectedTop = Math.max(2, rect.top);

  let bestLabel: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const marker of shadow.querySelectorAll(".vw-hint")) {
    if (marker.classList.contains("vw-hint--hidden")) continue;
    const box = marker.getBoundingClientRect();
    const distance = Math.hypot(
      box.left - expectedLeft,
      box.top - expectedTop,
    );
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    bestLabel = (marker.textContent ?? "").trim();
  }

  return bestDistance <= 3 && bestLabel !== null && bestLabel.length > 0
    ? bestLabel
    : null;
};

export class Vimium {
  readonly page: Page;
  /** Whether hints are matched by link text rather than by hint string. */
  readonly filterMode: boolean;

  constructor(page: Page, filterMode: boolean) {
    this.page = page;
    this.filterMode = filterMode;
  }

  // -- lifecycle ------------------------------------------------------------

  /** Navigate to a fixture (relative to `baseURL`) and bring Stage 1 up. */
  async open(path: string): Promise<void> {
    await this.page.goto(path);
    await this.boot();
  }

  /**
   * Wake Stage 0 in this frame and wait for Stage 1.
   *
   * Stage 0 honours a wake only from an ancestor, so a synthetic event has to
   * name one. In the top frame `parent` is the window itself, which is exactly
   * the shape a real self-wake has. Subframes cannot be woken this way —
   * Firefox refuses a cross-origin `WindowProxy` as a `MessageEvent` source —
   * so `bootAllFrames` posts them a real message from the top frame instead.
   */
  async boot(frame: Frame = this.page.mainFrame()): Promise<void> {
    await frame.evaluate(() => {
      // `globalThis` *is* the window here; the cast is only because the Node
      // type for it does not carry the `Window` interface.
      const view = globalThis as unknown as Window;
      view.dispatchEvent(
        new MessageEvent("message", {
          data: { magic: "vimium-webkit/frames", v: 1, kind: "WAKE" },
          source: view,
        }),
      );
    });
    await this.waitForOverlay(frame);
  }

  private async waitForOverlay(frame: Frame): Promise<void> {
    await frame.locator("vimium-webkit-overlay").first().waitFor({
      state: "attached",
      timeout: BOOT_TIMEOUT_MS,
    });
    await this.page.waitForTimeout(BOOT_SETTLE_MS);
  }

  /**
   * Bring every frame in the page up.
   *
   * The top frame wakes itself; the rest are woken exactly as a cross-frame
   * hint round wakes them, by the top frame posting into the frames tree. That
   * is the only path that works across origins and across processes, and it has
   * the side benefit of exercising the production wake rather than a fake.
   *
   * A frame whose overlay never appears is *not* a failure: a manager that
   * declines `about:blank`, a sandboxed frame, and a cross-origin frame that
   * was never injected into are all supported configurations. What must not
   * happen is the whole page hanging or throwing, which the specs assert
   * separately.
   */
  async bootAllFrames(): Promise<void> {
    await this.boot();

    await this.page.mainFrame().evaluate(() => {
      const wake = { magic: "vimium-webkit/frames", v: 1, kind: "WAKE" };
      const visit = (view: Window, depth: number): void => {
        if (depth > 16) return;
        let count = 0;
        try {
          count = view.frames.length;
        } catch {
          return;
        }
        for (let index = 0; index < count; index++) {
          const child = view.frames[index];
          if (child === undefined) continue;
          try {
            child.postMessage(wake, "*");
          } catch {
            // Nothing useful to do; the spec asserts on the outcome.
          }
          visit(child, depth + 1);
        }
      };
      visit(globalThis as unknown as Window, 0);
    });

    const subframes = this.page.frames().filter(
      (frame) => frame !== this.page.mainFrame(),
    );
    await Promise.all(subframes.map(async (frame): Promise<void> => {
      try {
        await this.waitForOverlay(frame);
      } catch {
        // See the note above: an unreachable frame is a configuration, not a
        // failure.
      }
    }));
  }

  // -- input ----------------------------------------------------------------

  /** Press keys in order. Each entry is a Playwright key name. */
  press(...keys: readonly string[]): Promise<void> {
    return inOrder(keys.map((key) => () => this.page.keyboard.press(key)));
  }

  /** Type text one character at a time, as a user would. */
  type(text: string, delayMs = 0): Promise<void> {
    return this.page.keyboard.type(text, { delay: delayMs });
  }

  // -- hints ----------------------------------------------------------------

  /** Start a hint session and wait for the first markers to be drawn. */
  async startHints(key = "f"): Promise<void> {
    await this.page.keyboard.press(key);
    await this.waitForHints();
  }

  async waitForHints(): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const host = globalThis as unknown as {
          __vimiumHarness?: { shadow: ShadowRoot | null };
        };
        const shadow = host.__vimiumHarness?.shadow ?? null;
        if (shadow === null) return false;
        return shadow.querySelectorAll(".vw-hint:not(.vw-hint--hidden)")
          .length >
          0;
      },
      undefined,
      { timeout: BOOT_TIMEOUT_MS },
    );
  }

  hintLabels(): Promise<readonly string[]> {
    return visibleHintMarkers(this.page).then((markers) =>
      markers.map((marker) => marker.text)
    );
  }

  /** True while a hint session is drawing markers. */
  async hintsVisible(): Promise<boolean> {
    const markers = await visibleHintMarkers(this.page);
    return markers.length > 0;
  }

  /** Wait until every hint marker is gone (the session ended or was filtered out). */
  async waitForHintsGone(timeoutMs = BOOT_TIMEOUT_MS): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const host = globalThis as unknown as {
          __vimiumHarness?: { shadow: ShadowRoot | null };
        };
        const shadow = host.__vimiumHarness?.shadow ?? null;
        if (shadow === null) return true;
        return shadow.querySelectorAll(".vw-hint:not(.vw-hint--hidden)")
          .length === 0;
      },
      undefined,
      { timeout: timeoutMs },
    );
  }

  /**
   * Activate the hint on the element whose label is `linkText`.
   *
   * Mode-aware, because the two hint pipelines are activated in genuinely
   * different ways and the *default* one is alphabet mode. The harness used to
   * force `filterLinkHints: true` on every spec, which is why the default
   * pipeline had no integration coverage at all (TST-04) — and why a
   * cross-frame defect that only manifests there survived a green suite.
   *
   * - **Filter mode**: type the link text, then confirm. If the confirmation
   *   timer fired first the `Enter` lands in normal mode, where it is unbound,
   *   so this is safe either way.
   * - **Alphabet mode**: find the marker drawn on that element and type its
   *   label. The lookup is positional — a marker is painted at its element's
   *   top-left — which keeps the harness out of the hint-string algorithm the
   *   unit tests already cover.
   */
  async activateHint(linkText: string): Promise<void> {
    if (this.filterMode) {
      await this.type(linkText);
      await this.page.keyboard.press("Enter");
      return;
    }

    const label = await this.hintLabelFor(linkText);
    if (label === null) {
      throw new Error(`no hint marker is drawn on "${linkText}"`);
    }
    await this.type(label);
  }

  /**
   * The hint string currently drawn on the element labelled `linkText`.
   *
   * Searches every frame, because in a cross-frame round each frame draws the
   * markers for its own elements while the strings are assigned globally.
   */
  async hintLabelFor(linkText: string): Promise<string | null> {
    // Every frame at once: the frames are independent and a sequential walk
    // would pay a round trip per frame on a page that has twenty.
    const labels = await Promise.all(
      this.page.frames().map((frame) =>
        frame.evaluate(hintLabelForText, linkText).catch(
          (): string | null => null,
        )
      ),
    );
    return labels.find((label) => label !== null) ?? null;
  }

  /**
   * Assert that nothing on the page carries a hint for `linkText`, then dismiss.
   *
   * Mode-aware for the same reason `activateHint` is. In filter mode the
   * observable signal is the HUD saying so; in alphabet mode it is the absence
   * of a marker on the element.
   */
  async expectNoHint(linkText: string): Promise<void> {
    if (this.filterMode) {
      await this.type(linkText);
      await this.waitForHud("No matches");
    } else {
      const label = await this.hintLabelFor(linkText);
      if (label !== null) {
        throw new Error(
          `expected no hint on "${linkText}", but marker "${label}" is drawn on it`,
        );
      }
    }
    await this.press("Escape");
    await this.waitForHintsGone();
  }

  // -- observation ----------------------------------------------------------

  hud(): Promise<string | null> {
    return hudText(this.page);
  }

  /** Wait until the HUD's visible text contains `fragment`. */
  async waitForHud(fragment: string, timeoutMs = 8_000): Promise<void> {
    await this.page.waitForFunction(
      (needle: string) => {
        const host = globalThis as unknown as {
          __vimiumHarness?: { shadow: ShadowRoot | null };
        };
        const shadow = host.__vimiumHarness?.shadow ?? null;
        const hud = shadow?.querySelector('.vw-hud[data-visible="true"]') ??
          null;
        return (hud?.textContent ?? "").includes(needle);
      },
      fragment,
      { timeout: timeoutMs },
    );
  }

  /** Everything the in-page harness recorded, as plain JSON. */
  snapshot(): Promise<HarnessSnapshot> {
    return this.page.evaluate((): HarnessSnapshot => {
      const host = globalThis as unknown as SnapshotHost;
      const state = host.__vimiumHarness;
      if (state === undefined) {
        return {
          openedTabs: [],
          clipboard: [],
          violations: [],
          counters: { raf: 0, timeout: 0, interval: 0 },
          stored: {},
          overlayAttached: false,
        };
      }
      const stored: Record<string, string> = {};
      for (const [key, value] of state.store) stored[key] = value;
      return {
        openedTabs: [...state.openedTabs],
        clipboard: [...state.clipboard],
        violations: [...state.violations],
        counters: { ...state.counters },
        stored,
        overlayAttached: state.shadow !== null,
      };
    });
  }

  /** The document selection, plus the nearest `data-region` it lands in. */
  selection(): Promise<
    { readonly text: string; readonly region: string | null }
  > {
    return this.page.evaluate(() => {
      const selection = globalThis.getSelection();
      const node = selection?.anchorNode ?? null;
      const element = node instanceof Element
        ? node
        : node?.parentElement ?? null;
      return {
        text: selection?.toString() ?? "",
        region:
          element?.closest("[data-region]")?.getAttribute("data-region") ??
            null,
      };
    });
  }

  /** `document.activeElement`'s id, or `null`. */
  focusedId(): Promise<string | null> {
    return this.page.evaluate(() =>
      document.activeElement instanceof Element
        ? document.activeElement.id || null
        : null
    );
  }

  scrollOffsets(selector?: string): Promise<{ x: number; y: number }> {
    return this.page.evaluate((query: string | null) => {
      const element = query === null
        ? (document.scrollingElement ?? document.documentElement)
        : document.querySelector(query);
      if (element === null) return { x: -1, y: -1 };
      return { x: element.scrollLeft, y: element.scrollTop };
    }, selector ?? null);
  }
}

export interface HarnessOptions {
  /** Which manager surface the page exposes. */
  readonly gmVariant: GmVariant;
  /** Overrides applied over the e2e baseline settings. */
  readonly settingsPatch: Partial<Settings>;
  /** Reported through `GM_info.scriptHandler`; diagnostics only. */
  readonly scriptHandler: string;
}

export interface HarnessFixtures {
  readonly vw: Vimium;
}

export const test = base.extend<HarnessOptions & HarnessFixtures>({
  gmVariant: ["sync", { option: true }],
  settingsPatch: [{}, { option: true }],
  scriptHandler: ["Harness/Tampermonkey", { option: true }],

  vw: async ({ page, gmVariant, settingsPatch, scriptHandler }, use) => {
    // Order matters: the GM stub and the `attachShadow` capture have to be in
    // place before the bundle's first statement runs.
    await page.addInitScript(installPageHarness, {
      variant: gmVariant,
      scriptHandler,
      seed: seedWithSettings(settingsPatch),
    });
    await page.addInitScript({ content: readBundle() });
    await use(
      new Vimium(page, effectiveSettings(settingsPatch).filterLinkHints),
    );
  },
});
