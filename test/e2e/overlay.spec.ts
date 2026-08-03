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
 * The repair has a budget of 32 writes for each quiet second, because a page
 * that removes the host inside its own observer would fight us in a loop of
 * microtasks. A page that spends the budget keeps the host until the next
 * quiet second. The guard does not go silent for that time: it keeps
 * observing, and the overlay gives the keyboard back to the page.
 *
 * The host cannot escape its own ancestors, and `documentElement` is the only
 * ancestor that it has. Two classes of rule on `html` reach the overlay, and
 * the class decides both the result and the answer.
 *
 * 1. **A rule that makes `html` the containing block of a fixed descendant.**
 *    The overlay then holds a place in the document, so it scrolls away with
 *    the page, and **the page stays fully readable**. Example:
 *    `html { will-change: transform }`. Every property that gives an element a
 *    transform, a containment, a filter or a perspective belongs to this
 *    class, and so does any future property with the same effect. `alignHost`
 *    measures the host box and moves the host back on to the viewport.
 * 2. **A rule that makes `html` paint nothing.** The overlay disappears, and
 *    the page disappears with it, so the user sees a blank page. Example:
 *    `html { opacity: 0 }`. A rule of our own on `html` would break every
 *    honest page that fades its root element, so the script does not answer
 *    this class.
 *
 * `SECURITY.md` names both classes.
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

/** Move the host into a new container once for each task. */
const cageHostTimes = (page: Page, times: number): Promise<number> =>
  page.evaluate((count: number): Promise<number> => {
    const repeat = (globalThis as unknown as {
      cageVimiumHostTimes?: (times: number) => Promise<number>;
    }).cageVimiumHostTimes;
    return repeat === undefined ? Promise.resolve(0) : repeat(count);
  }, times);

/** Let page script take the focus, as an autofocus or a script does. */
const focusPageTarget = (page: Page): Promise<boolean> =>
  page.evaluate((): boolean => {
    const focus = (globalThis as unknown as {
      focusVimiumTarget?: () => boolean;
    }).focusVimiumTarget;
    return focus === undefined ? false : focus();
  });

/** Write one declaration on the root element of the page. */
const styleRoot = (page: Page, declaration: string): Promise<void> =>
  page.evaluate((rule: string) => {
    document.documentElement.style.cssText = rule;
  }, declaration);

/** How many dialogs the overlay holds now. */
const dialogCount = (page: Page): Promise<number> =>
  page.evaluate((): number => {
    const host = globalThis as unknown as {
      __vimiumHarness?: { shadow: ShadowRoot | null };
    };
    const shadow = host.__vimiumHarness?.shadow ?? null;
    return shadow === null ? 0 : shadow.querySelectorAll(".vw-dialog").length;
  });

/** Everything that the page wrote to its console. */
const consoleLines = (page: Page): readonly string[] => {
  const lines: string[] = [];
  page.on("console", (message) => {
    lines.push(message.text());
  });
  return lines;
};

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
      ["contain", "layout"],
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

test.describe("the overlay host when the page spends the repair budget", () => {
  // 33 moves, each one in a task of its own. The cap is 32 for each quiet
  // second, and it exists because a page that removes the host inside its own
  // observer would fight us in a loop of microtasks. A guard that answered
  // this by disconnecting its observer went silent for the rest of the
  // session, and the page then held an invisible interface that still took
  // every key.
  test("repairs the host again after one quiet second", async ({ vw, page }) => {
    await vw.open("/hostile-overlay.html");
    expect(await cageHostTimes(page, 33)).toBe(33);

    // The budget is spent, so the page keeps the host for now.
    expect(await hostParentTag(page)).toBe("div");

    // The guard still answers. One quiet second gives back the count and the
    // repair, and nothing else has to happen for that.
    await expect.poll(() => hostParentTag(page), { timeout: 5_000 }).toBe(
      "html",
    );

    // And it answers a further move at once.
    expect(await cageHost(page)).toBe(true);
    await expect.poll(() => hostParentTag(page)).toBe("html");

    await openHelp(page);
    expect((await overlayBox(page, ".vw-dialog"))?.width ?? 0)
      .toBeGreaterThan(300);
  });

  test("gives the keyboard back while the page holds the host", async ({ vw, page }) => {
    const lines = consoleLines(page);
    await vw.open("/hostile-overlay.html");
    await openHelp(page);
    expect(await dialogCount(page)).toBe(1);

    const before = (await vw.scrollOffsets()).y;
    expect(await cageHostTimes(page, 33)).toBe(33);

    // The overlay is inside a container of the page, and the user can see
    // nothing of it. It must not keep the keys.
    await expect.poll(() => dialogCount(page), { timeout: 5_000 }).toBe(0);
    await expect.poll(() =>
      lines.some((line) => line.includes("gives the keyboard back"))
    ).toBe(true);

    // The page has its keys again: `j` scrolls it, which no dialog allows.
    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y)
      .toBeGreaterThan(before);
  });
});

test.describe("the overlay under an ancestor rule of class 1", () => {
  // A rule that makes `html` the containing block of a fixed descendant. The
  // overlay then holds a place in the document instead of the viewport, so it
  // scrolls away, and **the page stays fully readable**. I measured each rule
  // below in WebKit: with the page at 2759 px the dialog box sat at -2711.
  // `alignHost` measures the host box and puts it back on the viewport.
  for (
    const rule of [
      "will-change: transform",
      "transform: translateZ(0)",
      "contain: paint",
      "perspective: 1px",
    ]
  ) {
    test(`draws the dialog in the viewport under ${rule}`, async ({ vw, page }) => {
      await vw.open("/long-text.html");
      await page.evaluate(() => globalThis.scrollTo(0, 2759));
      await styleRoot(page, rule);
      await openHelp(page);

      const height = page.viewportSize()?.height ?? 800;
      /** Does the whole dialog lie inside the visible part of the page? */
      const inViewport = async (): Promise<boolean> => {
        const box = await overlayBox(page, ".vw-dialog");
        if (box === null) return false;
        return box.top > -2 && box.top + box.height < height + 2;
      };

      expect(await inViewport()).toBe(true);

      // The correction must follow the page, because the host now moves with
      // the document. The layers inside the host must follow it as well: each
      // one is `position: fixed`, so `contain: layout` on the host keeps them
      // in the box of the host and not in the box of the document.
      for (const offset of [1200, 0, 3000]) {
        // oxlint-disable-next-line no-await-in-loop
        await page.evaluate((y: number) => globalThis.scrollTo(0, y), offset);
        // oxlint-disable-next-line no-await-in-loop
        await expect.poll(inViewport).toBe(true);
      }
    });
  }

  test("gives the keyboard back when it cannot correct the rule", async ({ vw, page }) => {
    const lines = consoleLines(page);
    await vw.open("/long-text.html");

    // A scale is not a translation, so no offset of ours brings the overlay
    // back. The measurement says so, and the dialog then does not open at all.
    await styleRoot(page, "transform: scale(0)");
    await page.keyboard.press("?");

    // Nothing opens, and nothing takes the keys for even one frame. The
    // dialog asks before it holds the keyboard, and not only afterwards.
    expect(await dialogCount(page)).toBe(0);
    await expect.poll(() =>
      lines.some((line) => line.includes("gives the keyboard back"))
    ).toBe(true);
    expect(await dialogCount(page)).toBe(0);
  });
});
