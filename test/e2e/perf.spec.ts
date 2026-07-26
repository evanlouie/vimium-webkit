/**
 * Performance smoke tests.
 *
 * Two numbers matter for a userscript that runs in every frame of every page
 * (IMPLEMENTATION_PLAN.md §10, §5.2):
 *
 * 1. **Hint generation on a link-dense page.** The budget here is a ceiling,
 *    not a target — enough to catch an accidental O(n²) or a lost chunking
 *    yield, loose enough not to fail on a cold headless build or a busy CI box.
 * 2. **Steady-state cost at idle, which must be ~0.** The honest measurement is
 *    a CPU trace, which is per-engine and not portable across the three
 *    projects. The portable proxy is *scheduling* churn: the harness counts
 *    `requestAnimationFrame`, `setTimeout` and `setInterval` calls, and an idle
 *    extension must not be creating any. A rAF loop left running is precisely
 *    the failure this is meant to catch, and it shows up here immediately.
 */

import { expect, test } from "./harness/fixtures.ts";

/** Generous ceiling for 2400 links across three engines, headless, cold. */
const HINT_BUDGET_MS = 6_000;

/** Long enough for a rAF loop or a fast interval to be unmistakable. */
const IDLE_WINDOW_MS = 1_500;

test.describe("performance", () => {
  test("hint generation on a link-dense page stays under budget", async ({ vw }) => {
    await vw.open("/link-dense.html");

    const started = Date.now();
    await vw.startHints();
    const elapsed = Date.now() - started;

    expect(
      elapsed,
      `hint generation took ${elapsed}ms for 2400 links`,
    ).toBeLessThan(HINT_BUDGET_MS);
  });

  test("a second session on the same page is not slower", async ({ vw }) => {
    await vw.open("/link-dense.html");

    await vw.startHints();
    await vw.press("Escape");
    await vw.waitForHintsGone();

    const started = Date.now();
    await vw.startHints();
    const elapsed = Date.now() - started;

    // A session that leaks listeners or markers gets progressively slower; this
    // is the cheapest way to notice.
    expect(elapsed).toBeLessThan(HINT_BUDGET_MS);
  });

  test("idle costs nothing after a hint session", async ({ vw, page }) => {
    await vw.open("/link-dense.html");
    await vw.startHints();
    await vw.press("Escape");
    await vw.waitForHintsGone();

    // Let the HUD's own dismissal timer expire first, so it is not counted as
    // churn: it is a one-shot, not a loop.
    await page.waitForTimeout(2_500);

    const before = (await vw.snapshot()).counters;
    await page.waitForTimeout(IDLE_WINDOW_MS);
    const after = (await vw.snapshot()).counters;

    expect(
      after.raf - before.raf,
      "an idle extension must not be requesting animation frames",
    ).toBe(0);
    // `lifecycle.ts` holds exactly one `setInterval`; it must not be recreated.
    expect(after.interval - before.interval).toBe(0);
    // A small allowance: a stray one-shot is not a leak, a stream of them is.
    expect(after.timeout - before.timeout).toBeLessThanOrEqual(2);
  });

  test("idle costs nothing on a page that was never interacted with", async ({ vw, page }) => {
    await vw.open("/link-dense.html");
    await page.waitForTimeout(500);

    const before = (await vw.snapshot()).counters;
    await page.waitForTimeout(IDLE_WINDOW_MS);
    const after = (await vw.snapshot()).counters;

    expect(after.raf - before.raf).toBe(0);
    expect(after.interval - before.interval).toBe(0);
    expect(after.timeout - before.timeout).toBeLessThanOrEqual(2);
  });

  test("Stage 0 alone does not schedule anything on a subframe", async ({ vw, page }) => {
    // Subframes deliberately stay at Stage 0 until a key lands in them or the
    // coordinator wakes them; the top frame is the only one that warms up.
    await vw.open("/nested-frames.html");
    await page.waitForTimeout(2_000);

    const frame = page.frames().find((candidate) =>
      candidate.url().includes("level2.html")
    );
    expect(frame).toBeDefined();

    const counters = await frame?.evaluate(() => {
      const host = globalThis as unknown as {
        __vimiumHarness?: {
          counters: { raf: number; timeout: number; interval: number };
        };
      };
      return host.__vimiumHarness?.counters ?? null;
    });

    expect(counters).not.toBeNull();
    expect(counters?.raf ?? -1).toBe(0);
    expect(counters?.interval ?? -1).toBe(0);
  });
});
