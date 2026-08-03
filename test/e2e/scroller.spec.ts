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

/**
 * The horizontal offset of one container, with zero at its left edge.
 *
 * An engine writes `scrollLeft` in a right-to-left container in one of two
 * ways, and this reads the model the same way that the userscript does: with a
 * hidden probe, and never from the user agent string. The answer is therefore
 * the same number on every engine, which is what the assertions below need.
 */
const normalizedX = (
  vw: Vimium,
  selector: string,
): Promise<{ readonly x: number; readonly max: number }> =>
  vw.page.evaluate((query: string) => {
    const detect = (): "negative" | "nonNegative" => {
      const outer = document.createElement("div");
      outer.setAttribute(
        "style",
        "position:fixed;top:-9999px;left:-9999px;width:4px;height:4px;" +
          "overflow:scroll;direction:rtl;visibility:hidden;",
      );
      const inner = document.createElement("div");
      inner.setAttribute("style", "width:40px;height:1px;");
      outer.appendChild(inner);
      document.body.appendChild(outer);
      let model: "negative" | "nonNegative" = "nonNegative";
      if (outer.scrollLeft <= 0) {
        outer.scrollLeft = -1;
        model = outer.scrollLeft < 0 ? "negative" : "nonNegative";
      }
      outer.remove();
      return model;
    };

    const element = document.querySelector(query);
    if (element === null) return { x: -1, max: -1 };
    const max = element.scrollWidth - element.clientWidth;
    const rtl = getComputedStyle(element).direction === "rtl";
    const shift = rtl && detect() === "negative" ? max : 0;
    return { x: element.scrollLeft + shift, max };
  }, selector);

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

/**
 * Right-to-left containers.
 *
 * Every engine that Playwright builds writes `scrollLeft` in the range
 * `[-max, 0]` for such a container, where zero is the right edge. The room
 * checks used to read that as "no room to the left, and always room to the
 * right".
 */
test.describe("right-to-left scrolling", () => {
  test("`h` moves a right-to-left container towards its left edge", async ({ vw }) => {
    await vw.open("/rtl-scroll.html");
    await focus(vw, "rtl-inner-focus");

    const before = await normalizedX(vw, "#rtl-inner");
    expect(before.x).toBe(before.max);

    await vw.press("h");

    await expect.poll(async () => (await normalizedX(vw, "#rtl-inner")).x)
      .toBe(before.max - STEP);
    // The document must not take a command that the container can absorb.
    const outer = await normalizedX(vw, "#rtl-outer");
    expect(outer.x).toBe(outer.max);
  });

  test("`zH` goes to the left edge, and `zL` to the right one", async ({ vw }) => {
    await vw.open("/rtl-scroll.html");
    await focus(vw, "rtl-inner-focus");

    await vw.press("z", "H");
    await expect.poll(async () => (await normalizedX(vw, "#rtl-inner")).x)
      .toBe(0);

    await vw.press("z", "L");
    const end = await normalizedX(vw, "#rtl-inner");
    expect(end.x).toBe(end.max);
  });

  test("an exhausted container passes the rest to its ancestor", async ({ vw }) => {
    await vw.open("/rtl-scroll.html");

    // Give the outer container room to the right, and leave the inner one at
    // its own right edge.
    await focus(vw, "rtl-outer-focus");
    const outerStart = await normalizedX(vw, "#rtl-outer");
    expect(outerStart.x).toBe(outerStart.max);

    await vw.press("h");
    await expect.poll(async () => (await normalizedX(vw, "#rtl-outer")).x)
      .toBe(outerStart.max - STEP);

    await focus(vw, "rtl-inner-focus");
    const innerBefore = await normalizedX(vw, "#rtl-inner");
    expect(innerBefore.x).toBe(innerBefore.max);

    await vw.press("l");

    await expect.poll(async () => (await normalizedX(vw, "#rtl-outer")).x)
      .toBe(outerStart.max);
    expect((await normalizedX(vw, "#rtl-inner")).x).toBe(innerBefore.x);
    expect((await vw.scrollOffsets()).x).toBe(0);
  });

  test("a left-to-right container inside the same page still works", async ({ vw }) => {
    await vw.open("/rtl-scroll.html");
    await focus(vw, "ltr-focus");

    await vw.press("l");

    await expect.poll(async () => (await vw.scrollOffsets("#ltr-box")).x)
      .toBe(STEP);
  });
});
