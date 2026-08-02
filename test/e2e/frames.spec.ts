/**
 * Cross-frame hints.
 *
 * Hint strings are assigned from a single globally-ordered list, so a hint owned
 * by the innermost frame is typed in the outermost one and activated by the
 * frame that owns the element — the element reference itself never crosses a
 * frame boundary.
 *
 * `srcdoc-frames.html` is here for the opposite reason. Whether a manager
 * injects into `srcdoc`/`about:blank` at all is verification item **V3** and
 * differs per manager, so the contract is the weaker and more important one:
 * whatever the answer, the top frame must not hang and must not throw.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "./harness/fixtures.ts";

/** Collect uncaught page errors for the duration of a test. */
const trackErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

test.describe("nested same-origin frames", () => {
  test("activates a hint owned by the innermost frame", async ({ vw, page }) => {
    await vw.open("/nested-frames.html");
    await vw.bootAllFrames();

    await vw.startHints();
    await vw.activateHint("Level two link");

    await expect.poll(() => {
      const frame = page.frames().find((candidate) =>
        candidate.url().includes("level2.html")
      );
      return frame?.url() ?? "";
    }).toContain("#level2-target");
  });

  test("activates a hint owned by the middle frame", async ({ vw, page }) => {
    await vw.open("/nested-frames.html");
    await vw.bootAllFrames();

    await vw.startHints();
    await vw.activateHint("Level one link");

    await expect.poll(() => {
      const frame = page.frames().find((candidate) =>
        candidate.url().includes("level1.html")
      );
      return frame?.url() ?? "";
    }).toContain("#level1-target");
  });

  test("the top frame's own hints still work", async ({ vw, page }) => {
    await vw.open("/nested-frames.html");
    await vw.bootAllFrames();

    await vw.startHints();
    await vw.activateHint("Top frame link");

    await expect(page).toHaveURL(/#top-target$/);
  });
});

test.describe("cross-origin frames", () => {
  test("hints reach a frame on another origin", async ({ vw, page }) => {
    const errors = trackErrors(page);
    await vw.open("/cross-origin-frames.html");
    await vw.bootAllFrames();

    await vw.startHints();
    await vw.activateHint("Remote frame link");

    await expect.poll(() => {
      const frame = page.frames().find((candidate) =>
        candidate.url().includes("remote.html")
      );
      return frame?.url() ?? "";
    }).toContain("#remote-target");

    expect(errors).toEqual([]);
  });

  test("a cross-origin frame does not stall the top frame", async ({ vw, page }) => {
    await vw.open("/cross-origin-frames.html");
    // Deliberately *not* booting the subframe: an unresponsive frame must not
    // deadlock the round, only time out. `COLLECT_DEADLINE_MS` is 3 s.
    await vw.startHints();
    await vw.activateHint("Cross origin top link");

    await expect(page).toHaveURL(/#top-target$/);
  });
});

test.describe("srcdoc and about:blank frames", () => {
  test("degrades gracefully without hanging or throwing", async ({ vw, page }) => {
    const errors = trackErrors(page);
    await vw.open("/srcdoc-frames.html");
    await vw.bootAllFrames();

    // The assertion is that this completes at all: `startHints` fails the test
    // if no marker is ever drawn, and `activateHint` fails it if the session
    // never resolves.
    await vw.startHints();
    await vw.activateHint("Srcdoc host link");

    await expect(page).toHaveURL(/#top-target$/);
    expect(errors).toEqual([]);
  });

  test("dismissing a session with srcdoc frames present leaves no state", async ({ vw, page }) => {
    const errors = trackErrors(page);
    await vw.open("/srcdoc-frames.html");
    await vw.bootAllFrames();

    await vw.startHints();
    await vw.press("Escape");
    await vw.waitForHintsGone();

    // A second round after an aborted one is where a leaked pending request or
    // an un-cleared singleton mode would show up.
    await vw.startHints();
    await vw.press("Escape");
    await vw.waitForHintsGone();

    expect(errors).toEqual([]);
    expect(page.url()).not.toContain("#");
  });
});
