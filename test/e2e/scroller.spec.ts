/**
 * Scroll commands against `scrollables.html`.
 *
 * Under `smoothScroll: false`, opted into explicitly below: the animator
 * calibrates against real frame throughput, so an assertion on an exact offset
 * mid-animation would be a flake generator. What is under test here is *which
 * element absorbs the scroll*, which is `findScrollableAncestor`'s job and is
 * independent of the animation.
 *
 * The shipped default is `smoothScroll: true`, and it has its own coverage in
 * `smooth-scroll.spec.ts` — the harness used to force this setting on every
 * spec, which left the default scroll path with no integration coverage at all.
 */

import { expect, test, type Vimium } from "./harness/fixtures.ts";
import { DETERMINISTIC } from "./harness/settings-seed.ts";

test.use({ settingsPatch: DETERMINISTIC });

/** Focus without scrolling, so the focus itself does not move the viewport. */
const focus = (vw: Vimium, id: string): Promise<void> =>
  vw.page.evaluate((elementId: string) => {
    const element = document.getElementById(elementId);
    if (element instanceof HTMLElement) element.focus({ preventScroll: true });
  }, id);

/** The default `scrollStepSize`. */
const STEP = 60;

test.describe("scrolling", () => {
  test("the activation key is suppressed before the application replays it", async ({ vw }) => {
    // Do not call `vw.open`: it explicitly wakes and waits for the overlay. This
    // key must land while the guard is still building the application.
    await vw.page.goto("/scrollables.html");
    await vw.page.evaluate(() => {
      (globalThis as typeof globalThis & { __pageKeys?: number }).__pageKeys =
        0;
      globalThis.addEventListener("keydown", () => {
        const scope = globalThis as typeof globalThis & { __pageKeys?: number };
        scope.__pageKeys = (scope.__pageKeys ?? 0) + 1;
      });
    });

    await vw.page.keyboard.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);
    expect(
      await vw.page.evaluate(() =>
        (globalThis as typeof globalThis & { __pageKeys?: number }).__pageKeys
      ),
    ).toBe(0);
  });

  test("`j`/`k` scroll the document by one step", async ({ vw }) => {
    await vw.open("/scrollables.html");

    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);

    await vw.press("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP * 2);

    await vw.press("k");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);
  });

  test("`gg` and `G` jump to the ends", async ({ vw }) => {
    await vw.open("/scrollables.html");

    await vw.press("G");
    await expect.poll(async () => (await vw.scrollOffsets()).y)
      .toBeGreaterThan(1000);

    await vw.press("g", "g");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(0);
  });

  test("`d` and `u` move by half a viewport", async ({ vw }) => {
    await vw.open("/scrollables.html");
    const half = Math.round(
      (await vw.page.evaluate(() => globalThis.innerHeight)) * 0.5,
    );

    await vw.press("d");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(half);

    await vw.press("u");
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(0);
  });

  test("scrolls the nearest scrollable ancestor, not the document", async ({ vw }) => {
    await vw.open("/scrollables.html");
    await focus(vw, "inner-focus");

    await vw.press("j");

    await expect.poll(async () => (await vw.scrollOffsets("#inner")).y)
      .toBe(STEP);
    expect((await vw.scrollOffsets("#outer")).y).toBe(0);
    expect((await vw.scrollOffsets()).y).toBe(0);
  });

  test("walks past a container that only looks scrollable", async ({ vw }) => {
    await vw.open("/scrollables.html");
    await focus(vw, "fake-focus");

    // `#fake` has `scrollHeight` far greater than `clientHeight` but
    // `overflow: hidden`, so the user cannot scroll it. The scroll must fall
    // through to the document rather than disappearing into it.
    await vw.press("j");

    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP);
    expect((await vw.scrollOffsets("#fake")).y).toBe(0);
  });

  test("an outer container absorbs the scroll once the inner one is exhausted", async ({ vw }) => {
    await vw.open("/scrollables.html");
    await focus(vw, "outer-focus");

    await vw.press("j");

    await expect.poll(async () => (await vw.scrollOffsets("#outer")).y)
      .toBe(STEP);
    expect((await vw.scrollOffsets()).y).toBe(0);
  });

  test("a count prefix multiplies the step", async ({ vw }) => {
    await vw.open("/scrollables.html");

    await vw.press("3", "j");

    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(STEP * 3);
  });
});
