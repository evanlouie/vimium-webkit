/**
 * Keys that the page made, and not the user.
 *
 * A page can call `dispatchEvent` with a `KeyboardEvent` that names any key.
 * Every such event carries `isTrusted === false`, and only the browser can set
 * that flag to `true`. A synthetic key that reached the dispatcher would let a
 * page run any mapped command. Such a command can open a tab, navigate, close
 * a tab or write the clipboard, with no user input at all.
 *
 * The bundle is injected with `addInitScript`, so it shares the realm of the
 * page. That is the worst case, and it is the case that these tests use.
 *
 * `smoothScroll: false`. What is under test is *whether* the page scrolled. An
 * exact offset asserted mid-animation would be a flake generator.
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

/** Dispatch one key, and say whether anything called `preventDefault`. */
const dispatchKeyAndAsk = (vw: Vimium, key: string): Promise<boolean> =>
  vw.page.evaluate((name: string) => {
    const event = new KeyboardEvent("keydown", {
      key: name,
      code: `Key${name.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    globalThis.dispatchEvent(event);
    return event.defaultPrevented;
  }, key);

/** How many overlay hosts this page has. One means that we started. */
const overlayCount = (vw: Vimium): Promise<number> =>
  vw.page.locator("vimium-webkit-overlay").count();

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
    // guard holds a real key, and the application replays it. A synthetic key
    // that entered the buffer would therefore run its command a moment later.
    await vw.page.goto("/scrollables.html");
    await dispatchKeys(vw, ["j"]);

    await vw.boot();
    await vw.page.waitForTimeout(SETTLE_MS);

    expect((await vw.scrollOffsets()).y).toBe(0);
  });

  /**
   * The guard is the outer check, and it has its own observable effect.
   *
   * The guard suppresses the key that starts the application, and then builds
   * the whole runtime. A page must be able to do neither.
   */
  test("does not start the application on a cold page", async ({ vw }) => {
    await vw.page.goto("/scrollables.html");

    const prevented = await dispatchKeyAndAsk(vw, "j");
    await vw.page.waitForTimeout(SETTLE_MS);

    // The page keeps its own key: nothing called `preventDefault` on it.
    expect(prevented).toBe(false);
    // The overlay host is the visible proof that the application started. The
    // top frame starts on its own 1200 ms after load, which is later than this.
    expect(await overlayCount(vw)).toBe(0);
  });
});
