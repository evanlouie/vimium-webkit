/**
 * The overlay host under a page that fights it.
 *
 * The host is a normal element of the light DOM with a name that anybody can
 * write in a selector. Three attacks follow from that, and `hostile-overlay.html`
 * performs all three:
 *
 * 1. The stylesheet of the page hides the host with important declarations.
 * 2. Page script removes the host from the document.
 * 3. Page script moves the host into a container that the page hides.
 *
 * Any one of them leaves the user with keyboard modes that keep taking keys and
 * an interface that shows nothing. The answers are the important priority on
 * every inline declaration, a check before each visible action, and a mutation
 * observer that puts the host back under `documentElement`.
 *
 * There is a limit, and it is written here because a test cannot hold it. The
 * host is a child of `documentElement`, and CSS gives a descendant no way out
 * of its ancestors. `documentElement` is the only ancestor that the host has.
 * The removal guard keeps the host a child of it. A page that moves the host
 * into a container of its own therefore loses it again at once. Five rules
 * still win: `html { opacity: 0 }`, `html { transform: scale(0) }`,
 * `html { filter: opacity(0) }`, `html { content-visibility: hidden }` and
 * `html { display: none }`. Each one paints the page itself as nothing, so the
 * user sees a blank page and not a hidden interface. `SECURITY.md` names this
 * limit.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "./harness/fixtures.ts";
import { overlayBox, overlayFocusWithin } from "./harness/overlay.ts";

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

/** Take one declaration off the host, as one line of page script can. */
const stripHostProperty = (page: Page, property: string): Promise<boolean> =>
  page.evaluate((name: string): boolean => {
    const strip = (globalThis as unknown as {
      stripVimiumHostProperty?: (property: string) => boolean;
    }).stripVimiumHostProperty;
    return strip === undefined ? false : strip(name);
  }, property);

const hostCount = (page: Page): Promise<number> =>
  page.locator("vimium-webkit-overlay").count();

/** Move the host into a container of the page, as one line of script can. */
const cageHost = (page: Page): Promise<boolean> =>
  page.evaluate((): boolean => {
    const cage = (globalThis as unknown as {
      cageVimiumHost?: () => boolean;
    }).cageVimiumHost;
    return cage === undefined ? false : cage();
  });

/** The tag name of the element that holds the host now. */
const hostParentTag = (page: Page): Promise<string | null> =>
  page.evaluate((): string | null => {
    const host = document.querySelector("vimium-webkit-overlay");
    const parent = host?.parentElement ?? null;
    return parent === null ? null : parent.tagName.toLowerCase();
  });

/** Let page script take the focus, as an autofocus or a script does. */
const focusPageTarget = (page: Page): Promise<boolean> =>
  page.evaluate((): boolean => {
    const focus = (globalThis as unknown as {
      focusVimiumTarget?: () => boolean;
    }).focusVimiumTarget;
    return focus === undefined ? false : focus();
  });

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

  test("keeps a size that the page cannot take away", async ({ vw, page }) => {
    await vw.open("/hostile-overlay.html");

    // The stylesheet of the page writes `width: 0 !important` and
    // `height: 0 !important`. A zero-sized host draws nothing at all.
    const viewport = page.viewportSize();
    expect(Number.parseFloat(await hostStyle(page, "width")))
      .toBeGreaterThan((viewport?.width ?? 1280) / 2);
    expect(Number.parseFloat(await hostStyle(page, "height")))
      .toBeGreaterThan((viewport?.height ?? 800) / 2);
  });
});

test.describe("the overlay host where the engine has no visual viewport", () => {
  // `window.visualViewport` is absent in an older engine and in some frames.
  // The size of the host must not depend on it, because only the sync writes
  // a pixel size and only that sync defeats `width: 0 !important`.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        Object.defineProperty(globalThis, "visualViewport", {
          configurable: true,
          get: () => undefined,
        });
      } catch {
        // An engine that refuses the definition keeps its own viewport, and
        // the assertions below then hold for the other reason.
      }
    });
  });

  test("keeps its size from the declaration alone", async ({ vw, page }) => {
    await vw.open("/hostile-overlay.html");

    // The realm must truly have none, or this proves nothing. `HOST_STYLE`
    // declares `width` and `height` itself, so the size does not depend on
    // the sync. The unit test holds that declaration; here we hold the result.
    expect(
      await page.evaluate(
        () =>
          (globalThis as { visualViewport?: unknown }).visualViewport ===
            undefined,
      ),
    ).toBe(true);

    const viewport = page.viewportSize();
    expect(Number.parseFloat(await hostStyle(page, "width")))
      .toBeGreaterThan((viewport?.width ?? 1280) / 2);
    expect(Number.parseFloat(await hostStyle(page, "height")))
      .toBeGreaterThan((viewport?.height ?? 800) / 2);

    await openHelp(page);
    expect((await overlayBox(page, ".vw-dialog"))?.width ?? 0)
      .toBeGreaterThan(300);
  });

  test("keeps its size after page script strips `all`", async ({ vw, page }) => {
    await vw.open("/hostile-overlay.html");

    // `style.removeProperty("all")` takes every longhand off the host in one
    // call, and the page rule of `width: 0 !important` then has nothing to
    // beat. The guard must see the loss and write the whole declaration list
    // again. This realm has no visual viewport, so nothing else writes a size.
    expect(await stripHostProperty(page, "all")).toBe(true);
    await openHelp(page);

    const viewport = page.viewportSize();
    expect(Number.parseFloat(await hostStyle(page, "width")))
      .toBeGreaterThan((viewport?.width ?? 1280) / 2);
    expect((await overlayBox(page, ".vw-dialog"))?.width ?? 0)
      .toBeGreaterThan(300);
  });
});

