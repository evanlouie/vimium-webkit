/**
 * The hint must activate the element that the user saw.
 *
 * A marker is drawn for an element, and the user then presses a key. Between
 * those two moments a container can scroll, the page can reflow, and the page
 * can put another element on top. Each of those can make the click land
 * somewhere else, and a wrong click with no message is the defect.
 *
 * Every assertion here is about the side effect: the page went to one address,
 * or it went nowhere at all.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "./harness/fixtures.ts";

/**
 * Does the marker with this label sit on this element?
 *
 * It runs inside the page. A marker is painted at the top left of its element,
 * so a marker more than a pixel or two away belongs to another element.
 */
const markerSitsOn = (
  [label, elementId]: readonly [string, string],
): boolean => {
  const host = globalThis as unknown as {
    __vimiumHarness?: { shadow: ShadowRoot | null };
  };
  const shadow = host.__vimiumHarness?.shadow ?? null;
  const element = document.getElementById(elementId);
  if (shadow === null || element === null) return false;
  const box = element.getBoundingClientRect();
  for (const marker of shadow.querySelectorAll(".vw-hint")) {
    if (marker.classList.contains("vw-hint--hidden")) continue;
    if ((marker.textContent ?? "").trim() !== label) continue;
    const rect = marker.getBoundingClientRect();
    return Math.hypot(
      rect.left - Math.max(2, box.left),
      rect.top - Math.max(2, box.top),
    ) <= 3;
  }
  return false;
};

/** Wait until the marker with this label sits on this element. */
const waitForMarkerOn = (
  page: Page,
  label: string,
  elementId: string,
): Promise<unknown> =>
  page.waitForFunction(markerSitsOn, [label, elementId] as const, {
    timeout: 5_000,
  });

test.describe("a marker follows its target", () => {
  test("when a panel inside the page scrolls", async ({ vw, page }) => {
    await vw.open("/hint-drift.html");
    await vw.startHints();

    const label = await vw.hintLabelFor("Panel link 10");
    expect(label, "the panel link took no hint").not.toBeNull();

    // Two whole rows. Every hinted link then stands where another hinted link
    // stood, so a marker that does not follow sits on the wrong link.
    await page.evaluate(() => {
      const panel = document.getElementById("panel");
      if (panel !== null) panel.scrollTop = 40;
    });

    // The marker layer follows a scroll of the page by itself. A panel that
    // scrolls inside the page moves one element, so each marker must be
    // measured again. This wait is the assertion.
    await waitForMarkerOn(page, label ?? "", "panel-10");

    await vw.type(label ?? "");
    await expect(page).toHaveURL(/#panel-10$/);
  });
});

test.describe("a hint that moved is not activated", () => {
  test("when pointerover moves the link during dispatch", async ({ vw, page }) => {
    await vw.open("/hint-drift.html");
    const before = page.url();
    await vw.startHints();

    const label = await vw.hintLabelFor("Shifty link");
    expect(label, "the shifty link took no hint").not.toBeNull();
    await page.evaluate(() => {
      (globalThis as unknown as {
        moveShiftyOnPointerover: () => void;
      }).moveShiftyOnPointerover();
    });

    await vw.type(label ?? "");
    await vw.waitForHud("Nothing was activated");
    expect(page.url()).toBe(before);
  });

  test("when the page moves the link after the draw", async ({ vw, page }) => {
    await vw.open("/hint-drift.html");
    const before = page.url();
    await vw.startHints();

    const label = await vw.hintLabelFor("Shifty link");
    expect(label, "the shifty link took no hint").not.toBeNull();

    // A transform, so the page moves the link with no scroll and no resize.
    // Nothing tells us, and the marker stays where the user saw it.
    await page.evaluate(() => {
      (globalThis as unknown as { moveShifty: () => void }).moveShifty();
    });

    await vw.type(label ?? "");
    await vw.waitForHud("Nothing was activated");
    expect(page.url()).toBe(before);
  });

  test("when the page covers the link after the draw", async ({ vw, page }) => {
    await vw.open("/hint-drift.html");
    const before = page.url();
    await vw.startHints();

    const label = await vw.hintLabelFor("Steady link");
    expect(label, "the steady link took no hint").not.toBeNull();

    // The link has not moved. Something else is painted over it, so the user
    // is no longer looking at the link that the marker names.
    await page.evaluate(() => {
      (globalThis as unknown as { coverSteady: () => void }).coverSteady();
    });

    await vw.type(label ?? "");
    await vw.waitForHud("Nothing was activated");
    expect(page.url()).toBe(before);
  });

  test("when an area is replaced at the same position", async ({ vw, page }) => {
    await vw.open("/image-maps.html");
    const before = page.url();
    await vw.startHints();

    const label = await vw.hintLabelFor("Left area");
    expect(label, "the area took no hint").not.toBeNull();
    await page.evaluate(() => {
      const area = document.querySelector<HTMLAreaElement>(
        'area[aria-label="Left area"]',
      );
      if (area !== null) area.replaceWith(area.cloneNode(true));
    });

    await vw.type(label ?? "");
    await vw.waitForHud("Nothing was activated");
    expect(page.url()).toBe(before);
  });

  test("an untouched link still activates", async ({ vw, page }) => {
    await vw.open("/hint-drift.html");
    await vw.startHints();

    await vw.activateHint("Steady link");
    await expect(page).toHaveURL(/#steady-target$/);
  });
});

test.describe("a completed font load", () => {
  test("moves the marker before activation", async ({ vw, page }) => {
    await vw.open("/hint-drift.html");
    await vw.startHints();

    const label = await vw.hintLabelFor("Font shifted link");
    expect(label, "the font link took no hint").not.toBeNull();
    await page.evaluate(() => {
      (globalThis as unknown as { finishFontReflow: () => void })
        .finishFontReflow();
    });

    await waitForMarkerOn(page, label ?? "", "font-shifty");
    await vw.type(label ?? "");
    await expect(page).toHaveURL(/#font-target$/);
  });
});
