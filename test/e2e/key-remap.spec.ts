/**
 * `mapkey` against the keys that belong to the page.
 *
 * An exclusion rule and a focused media player both name a *physical* key,
 * because the user gives that key to the page. `mapkey` says what the key does
 * for us, which is a later question. The order of the two decides who gets the
 * keystroke, and the exclusion side has its own unit tests in
 * `test/unit/keyboard_test.ts`. This spec covers the media side, where the
 * answer comes from what has focus and therefore needs a browser.
 *
 * `smoothScroll: false`. What is under test is *which* of the page and the
 * application acted. An exact offset asserted mid-animation would be a flake
 * generator.
 */

import { expect, test, type Vimium } from "./harness/fixtures.ts";
import { DETERMINISTIC } from "./harness/settings-seed.ts";

/** The default `scrollStepSize`. */
const STEP = 60;

/** How long a scroll command needs to show that it ran. */
const SETTLE_MS = 400;

/** Keys that the page's own document-level listener received. */
const pageKeys = (vw: Vimium): Promise<readonly string[]> =>
  vw.page.evaluate(() => {
    const host = globalThis as unknown as { __mediaKeys?: readonly string[] };
    return [...(host.__mediaKeys ?? [])];
  });

test.describe("a key that a media player owns", () => {
  test.describe("remapped onto a media key", () => {
    test.use({
      settingsPatch: { ...DETERMINISTIC, keyMappings: "mapkey j <down>" },
    });

    test("still belongs to the application", async ({ vw }) => {
      await vw.open("/media.html");

      // `j` is not a media key. The player owns `<down>`, and the user did not
      // press `<down>`.
      await vw.press("j");

      await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);
      expect(await pageKeys(vw)).toEqual([]);
    });
  });

  test.describe("remapped onto an ordinary key", () => {
    test.use({
      settingsPatch: { ...DETERMINISTIC, keyMappings: "mapkey <down> j" },
    });

    test("still belongs to the page", async ({ vw }) => {
      await vw.open("/media.html");

      // The user pressed the arrow key that the focused player owns.
      await vw.press("ArrowDown");
      await vw.page.waitForTimeout(SETTLE_MS);

      expect(await pageKeys(vw)).toEqual(["ArrowDown"]);
      // The player called `preventDefault`, as players do, so nothing scrolled.
      expect((await vw.scrollOffsets()).y).toBe(0);
    });
  });
});
