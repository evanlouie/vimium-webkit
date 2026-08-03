/**
 * The page lifecycle, against the shipped bundle.
 *
 * Three rules are under test:
 *
 * 1. A page that the browser keeps must stay alive. `pagehide` with
 *    `persisted === true` means that the page may come back from the
 *    back/forward cache, and a restored page never runs its scripts again.
 *    A frame that released its runtime there would come back dead.
 * 2. A page that will not come back must let everything go. The overlay host
 *    belongs to the runtime scope, so its absence is the visible proof that the
 *    scope closed.
 * 3. A child frame exits alone. Each frame has its own realm and its own
 *    runtime, so a child that goes away must take nothing from the top frame.
 *
 * > [!IMPORTANT]
 * > Playwright does not give a true back/forward cache: `page.goBack()` loads
 * > the document again, and `pageshow.persisted` is always `false`. The
 * > `#document-id` field in the fixture reports this. The cache round trip is
 * > therefore driven by the two events that the browser would send, which is
 * > exactly what the code branches on. The real "leave and come back" is tested
 * > as well, and it asserts that the key bindings work afterwards.
 * >
 * > One thing the synthetic events do not do: a real restore **freezes** the
 * > document first. Every timer, the Effect scheduler and every suspended fiber
 * > stop, and then start again. This test therefore shows that the branch is
 * > correct. It does not show that a frozen scheduler still delivers work.
 * > Chromium refuses the cache while a DevTools client is attached. Firefox
 * > loses its execution context, and WebKit gives a new document. No engine
 * > that Playwright drives can show it.
 *
 * Under `smoothScroll: false`: what is under test is whether a key still does
 * anything at all, and an assertion on an offset mid-animation would be a flake
 * generator.
 */

import type { Page } from "@playwright/test";
import { expect, test, type Vimium } from "./harness/fixtures.ts";
import { DETERMINISTIC } from "./harness/settings-seed.ts";

test.use({ settingsPatch: DETERMINISTIC });

/** The default `scrollStepSize`. */
const STEP = 60;

/** Long enough for a runtime scope to close, and short enough to be a test. */
const RELEASE_MS = 5_000;

/**
 * Send the page transition events, with the `persisted` flag that we choose.
 *
 * The constructor is the correct way to make one. A realm that does not have it
 * gets a plain event with the one field that the code reads.
 */
const sendTransition = (
  page: Page,
  type: "pagehide" | "pageshow",
  persisted: boolean,
): Promise<void> =>
  page.evaluate(
    ({ eventType, kept }: { eventType: string; kept: boolean }) => {
      let event: Event;
      try {
        event = new PageTransitionEvent(eventType, { persisted: kept });
      } catch {
        event = new Event(eventType);
        Object.defineProperty(event, "persisted", { value: kept });
      }
      globalThis.dispatchEvent(event);
    },
    { eventType: type, kept: persisted },
  );

test.describe("the page lifecycle", () => {
  test("a page that the browser keeps still answers the keyboard", async ({ vw, page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await vw.open("/lifecycle.html");
    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);

    // The round trip through the back/forward cache. The page is frozen, and
    // then it is restored with the same document and the same runtime.
    await sendTransition(page, "pagehide", true);
    await sendTransition(page, "pageshow", true);

    // The overlay belongs to the runtime scope. It is still here, so the scope
    // is still open.
    await expect(page.locator("vimium-webkit-overlay")).toHaveCount(1);

    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP * 2);
    expect(errors).toEqual([]);
  });

  test("a page that will not come back releases the overlay", async ({ vw, page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await vw.open("/lifecycle.html");
    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);

    // `persisted === false`: this document will not run again.
    await sendTransition(page, "pagehide", false);

    await expect(page.locator("vimium-webkit-overlay")).toHaveCount(0, {
      timeout: RELEASE_MS,
    });
    expect(errors).toEqual([]);
  });

  test("the key bindings still work after leaving and coming back", async ({ vw, page }) => {
    await vw.open("/lifecycle.html");
    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);

    await page.locator("#leave").click();
    await expect(page).toHaveURL(/long-text\.html$/);

    await page.goBack();
    await expect(page).toHaveURL(/lifecycle\.html$/);
    // Playwright loads the document again, so the guard is new and it waits to
    // be wanted. A restored document would already be running, and `boot()`
    // would find the overlay at once.
    await vw.boot();

    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y)
      .toBeGreaterThan(0);
  });

  test("a child frame that goes away leaves the top frame alone", async ({ vw, page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/lifecycle.html");
    await vw.bootAllFrames();
    await page.locator("#drop-child").click();
    await expect(page.frameLocator("#child").locator("#remote-link"))
      .toBeAttached();

    // The top frame never saw a `pagehide` of its own.
    await expect(page.locator("vimium-webkit-overlay")).toHaveCount(1);
    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);
    expect(errors).toEqual([]);
  });

  test("a child frame that is removed leaves the top frame alone", async ({ vw, page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/lifecycle.html");
    await vw.bootAllFrames();

    // The other test navigates the child. This one takes the element out of
    // the tree. WebKit sends `pagehide` with `persisted === false` for both.
    await page.locator("#remove-child").click();
    await expect(page.locator("#child")).toHaveCount(0);

    await expect(page.locator("vimium-webkit-overlay")).toHaveCount(1);
    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);
    expect(errors).toEqual([]);
  });
});

