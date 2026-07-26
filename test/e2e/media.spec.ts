/**
 * The keys a focused media player keeps.
 *
 * Vimium-WebKit binds `<up>`, `<down>`, `<left>`, `<right>` and `<space>` by
 * default and listens in the capture phase, so on a page that focuses a video
 * player — every watch page there is — installing it used to cost the user
 * seek, volume and play/pause outright. Focus, not the URL, decides who owns
 * those five keys.
 *
 * Under `smoothScroll: false` for the same reason `scroller.spec.ts` is: what
 * is under test is *which* of the page and the extension acted, and an exact
 * offset asserted mid-animation would be a flake generator.
 */

import { expect, test, type Vimium } from "./harness/fixtures.ts";
import { DETERMINISTIC } from "./harness/settings-seed.ts";

test.use({ settingsPatch: DETERMINISTIC });

/** The default `scrollStepSize`. */
const STEP = 60;

/** Keys the page's own document-level listener received. */
const pageKeys = (vw: Vimium): Promise<readonly string[]> =>
  vw.page.evaluate(() => {
    const host = globalThis as unknown as { __mediaKeys?: readonly string[] };
    return [...(host.__mediaKeys ?? [])];
  });

const focus = (vw: Vimium, id: string): Promise<void> =>
  vw.page.evaluate((elementId: string) => {
    const element = document.getElementById(elementId);
    if (element instanceof HTMLElement) element.focus({ preventScroll: true });
  }, id);

test.describe("a focused media player", () => {
  test("keeps the arrow keys and space", async ({ vw }) => {
    await vw.open("/media.html");

    await vw.press("ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Space");

    expect(await pageKeys(vw)).toEqual([
      "ArrowDown",
      "ArrowUp",
      "ArrowLeft",
      "ArrowRight",
      " ",
    ]);
    // The player called `preventDefault`, as players do, so nothing scrolled.
    expect((await vw.scrollOffsets()).y).toBe(0);
  });

  test("does not get the rest of the keyboard", async ({ vw }) => {
    // YouTube binds `j`/`k`/`l` too, but a Vim user pressing `j` on a video
    // page means "scroll", and always has.
    await vw.open("/media.html");

    await vw.press("j");

    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);
    expect(await pageKeys(vw)).toEqual([]);
  });

  test("gives the keys back as soon as focus moves off it", async ({ vw }) => {
    await vw.open("/media.html");
    await focus(vw, "plain");

    await vw.press("ArrowDown");

    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);
    expect(await pageKeys(vw)).toEqual([]);
  });
});
