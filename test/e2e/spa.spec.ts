/**
 * Single-page navigation.
 *
 * In the content world we do not share the page's JS realm, so patching
 * `history.pushState` is useless — the page's calls go through its own realm's
 * `History.prototype`. The URL change is therefore observed by `popstate`, by a
 * post-click sample, and by a slow poll (`URL_POLL_MS` is 900 ms), which is why
 * these assertions are written as polls rather than as immediate reads.
 *
 * Two things have to hold afterwards: every mode was exited, and the key
 * bindings still work against the replaced DOM.
 */

import { expect, test } from "./harness/fixtures.ts";

/** Comfortably past `URL_POLL_MS` (900 ms) plus a render. */
const URL_SETTLE_MS = 2500;

test.describe("SPA navigation", () => {
  test("a pushState navigation exits open modes", async ({ vw, page }) => {
    await vw.open("/spa.html");

    await vw.startHints();
    expect(await vw.hintsVisible()).toBe(true);

    // Driven from the page rather than by clicking, so the post-click sample
    // does not do the work and the poll backstop is what is under test.
    await page.evaluate(() => {
      history.pushState({ view: "detail" }, "", "?view=detail");
    });

    await vw.waitForHintsGone(URL_SETTLE_MS);
  });

  test("key bindings still work after a pushState navigation", async ({ vw, page }) => {
    await vw.open("/spa.html");

    await page.locator("#go-detail").click();
    await expect(page).toHaveURL(/\?view=detail$/);
    await expect(page.locator("#status")).toHaveText(/^detail:/);

    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y)
      .toBeGreaterThan(0);
  });

  test("hints find links in DOM that did not exist at boot", async ({ vw, page }) => {
    await vw.open("/spa.html");

    await page.locator("#go-detail").click();
    await expect(page.locator("#status")).toHaveText(/^detail:/);
    // The post-click URL sample fires 60 ms later and triggers a `refresh()`
    // that exits every mode; starting a hint session inside that window would
    // have it torn down from under us.
    await page.waitForTimeout(400);

    await vw.startHints();
    await vw.activateHint("detail Beta link");

    await expect(page).toHaveURL(/#detail-beta$/);
  });

  test("survives aggressive DOM churn", async ({ vw, page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await vw.open("/spa.html");
    await page.locator("#churn").click();
    await expect(page.locator("#status")).toHaveText(/^home:2[01]$/);
    await page.waitForTimeout(400);

    // The overlay host is re-attached lazily on the next `layer()` call, which
    // is what keeps us alive when a router replaces `document.body`.
    await vw.startHints();
    await vw.activateHint("home Gamma link");

    await expect(page).toHaveURL(/#home-gamma$/);
    expect(errors).toEqual([]);
  });

  test("going back re-arms the bindings", async ({ vw, page }) => {
    await vw.open("/spa.html");

    await page.locator("#go-detail").click();
    await expect(page).toHaveURL(/\?view=detail$/);

    await page.goBack();
    await expect(page.locator("#status")).toHaveText(/^home:/);

    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y)
      .toBeGreaterThan(0);
  });

  /**
   * The gap this closes: `applyExclusion()` calls `exitAllModes` and then
   * re-enters normal mode, but insert mode is a *memoised* feature object, so
   * re-reading it returned the instance that had just been exited. Every
   * keystroke after a soft navigation was then read as a command, and typing
   * into a search box scrolled the page instead (CORE-01).
   */
  test("typing into an input still reaches the page after a pushState navigation", async ({ vw, page }) => {
    await vw.open("/spa.html");

    await page.locator("#go-detail").click();
    await expect(page.locator("#status")).toHaveText(/^detail:/);
    // Past the post-click URL sample and its `refresh()`.
    await page.waitForTimeout(URL_SETTLE_MS);

    await page.locator("#typing").click();
    await vw.type("jkgg");

    await expect(page.locator("#typing")).toHaveValue("jkgg");
    // `gg` would have jumped to the top and `j` scrolled down; neither is a
    // thing that should happen while the user is typing.
    expect((await vw.scrollOffsets()).y).toBe(0);
  });
});

test.describe("pre-existing focus", () => {
  /**
   * The application starts on a timer, long after the page autofocused its search box.
   * Seeding insert mode from `deepActiveElement()` is the only way it can know
   * (OSU-02).
   */
  test("an autofocused field is typed into, not commanded at", async ({ vw, page }) => {
    await vw.open("/autofocus.html");

    await expect(page.locator("#search")).toBeFocused();
    await vw.type("jjf");

    await expect(page.locator("#search")).toHaveValue("jjf");
    expect(await vw.hintsVisible()).toBe(false);
    expect((await vw.scrollOffsets()).y).toBe(0);
  });

  test("Escape leaves the seeded insert mode", async ({ vw, page }) => {
    await vw.open("/autofocus.html");

    await expect(page.locator("#search")).toBeFocused();
    await vw.press("Escape");

    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y)
      .toBeGreaterThan(0);
  });
});