/**
 * Does a changed value reach the store when the page goes away?
 *
 * This is issue #11, end to end. Every group joins its writes for a while:
 * marks for 100 ms, settings for 250 ms and the history index for two seconds.
 * A user who leaves inside one of those windows used to lose the change.
 *
 * The store of the harness is mirrored into `localStorage` under a private
 * prefix, so it survives the document. The spec can therefore change a value,
 * leave the page, and read the value back on the next document.
 */
test.describe("what a dying page saves", () => {
  /** The marks group joins its writes for 100 ms. This is inside that window. */
  const INSIDE_THE_WINDOW_MS = 20;

  const MARKS_KEY = "vimium-webkit:marks";

  /**
   * What the store held before the dispatch, and what it held inside it.
   *
   * Both reads happen in the page, in one turn with the dispatch of the event.
   * That is the whole question of issue #11: the acceptance criterion is that
   * the backend call starts before the handler returns. A macrotask that starts
   * inside `pagehide` never runs, so nothing later counts.
   */
  const dispatchAndRead = (page: Page): Promise<{
    before: string | null;
    during: string | null;
  }> =>
    page.evaluate((key: string) => {
      const host = globalThis as unknown as {
        __vimiumHarness?: { store: Map<string, string> };
      };
      const store = host.__vimiumHarness?.store ?? new Map<string, string>();
      const before = store.get(key) ?? null;

      let event: Event;
      try {
        event = new PageTransitionEvent("pagehide", { persisted: false });
      } catch {
        event = new Event("pagehide");
        Object.defineProperty(event, "persisted", { value: false });
      }
      globalThis.dispatchEvent(event);

      // The same synchronous turn. This is everything that a dying page saves.
      return { before, during: store.get(key) ?? null };
    }, MARKS_KEY);

  const setLocalMark = async (vw: Vimium, page: Page): Promise<void> => {
    await vw.open("/lifecycle.html");
    // `m` then `a` sets the local mark `a`. The write joins the window of the
    // marks group, so nothing has reached the manager yet.
    await vw.press("m", "a");
    await page.waitForTimeout(INSIDE_THE_WINDOW_MS);
  };

  test("the mark reaches the manager inside the pagehide dispatch", async ({ vw, page }) => {
    await setLocalMark(vw, page);

    const { before, during } = await dispatchAndRead(page);

    expect(before, "the debounce window must still hold the mark").toBeNull();
    expect(during ?? "").toContain('"a"');
  });

  test.describe("with a manager that only gives promises", () => {
    test.use({ gmVariant: "async" });

    test("the call still starts inside the dispatch", async ({ vw, page }) => {
      // quoid and Stay have no `GM_setValue`. The exit path calls
      // `GM.setValue` and does not wait for the promise. The call starts on the
      // stack of the handler, and the manager finishes it in its own process.
      await setLocalMark(vw, page);

      const { before, during } = await dispatchAndRead(page);

      expect(before, "the debounce window must still hold the mark").toBeNull();
      expect(during ?? "").toContain('"a"');
    });
  });

  test("a mark survives a real navigation to another document", async ({ vw, page }) => {
    // The whole loop: change a value, leave the page, and read the value back
    // on the next document. The store of the harness is mirrored into
    // `localStorage`, so it outlives the realm that wrote it.
    await setLocalMark(vw, page);

    await page.locator("#leave").click();
    await expect(page).toHaveURL(/long-text\.html$/);

    const stored = (await vw.snapshot()).stored;
    expect(stored[MARKS_KEY] ?? "").toContain('"a"');
  });
});
