/**
 * Focus events that the page made, and not the user.
 *
 * A page can call `dispatchEvent` with a `FocusEvent`. Such an event carries
 * `isTrusted === false`, and only the browser can set that flag to `true`.
 *
 * The two directions are both attacks. A `blur` that names the focused field
 * leaves insert mode. The next true key of the user then runs a command while
 * the caret is still in the field. A `focus` on a text field starts insert
 * mode, and every binding of the user then stops.
 *
 * The bundle is injected with `addInitScript`, so it shares the realm of the
 * page. That is the worst case, and it is the case that these tests use.
 *
 * `smoothScroll: false`, because what is under test is *whether* the page
 * scrolled. An exact offset asserted mid-animation would be a flake generator.
 */

import { expect, test, type Vimium } from "./harness/fixtures.ts";
import { DETERMINISTIC } from "./harness/settings-seed.ts";

test.use({ settingsPatch: DETERMINISTIC });

/** The default `scrollStepSize`. */
const STEP = 60;

/** How long a command needs to show that it ran. */
const SETTLE_MS = 400;

/** Dispatch one focus event from page script, on the field in the page. */
const dispatchFocusEvent = (vw: Vimium, type: string): Promise<void> =>
  vw.page.evaluate((name: string) => {
    const field = document.getElementById("light-field");
    field?.dispatchEvent(
      new FocusEvent(name, { bubbles: false, composed: true }),
    );
  }, type);

const fieldValue = (vw: Vimium): Promise<string> =>
  vw.page.evaluate(() => {
    const field = document.getElementById("light-field");
    return field instanceof HTMLInputElement ? field.value : "";
  });

test.describe("a synthetic focus event", () => {
  test("does not take the user out of insert mode", async ({ vw }) => {
    await vw.open("/shadow-input.html");
    await vw.page.click("#light-field");

    // The field has the caret, so `j` is a character and not a command.
    await vw.type("j");
    expect(await fieldValue(vw)).toBe("j");

    await dispatchFocusEvent(vw, "blur");
    await vw.page.waitForTimeout(SETTLE_MS);

    // The caret never moved, so this key is still the user's own text.
    await vw.type("j");
    await vw.page.waitForTimeout(SETTLE_MS);

    expect(await fieldValue(vw)).toBe("jj");
    expect((await vw.scrollOffsets()).y).toBe(0);
  });

  test("does not put the user into insert mode", async ({ vw }) => {
    await vw.open("/shadow-input.html");

    await dispatchFocusEvent(vw, "focus");
    await vw.page.waitForTimeout(SETTLE_MS);

    // Nothing has the caret, so `j` is the scroll command that it is mapped to.
    await vw.press("j");

    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);
    expect(await fieldValue(vw)).toBe("");
  });
});
