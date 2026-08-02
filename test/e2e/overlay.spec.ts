/**
 * The overlay host under a page that fights it.
 *
 * The host is a normal element of the light DOM with a name that anybody can
 * write in a selector. Two attacks follow from that, and `hostile-overlay.html`
 * performs both:
 *
 * 1. The stylesheet of the page hides the host with important declarations.
 * 2. Page script removes the host from the document.
 *
 * Either one leaves the user with keyboard modes that keep taking keys and an
 * interface that shows nothing. The answers are the important priority on every
 * inline declaration, a check before each visible action, and a mutation
 * observer that puts the host back.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "./harness/fixtures.ts";
import { overlayBox } from "./harness/overlay.ts";

/** A resolved style property of the host itself, which is in the light DOM. */
const hostStyle = (page: Page, property: string): Promise<string> =>
  page.locator("vimium-webkit-overlay").first().evaluate(
    (element: Element, name: string): string =>
      getComputedStyle(element).getPropertyValue(name),
    property,
  );

const openHelp = async (page: Page): Promise<void> => {
  await page.keyboard.press("?");
  await page.waitForFunction(
    () => {
      const host = globalThis as unknown as {
        __vimiumHarness?: { shadow: ShadowRoot | null };
      };
      const shadow = host.__vimiumHarness?.shadow ?? null;
      return shadow !== null && shadow.querySelector(".vw-dialog") !== null;
    },
    undefined,
    { timeout: 10_000 },
  );
};

/** Take the host out of the document, as the fixture script does. */
const removeHost = (page: Page): Promise<boolean> =>
  page.evaluate((): boolean => {
    const remover = (globalThis as unknown as {
      removeVimiumHost?: () => boolean;
    }).removeVimiumHost;
    return remover === undefined ? false : remover();
  });

const hostCount = (page: Page): Promise<number> =>
  page.locator("vimium-webkit-overlay").count();

test.describe("the overlay host under hostile CSS", () => {
  test("keeps the properties that make it visible", async ({ vw, page }) => {
    await vw.open("/hostile-overlay.html");

    // Every one of these is `!important` in the stylesheet of the page. An
    // important inline declaration beats an important rule of the page.
    expect(await hostStyle(page, "display")).toBe("block");
    expect(await hostStyle(page, "visibility")).toBe("visible");
    expect(await hostStyle(page, "opacity")).toBe("1");
    expect(await hostStyle(page, "position")).toBe("fixed");
    expect(await hostStyle(page, "z-index")).toBe("2147483647");
    expect(await hostStyle(page, "transform")).toBe("none");
  });

  test("still draws a dialog that the user can see", async ({ vw, page }) => {
    await vw.open("/hostile-overlay.html");
    await openHelp(page);

    const box = await overlayBox(page, ".vw-dialog");
    expect(box).not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThan(300);
    expect(box?.height ?? 0).toBeGreaterThan(100);
  });
});

test.describe("the overlay host after a removal", () => {
  test("comes back on its own", async ({ vw, page }) => {
    await vw.open("/hostile-overlay.html");
    expect(await removeHost(page)).toBe(true);

    // The mutation observer answers while nothing else happens, so the user
    // does not have to press a key to get the interface back.
    await expect.poll(() => hostCount(page)).toBe(1);
  });

  test("still holds the whole interface", async ({ vw, page }) => {
    await vw.open("/hostile-overlay.html");
    expect(await removeHost(page)).toBe(true);
    await expect.poll(() => hostCount(page)).toBe(1);

    // The same host, with the same closed shadow root, so the dialog opens
    // into the tree that the features already hold.
    await openHelp(page);
    const box = await overlayBox(page, ".vw-dialog");
    expect(box?.width ?? 0).toBeGreaterThan(300);
  });

  test("comes back again after many removals", async ({ vw, page }) => {
    await vw.open("/hostile-overlay.html");

    for (let attempt = 0; attempt < 5; attempt++) {
      // oxlint-disable-next-line no-await-in-loop
      await removeHost(page);
      // oxlint-disable-next-line no-await-in-loop
      await expect.poll(() => hostCount(page)).toBe(1);
    }

    await openHelp(page);
    expect((await overlayBox(page, ".vw-dialog"))?.width ?? 0)
      .toBeGreaterThan(300);
  });
});
