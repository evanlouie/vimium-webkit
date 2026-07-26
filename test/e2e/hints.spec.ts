/**
 * Hint detection against the awkward cases.
 *
 * Every assertion here is about a *side effect* — the page navigated, the
 * element took focus, nothing happened at all — rather than about what the
 * overlay drew. The one exception is waiting for markers to exist, which is
 * just the harness's readiness signal.
 *
 * They run against the *shipped* settings, so the pipeline under test is the
 * default one: alphabet hints. `activateHint` and `expectNoHint` know which
 * mode they are in and drive the overlay accordingly.
 */

import { expect, test } from "./harness/fixtures.ts";

/**
 * Image maps.
 *
 * `<area>` elements are the one hint kind whose occlusion test must run against
 * a *different* element: an area lives in a detached `<map>`, so
 * `elementsFromPoint()` returns the `<img>`, which neither contains the area
 * nor is contained by it. `LocalHint.hitTarget` carries the image so the test
 * still runs — an area under a fixed overlay genuinely is unreachable and
 * should still be dropped.
 */
test.describe("image maps", () => {
  test("hints the areas, not the image", async ({ vw, page }) => {
    await vw.open("/image-maps.html");
    await vw.startHints();

    await vw.activateHint("Left area");
    await expect(page).toHaveURL(/#area-left$/);
  });

  test("a circular area is reachable", async ({ vw, page }) => {
    await vw.open("/image-maps.html");
    await vw.startHints();

    await vw.activateHint("Right area");
    await expect(page).toHaveURL(/#area-right$/);
  });
});

test.describe("image maps", () => {
  test("an ordinary link on the same page is unaffected", async ({ vw, page }) => {
    await vw.open("/image-maps.html");
    await vw.startHints();

    await vw.activateHint("Ordinary link");
    await expect(page).toHaveURL(/#ordinary-target$/);
  });
});

test.describe("shadow DOM", () => {
  test("descends into an open shadow root", async ({ vw, page }) => {
    await vw.open("/shadow-dom.html");
    await vw.startHints();

    await vw.activateHint("Open shadow link");
    await expect(page).toHaveURL(/#open-shadow-target$/);
  });

  test("hints slotted light-DOM content", async ({ vw, page }) => {
    await vw.open("/shadow-dom.html");
    await vw.startHints();

    await vw.activateHint("Slotted link");
    await expect(page).toHaveURL(/#slotted-target$/);
  });

  test("cannot reach a closed shadow root", async ({ vw, page }) => {
    await vw.open("/shadow-dom.html");
    const before = page.url();
    await vw.startHints();

    // There is no API for walking into a closed root, and patching
    // `attachShadow` needs a reliable `document-start` WebKit does not give a
    // userscript. The contract is that we say so, not that we get in.
    await vw.expectNoHint("Closed shadow link");
    expect(page.url()).toBe(before);
  });
});

test.describe("content-visibility", () => {
  test("hints inside a rendered `auto` subtree", async ({ vw, page }) => {
    await vw.open("/content-visibility.html");
    await vw.startHints();

    await vw.activateHint("Auto visible link");
    await expect(page).toHaveURL(/#auto-target$/);
  });

  test("skips a `hidden` subtree", async ({ vw, page }) => {
    await vw.open("/content-visibility.html");
    const before = page.url();
    await vw.startHints();

    await vw.expectNoHint("Hidden subtree link");
    expect(page.url()).toBe(before);
  });

  test("the sibling link is unaffected", async ({ vw, page }) => {
    await vw.open("/content-visibility.html");
    await vw.startHints();

    await vw.activateHint("Plain sibling link");
    await expect(page).toHaveURL(/#plain-target$/);
  });
});

test.describe("occlusion", () => {
  test("a link under a fixed bar takes no hint", async ({ vw, page }) => {
    await vw.open("/overlays.html");
    const before = page.url();
    await vw.startHints();

    await vw.expectNoHint("Occluded link");
    expect(page.url()).toBe(before);
  });

  test("the overlay's own link is hintable", async ({ vw, page }) => {
    await vw.open("/overlays.html");
    await vw.startHints();

    await vw.activateHint("Overlay bar link");
    await expect(page).toHaveURL(/#overlay-target$/);
  });

  test("an unobstructed link is hintable", async ({ vw, page }) => {
    await vw.open("/overlays.html");
    await vw.startHints();

    await vw.activateHint("Clear link");
    await expect(page).toHaveURL(/#clear-target$/);
  });
});

test.describe("hint modes", () => {
  test("activating an input focuses it", async ({ vw, page }) => {
    await vw.open("/overlays.html");
    const before = page.url();

    await vw.startHints();
    await vw.activateHint("Search box");

    // `prepare()` focuses inputs before dispatching the click sequence, which
    // is what makes a hinted search field usable at all.
    await expect.poll(() => vw.focusedId()).toBe("search-box");
    expect(page.url()).toBe(before);
  });

  test("activating a button dispatches a real click sequence", async ({ vw, page }) => {
    await vw.open("/overlays.html");

    await vw.startHints();
    await vw.activateHint("Increment counter");

    await expect(page.locator("#click-count")).toHaveText("1");
  });

  test("`F` routes a new-tab hint through the manager", async ({ vw, page }) => {
    await vw.open("/overlays.html");
    const before = page.url();

    await vw.press("F");
    await vw.waitForHints();
    await vw.activateHint("Clear link");

    // A synthetic modifier-click never opens a tab in WebKit, so new-tab modes
    // must go through `GM_openInTab` (§6.10, verification item V5).
    await expect.poll(async () => (await vw.snapshot()).openedTabs.length)
      .toBeGreaterThan(0);
    const snapshot = await vw.snapshot();
    expect(snapshot.openedTabs[0]?.url).toContain("#clear-target");
    expect(page.url()).toBe(before);
  });
});

test.describe("link-dense pages", () => {
  test("hints only the viewport, and activates the right link", async ({ vw, page }) => {
    await vw.open("/link-dense.html");
    await vw.startHints();

    const labels = await vw.hintLabels();
    // Only what is in the viewport should be hinted; 2400 markers would mean
    // the rect crop is not doing its job.
    expect(labels.length).toBeGreaterThan(10);
    expect(labels.length).toBeLessThan(2400);

    await vw.activateHint("Unmistakable beacon");
    await expect(page).toHaveURL(/#beacon-target$/);
  });
});

test.describe("Escape", () => {
  test("dismisses a session without touching the page", async ({ vw, page }) => {
    await vw.open("/overlays.html");
    const before = page.url();

    await vw.startHints();
    await vw.press("Escape");
    await vw.waitForHintsGone();

    expect(page.url()).toBe(before);
    expect(await vw.hintsVisible()).toBe(false);
  });
});

/**
 * The occlusion probe, in both directions it used to be wrong in.
 *
 * A hit inside the element's *own* open shadow root is the element; a hit on
 * an ancestor while the element paints nothing is not.
 */
test.describe("occlusion probe", () => {
  test("a clickable custom element gets a hint", async ({ vw, page }) => {
    await vw.open("/overlays.html");
    await vw.startHints();

    await vw.activateHint("Shadow component button");
    await expect(page).toHaveURL(/#shadow-component-target$/);
  });

  for (
    const [label, description] of [
      ["Clipped link", "clip-path: inset(100%)"],
      ["Collapsed link", "height: 0; overflow: hidden"],
      ["Untouchable link", "pointer-events: none"],
    ] as const
  ) {
    test(`no phantom hint on ${description}`, async ({ vw, page }) => {
      await vw.open("/overlays.html");
      const before = page.url();
      await vw.startHints();

      // A phantom hint here is not cosmetic: activating it dispatches a real
      // click on content the user cannot see or reach.
      await vw.expectNoHint(label);
      expect(page.url()).toBe(before);
    });
  }
});
