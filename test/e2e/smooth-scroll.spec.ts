/**
 * The default scroll path.
 *
 * `smoothScroll` ships **on**, and until the harness stopped forcing it off,
 * this entire path had zero integration coverage — which is what let a family
 * of defects survive: scrollability was probed by writing `scrollTop` and
 * reading it back in the same task, which under `scroll-behavior: smooth`
 * returns the *old* value, so nested smooth scrollers were never targeted.
 *
 * Assertions here are deliberately about *where the scroll ends up*, polled
 * until the animation settles, never about an offset mid-flight. That is the
 * contract a user perceives, and it is the only one an animated scroll can
 * honour deterministically.
 */

import { expect, test } from "./harness/fixtures.ts";

/** The default `scrollStepSize`. */
const STEP = 60;

/** Comfortably past the animator's longest step duration. */
const SETTLE_MS = 1500;

test.describe("smooth scrolling (shipped default)", () => {
  test("`j` settles exactly one step down", async ({ vw }) => {
    await vw.open("/scrollables.html");

    await vw.press("j");
    await expect.poll(
      async () => (await vw.scrollOffsets()).y,
      { timeout: SETTLE_MS },
    ).toBe(STEP);
  });

  test("`j` then `k` returns to where it started", async ({ vw }) => {
    await vw.open("/scrollables.html");

    await vw.press("j");
    await expect.poll(
      async () => (await vw.scrollOffsets()).y,
      { timeout: SETTLE_MS },
    ).toBe(STEP);

    await vw.press("k");
    await expect.poll(
      async () => (await vw.scrollOffsets()).y,
      { timeout: SETTLE_MS },
    ).toBe(0);
  });

  test("`G` and `gg` reach the ends", async ({ vw }) => {
    await vw.open("/scrollables.html");

    await vw.press("G");
    await expect.poll(
      async () => (await vw.scrollOffsets()).y,
      { timeout: SETTLE_MS },
    ).toBeGreaterThan(STEP * 4);

    await vw.press("g", "g");
    await expect.poll(
      async () => (await vw.scrollOffsets()).y,
      { timeout: SETTLE_MS },
    ).toBe(0);
  });

  test("a nested scroller absorbs the scroll, not the document", async ({ vw }) => {
    await vw.open("/scrollables.html");
    // The handle rather than the container: a bare `overflow: scroll` div is
    // not focusable, so focusing it is a no-op on WebKit.
    await vw.page.evaluate(() => {
      document.getElementById("inner-focus")?.focus({ preventScroll: true });
    });

    await vw.press("j");
    await expect.poll(
      async () => (await vw.scrollOffsets("#inner")).y,
      { timeout: SETTLE_MS },
    ).toBe(STEP);
    expect((await vw.scrollOffsets()).y).toBe(0);
  });

  test("repeated steps accumulate rather than fighting each other", async ({ vw }) => {
    await vw.open("/scrollables.html");

    // Key repeat merges into the running animation. The regression this pins
    // is a backwards jump on the first repeat frame, from `applied` not being
    // rebased when the elapsed clock resets.
    await vw.press("j", "j", "j");
    await expect.poll(
      async () => (await vw.scrollOffsets()).y,
      { timeout: SETTLE_MS },
    ).toBe(STEP * 3);
  });

  test("a count prefix multiplies the step", async ({ vw }) => {
    await vw.open("/scrollables.html");

    await vw.press("3", "j");
    await expect.poll(
      async () => (await vw.scrollOffsets()).y,
      { timeout: SETTLE_MS },
    ).toBe(STEP * 3);
  });

  test("an inner container gives the rest of a step to its ancestor", async ({ vw }) => {
    await vw.open("/scrollables.html");

    // Ten pixels of room, and a command of sixty. The animated path measures
    // the movement of each frame, so it can end a container in the middle of
    // a command. The rest must reach the ancestor.
    const room = 10;
    const limit = await vw.page.evaluate((left: number) => {
      const inner = document.getElementById("inner");
      if (inner === null) return -1;
      const max = inner.scrollHeight - inner.clientHeight;
      inner.scrollTop = max - left;
      return max;
    }, room);
    expect(limit).toBeGreaterThan(room);

    await vw.page.evaluate(() => {
      document.getElementById("inner-focus")?.focus({ preventScroll: true });
    });
    await vw.press("j");

    await expect.poll(
      async () => (await vw.scrollOffsets("#inner")).y,
      { timeout: SETTLE_MS },
    ).toBe(limit);
    await expect.poll(
      async () => (await vw.scrollOffsets("#outer")).y,
      { timeout: SETTLE_MS },
    ).toBe(STEP - room);
    expect((await vw.scrollOffsets()).y).toBe(0);
  });

  test("a mark jump beats the animation that is running", async ({ vw }) => {
    await vw.open("/scrollables.html");

    // The mark is set at the top of the document.
    await vw.press("m", "a");

    // A key that stays down extends the animation for as long as it is held,
    // so this animation is still running when the mark jump arrives.
    await vw.page.keyboard.down("j");
    await expect.poll(async () => (await vw.scrollOffsets()).y)
      .toBeGreaterThan(STEP);

    await vw.press("`", "a");
    await vw.page.keyboard.up("j");

    // The next animation frame used to write its own goal over the mark.
    await expect.poll(
      async () => (await vw.scrollOffsets()).y,
      { timeout: SETTLE_MS },
    ).toBe(0);
    // And it must stay there, which only a stopped animation can promise.
    await vw.page.waitForTimeout(300);
    expect((await vw.scrollOffsets()).y).toBe(0);
  });
});
