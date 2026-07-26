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
import {
  type CspViolation,
  type GmVariant,
  type HarnessSnapshot,
  type HarnessState,
  installPageHarness,
} from "./page-harness.ts";
import { seedWithSettings } from "./settings-seed.ts";
import { hudText, visibleHintMarkers } from "./overlay.ts";

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
    // deno-lint-ignore no-await-in-loop
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

export class Vimium {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // -- lifecycle ------------------------------------------------------------

  /** Navigate to a fixture (relative to `baseURL`) and bring Stage 1 up. */
  async open(path: string): Promise<void> {
    await this.page.goto(path);
    await this.boot();
  }

  /**
   * Wake Stage 0 and wait for Stage 1.
   *
   * Stage 0 exposes exactly one public way to be woken from outside: the
   * `vimium-webkit:wake` message a top frame posts to its subframes. Dispatching
   * it directly avoids waiting out the 1200 ms idle timer and avoids the
   * alternative — pressing a key and hoping the buffer replays — which would
   * make every spec's first keystroke ambiguous.
   */
  async boot(frame: Frame = this.page.mainFrame()): Promise<void> {
    await frame.evaluate(() => {
      globalThis.dispatchEvent(
        new MessageEvent("message", { data: "vimium-webkit:wake" }),
      );
    });
    await frame.locator("vimium-webkit-overlay").first().waitFor({
      state: "attached",
      timeout: BOOT_TIMEOUT_MS,
    });
    await this.page.waitForTimeout(BOOT_SETTLE_MS);
  }

  /** Bring every frame in the page up, outermost first. */
  async bootAllFrames(): Promise<void> {
    await inOrder(
      this.page.frames().map((frame) => async (): Promise<void> => {
        try {
          await this.boot(frame);
        } catch {
          // A frame we cannot reach (a manager that declines `about:blank`, a
          // cross-origin frame that is still loading) must not fail the run:
          // graceful degradation is the behaviour under test.
        }
      }),
    );
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
   * Filter-mode activation: type the link text, then confirm.
   *
   * If the confirmation timer fired first the `Enter` lands in normal mode,
   * where it is unbound — so this is safe either way.
   */
  async activateHint(linkText: string): Promise<void> {
    await this.type(linkText);
    await this.page.keyboard.press("Enter");
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
    await use(new Vimium(page));
  },
});
