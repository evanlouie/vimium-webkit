/**
 * Insert mode against a field inside an open shadow root.
 *
 * A `focus` event that starts inside a shadow root is retargeted to the host
 * before a window listener sees it. Insert mode read `event.target`, so a page
 * that keeps its search box in a web component looked unfocused, and every
 * mapped key that the user typed there ran a command instead of a character.
 *
 * `smoothScroll: false`, because what is under test is *whether* the page
 * scrolled, and an exact offset asserted mid-animation would be a flake
 * generator.
 */

import { expect, test, type Vimium } from "./harness/fixtures.ts";
import { DETERMINISTIC } from "./harness/settings-seed.ts";

test.use({ settingsPatch: DETERMINISTIC });

/** The default `scrollStepSize`. */
const STEP = 60;

/** How long a scroll command needs to show that it ran. */
const SETTLE_MS = 400;

const focusShadowField = (vw: Vimium): Promise<void> =>
  vw.page.evaluate(() => {
    const host = document.getElementById("widget-host");
    const field = host?.shadowRoot?.querySelector("input") ?? null;
    if (field !== null) field.focus({ preventScroll: true });
  });

const shadowFieldValue = (vw: Vimium): Promise<string> =>
  vw.page.evaluate(() => {
    const host = document.getElementById("widget-host");
    const field = host?.shadowRoot?.querySelector("input") ?? null;
    return field === null ? "" : field.value;
  });

test.describe("a text field in an open shadow root", () => {
  test("takes the keys that the user types", async ({ vw }) => {
    await vw.open("/shadow-input.html");
    await focusShadowField(vw);

    // `j` and `g` are mapped in normal mode. Both must arrive as characters.
    await vw.type("jg");
    await vw.page.waitForTimeout(SETTLE_MS);

    expect(await shadowFieldValue(vw)).toBe("jg");
    expect((await vw.scrollOffsets()).y).toBe(0);
  });

  test("gives the keys back when the user leaves it", async ({ vw }) => {
    await vw.open("/shadow-input.html");
    await focusShadowField(vw);

    await vw.press("Escape");
    await vw.press("j");

    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);
    expect(await shadowFieldValue(vw)).toBe("");
  });
});