test.describe("the overlay host after page script strips a declaration", () => {
  // Page script owns the host, because the host is in the light DOM. One call
  // of `style.removeProperty` gives the important page rule the win, and the
  // guard must see it. A removed declaration reads back with an empty value
  // and an empty priority.
  for (
    const [property, intact] of [
      ["clip-path", "none"],
      ["filter", "none"],
      ["transform", "none"],
      ["display", "block"],
      ["visibility", "visible"],
      ["opacity", "1"],
    ] as const
  ) {
    test(`repairs ${property}`, async ({ vw, page }) => {
      await vw.open("/hostile-overlay.html");
      expect(await stripHostProperty(page, property)).toBe(true);

      // The guard runs before each action that makes something visible.
      await openHelp(page);
      expect(await hostStyle(page, property)).toBe(intact);

      const box = await overlayBox(page, ".vw-dialog");
      expect(box?.width ?? 0).toBeGreaterThan(300);
    });
  }
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

  test("guards a page that lives longer than the cap", async ({ vw, page }) => {
    await vw.open("/hostile-overlay.html");

    // The cap is 32, and it protects against a loop inside one task. A page
    // that replaces its document element on each route is not a loop, so a
    // count that only grew took the guard away from a long session. One quiet
    // second puts the count back to zero.
    const burst = async (): Promise<void> => {
      for (let attempt = 0; attempt < 20; attempt++) {
        // oxlint-disable-next-line no-await-in-loop
        await removeHost(page);
        // oxlint-disable-next-line no-await-in-loop
        await expect.poll(() => hostCount(page)).toBe(1);
      }
    };

    await burst();
    // Longer than the reset, so that the count goes back to zero.
    await page.waitForTimeout(1500);
    await burst();

    // 40 removals, which is more than the cap. The guard still answers.
    expect(await removeHost(page)).toBe(true);
    await expect.poll(() => hostCount(page)).toBe(1);

    await openHelp(page);
    expect((await overlayBox(page, ".vw-dialog"))?.width ?? 0)
      .toBeGreaterThan(300);
  });
});

test.describe("the overlay host after page script moves it", () => {
  // A connection test is not enough. The page builds a container of its own,
  // gives it `opacity: 0`, and puts the host inside it. The host stays
  // connected, and the page keeps its own visibility, because it chose the
  // container. The user then has an invisible interface that holds the
  // keyboard, which is the failure that issue #51 names.
  test("comes out of a container of the page on its own", async ({ vw, page }) => {
    await vw.open("/hostile-overlay.html");
    expect(await cageHost(page)).toBe(true);

    // The mutation observer sees the move, because a move out of
    // `documentElement` is a child-list change there.
    await expect.poll(() => hostParentTag(page)).toBe("html");
    expect(await hostCount(page)).toBe(1);
  });

  test("still draws a dialog that the user can see", async ({ vw, page }) => {
    await vw.open("/hostile-overlay.html");
    expect(await cageHost(page)).toBe(true);

    // The guard also runs before each action that makes something visible.
    await openHelp(page);
    expect(await hostParentTag(page)).toBe("html");

    const box = await overlayBox(page, ".vw-dialog");
    expect(box?.width ?? 0).toBeGreaterThan(300);
    expect(box?.height ?? 0).toBeGreaterThan(100);
  });

  test("comes back out of a container that the page builds again", async ({ vw, page }) => {
    await vw.open("/hostile-overlay.html");

    for (let attempt = 0; attempt < 5; attempt++) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await cageHost(page)).toBe(true);
      // oxlint-disable-next-line no-await-in-loop
      await expect.poll(() => hostParentTag(page)).toBe("html");
    }

    await openHelp(page);
    expect((await overlayBox(page, ".vw-dialog"))?.width ?? 0)
      .toBeGreaterThan(300);
  });
});

test.describe("the focus after the guard puts the host back", () => {
  test("stays inside an open dialog", async ({ vw, page }) => {
    await vw.open("/hostile-overlay.html");
    await openHelp(page);
    await vw.press("Tab");
    expect(await overlayFocusWithin(page, ".vw-dialog")).toBe(true);

    // A move takes the focus off every node inside the host. The dialog stays
    // on screen and keeps `aria-modal="true"`, so a keystroke that the user
    // meant for a control would go to the body of the page.
    expect(await removeHost(page)).toBe(true);
    await expect.poll(() => hostCount(page)).toBe(1);

    await expect.poll(() => overlayFocusWithin(page, ".vw-dialog")).toBe(true);
  });

  test("leaves the focus that page script took", async ({ vw, page }) => {
    await vw.open("/hostile-overlay.html");
    await openHelp(page);
    await vw.press("Tab");
    expect(await overlayFocusWithin(page, ".vw-dialog")).toBe(true);

    // Page script can focus one of its own controls at any moment, and it does
    // that here while our dialog is open. The repair must then leave the focus
    // where the page put it. `focusIsFree` holds that rule.
    expect(await focusPageTarget(page)).toBe(true);
    expect(await removeHost(page)).toBe(true);
    await expect.poll(() => hostCount(page)).toBe(1);

    // The root is closed, so a focus inside the overlay reads as the host,
    // which carries no identifier. The link is the only value that proves that
    // the guard did not take the focus.
    await expect.poll(() => vw.focusedId()).toBe("target");
    expect(await overlayFocusWithin(page, ".vw-dialog")).toBe(false);
  });
});
