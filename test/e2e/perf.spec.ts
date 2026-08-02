/**
 * Performance smoke tests.
 *
 * Two numbers matter for a userscript that runs in every frame of every page
 * (IMPLEMENTATION_PLAN.md §10, §5.2):
 *
 * 1. **Hint generation on a link-dense page.** The budget here is a ceiling,
 *    not a target — enough to catch an accidental O(n²) or a lost chunking
 *    yield, loose enough not to fail on a cold headless build or a busy CI box.
 * 2. **Cost at `document-start`, per frame.** A userscript is one IIFE
 *    evaluated in every frame of every page, so this is the number that scales
 *    with a page's iframe count. It used to be guarded only by the 3 KB Stage 0
 *    budget, which measures a chunk that costs ~0 ms and says nothing about the
 *    rest of the graph — the real per-frame cost doubled during the Effect
 *    migration with that budget still reading green.
 * 3. **Steady-state cost at idle, which must be ~0.** The honest measurement is
 *    a CPU trace, which is per-engine and not portable across the three
 *    projects. The portable proxy is *scheduling* churn: the harness counts
 *    `requestAnimationFrame`, `setTimeout` and `setInterval` calls, and an idle
 *    extension must not be creating any. A rAF loop left running is precisely
 *    the failure this is meant to catch, and it shows up here immediately.
 */

import { expect, test } from "./harness/fixtures.ts";
import { readBundle } from "./harness/bundle.ts";

/** Generous ceiling for 2400 links across three engines, headless, cold. */
const HINT_BUDGET_MS = 6_000;

/** Long enough for a rAF loop or a fast interval to be unmistakable. */
const IDLE_WINDOW_MS = 1_500;

/**
 * Frames to evaluate the artefact in, and the ceiling for the total.
 *
 * Per engine, because they are not comparable: on an idle machine the same
 * artefact in 21 frames costs ~75 ms in WebKit, ~58 ms in Chromium and ~500 ms
 * in Firefox. A single ceiling calibrated on WebKit put Firefox at 85% of it
 * before anything else was running, and the suite went red on an unchanged
 * tree about one run in three — which teaches everyone to re-run the suite,
 * and that is the end of the gate.
 *
 * Each is roughly 3–5× its measured idle value. That is loose: it will not
 * catch a doubling, and it is not meant to — it is a tripwire for the order of
 * magnitude, sized so it stays quiet on a loaded 2-vCPU CI runner. A gate that
 * fails at random is a gate everyone learns to re-run.
 */
const EVAL_FRAMES = 20;
const EVAL_BUDGET_MS: Readonly<Record<string, number>> = {
  webkit: 400,
  chromium: 400,
  firefox: 1_800,
};

test.describe("performance", () => {
  test(
    "the artefact stays affordable to evaluate in every frame",
    async ({ page }, testInfo) => {
      const source = readBundle();
      const budget = EVAL_BUDGET_MS[testInfo.project.name];
      // Rather than defaulting: an unknown project would otherwise be handed the
      // loosest ceiling silently, which is how a new engine gets no gate at all.
      if (budget === undefined) {
        throw new Error(`no evaluation budget for ${testInfo.project.name}`);
      }

      await page.setContent(
        `<!doctype html><html><body>${
          Array.from(
            { length: EVAL_FRAMES },
            () => `<iframe src="about:blank"></iframe>`,
          ).join("")
        }</body></html>`,
      );

      // Every frame, because that is what a manager does at `document-start`.
      let total = 0;
      let measured = 0;
      for (const frame of page.frames()) {
        // Sequential on purpose: evaluating twenty frames at once would measure
        // contention rather than the per-frame cost.
        // eslint-disable-next-line no-await-in-loop
        const ms = await frame.evaluate((code) => {
          const started = performance.now();
          (0, eval)(code);
          return performance.now() - started;
        }, source).catch(() => null);
        if (typeof ms === "number") {
          total += ms;
          measured++;
        }
      }

      // Every frame, not merely most of them: a frame that failed to evaluate
      // would otherwise make the total look good.
      expect(measured).toBe(EVAL_FRAMES + 1);
      expect(total).toBeLessThan(budget);
    },
  );

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
