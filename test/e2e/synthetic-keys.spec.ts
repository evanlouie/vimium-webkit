/**
 * Keys that the page made, and not the user.
 *
 * A page can call `dispatchEvent` with a `KeyboardEvent` that names any key.
 * Every such event carries `isTrusted === false`, and only the browser can set
 * that flag to `true`. If a synthetic key reached the dispatcher, a page could
 * run any mapped command: open a tab, navigate, close a tab or write the
 * clipboard, with no user input at all.
 *
 * The bundle is injected with `addInitScript`, so it shares the realm of the
 * page. That is the worst case, and it is the case that these tests use.
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

/** How long a command needs to show that it ran. */
const SETTLE_MS = 400;

/** Dispatch a keydown and a keyup for each key, as page script can. */
const dispatchKeys = (vw: Vimium, keys: readonly string[]): Promise<void> =>
  vw.page.evaluate((names: readonly string[]) => {
    for (const name of names) {
      const init: KeyboardEventInit = {
        key: name,
        code: `Key${name.toUpperCase()}`,
        bubbles: true,
        cancelable: true,
        composed: true,
      };
      globalThis.dispatchEvent(new KeyboardEvent("keydown", init));
      globalThis.dispatchEvent(new KeyboardEvent("keyup", init));
    }
  }, keys);

test.describe("a synthetic keyboard event", () => {
  test("runs no command once the application is live", async ({ vw }) => {
    await vw.open("/scrollables.html");

    // `j` scrolls, `G` jumps to the bottom, `t` asks the manager for a tab.
    await dispatchKeys(vw, ["j", "G", "t"]);
    await vw.page.waitForTimeout(SETTLE_MS);

    expect((await vw.scrollOffsets()).y).toBe(0);
    expect((await vw.snapshot()).openedTabs).toEqual([]);

    // The same key from the user still works, so the page is not simply inert.
    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);
  });

  test("is not held during startup and replayed", async ({ vw }) => {
    // No `vw.open`: the key must land while the guard is still waiting. The
    // guard holds a real key and the application replays it, so a synthetic key
    // that entered the buffer would run its command a moment later.
    await vw.page.goto("/scrollables.html");
    await dispatchKeys(vw, ["j"]);

    await vw.boot();
    await vw.page.waitForTimeout(SETTLE_MS);

    expect((await vw.scrollOffsets()).y).toBe(0);
  });
});
