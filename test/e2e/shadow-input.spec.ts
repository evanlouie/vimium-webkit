/**
 * Insert mode against a field inside an open shadow root.
 *
 * A `focus` event that starts inside a shadow root is retargeted to the host
 * before a window listener sees it. Insert mode read `event.target`, so a page
 * that keeps its search box in a web component looked unfocused. Every mapped
 * key that the user typed there ran a command instead of a character.
 *
 * `smoothScroll: false`. What is under test is *whether* the page scrolled. An
 * exact offset asserted mid-animation would be a flake generator.
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

/** Does the field inside the shadow root hold the caret? */
const shadowFieldHasFocus = (vw: Vimium): Promise<boolean> =>
  vw.page.evaluate(() => {
    const host = document.getElementById("widget-host");
    const root = host?.shadowRoot ?? null;
    const field = root?.querySelector("input") ?? null;
    return field !== null && root?.activeElement === field;
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

/**
 * The guard, and a user who is already typing into a shadow field.
 *
 * `grabBackFocus` takes the focus back from a page that stole it on load. It
 * must not do that to a user who is typing. The guard learns that the user
 * typed from the key events that arrive before the application exists. A key
 * inside an open shadow root names the host at a window listener.
 */
test.describe("a user who types into a shadow field before the start", () => {
  test.use({ settingsPatch: { ...DETERMINISTIC, grabBackFocus: true } });

  test("keeps the field", async ({ vw }) => {
    // No `vw.open`: the key must land while the guard is still waiting.
    await vw.page.goto("/shadow-input.html");
    await focusShadowField(vw);
    await vw.type("j");

    await vw.boot();
    await vw.page.waitForTimeout(SETTLE_MS);

    expect(await shadowFieldHasFocus(vw)).toBe(true);
    // The guard left the key alone, so the character is in the field.
    expect(await shadowFieldValue(vw)).toBe("j");
    expect((await vw.scrollOffsets()).y).toBe(0);
  });
});
