/**
 * The page lifecycle, against the shipped bundle.
 *
 * Three rules are under test:
 *
 * 1. A page that the browser keeps must stay alive. `pagehide` with
 *    `persisted === true` means that the page may come back from the
 *    back/forward cache, and a restored page never runs its scripts again.
 *    A frame that released its runtime there would come back dead.
 * 2. A page that will not come back must let everything go. The overlay host
 *    belongs to the runtime scope, so its absence is the visible proof that the
 *    scope closed.
 * 3. A child frame exits alone. Each frame has its own realm and its own
 *    runtime, so a child that goes away must take nothing from the top frame.
 *
 * > [!IMPORTANT]
 * > Playwright does not give a true back/forward cache: `page.goBack()` loads
 * > the document again, and `pageshow.persisted` is always `false`. The
 * > `#document-id` field in the fixture reports this. The cache round trip is
 * > therefore driven by the two events that the browser would send, which is
 * > exactly what the code branches on. The real "leave and come back" is tested
 * > as well, and it asserts that the key bindings work afterwards.
 *
 * Under `smoothScroll: false`: what is under test is whether a key still does
 * anything at all, and an assertion on an offset mid-animation would be a flake
 * generator.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "./harness/fixtures.ts";
import { DETERMINISTIC } from "./harness/settings-seed.ts";

test.use({ settingsPatch: DETERMINISTIC });

/** The default `scrollStepSize`. */
const STEP = 60;

/** Long enough for a runtime scope to close, and short enough to be a test. */
const RELEASE_MS = 5_000;

/**
 * Send the page transition events, with the `persisted` flag that we choose.
 *
 * The constructor is the correct way to make one. A realm that does not have it
 * gets a plain event with the one field that the code reads.
 */
const sendTransition = (
  page: Page,
  type: "pagehide" | "pageshow",
  persisted: boolean,
): Promise<void> =>
  page.evaluate(
    ({ eventType, kept }: { eventType: string; kept: boolean }) => {
      let event: Event;
      try {
        event = new PageTransitionEvent(eventType, { persisted: kept });
      } catch {
        event = new Event(eventType);
        Object.defineProperty(event, "persisted", { value: kept });
      }
      globalThis.dispatchEvent(event);
    },
    { eventType: type, kept: persisted },
  );

test.describe("the page lifecycle", () => {
  test("a page that the browser keeps still answers the keyboard", async ({ vw, page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await vw.open("/lifecycle.html");
    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);

    // The round trip through the back/forward cache. The page is frozen, and
    // then it is restored with the same document and the same runtime.
    await sendTransition(page, "pagehide", true);
    await sendTransition(page, "pageshow", true);

    // The overlay belongs to the runtime scope. It is still here, so the scope
    // is still open.
    await expect(page.locator("vimium-webkit-overlay")).toHaveCount(1);

    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP * 2);
    expect(errors).toEqual([]);
  });

  test("a page that will not come back releases the overlay", async ({ vw, page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await vw.open("/lifecycle.html");
    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);

    // `persisted === false`: this document will not run again.
    await sendTransition(page, "pagehide", false);

    await expect(page.locator("vimium-webkit-overlay")).toHaveCount(0, {
      timeout: RELEASE_MS,
    });
    expect(errors).toEqual([]);
  });

  test("the key bindings still work after leaving and coming back", async ({ vw, page }) => {
    await vw.open("/lifecycle.html");
    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);

    await page.locator("#leave").click();
    await expect(page).toHaveURL(/long-text\.html$/);

    await page.goBack();
    await expect(page).toHaveURL(/lifecycle\.html$/);
    // Playwright loads the document again, so the guard is new and it waits to
    // be wanted. A restored document would already be running, and `boot()`
    // would find the overlay at once.
    await vw.boot();

    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y)
      .toBeGreaterThan(0);
  });

  test("a child frame that goes away leaves the top frame alone", async ({ vw, page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/lifecycle.html");
    await vw.bootAllFrames();
    await page.locator("#drop-child").click();
    await expect(page.frameLocator("#child").locator("#remote-link"))
      .toBeAttached();

    // The top frame never saw a `pagehide` of its own.
    await expect(page.locator("vimium-webkit-overlay")).toHaveCount(1);
    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);
    expect(errors).toEqual([]);
  });
});
