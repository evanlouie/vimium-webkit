/**
 * Detection against a hostile page, in a real engine.
 *
 * Two properties live here, and both are properties of
 * `src/features/hints/Detect.ts`.
 *
 * 1. **An image-map name belongs to the page.** It can hold a quotation mark,
 *    a backslash, a bracket or an emoji. The lookup must find the map that the
 *    name says, and it must never build a selector from the name. One bad name
 *    used to end the whole hint pass, so the assertion is not only that the
 *    area takes a hint: an ordinary link on the same page must keep its own.
 * 2. **Discovery walks the whole document in slices.** The user must be able
 *    to end the round while the walk runs, and the round must leave nothing
 *    behind.
 */

import { expect, test } from "./harness/fixtures.ts";

/** Each area, with the fragment that its `href` names. */
const AWKWARD_AREAS: ReadonlyArray<readonly [string, string]> = [
  ["Quote area", "quote-target"],
  ["Backslash area", "backslash-target"],
  ["Escape area", "escape-target"],
  ["Space area", "space-target"],
  ["Bracket area", "bracket-target"],
  ["Colon area", "colon-target"],
  ["Emoji area", "emoji-target"],
  ["Newline area", "newline-target"],
  ["Dupe first area", "dupe-first-target"],
];

test.describe("image maps with awkward names", () => {
  for (const [label, fragment] of AWKWARD_AREAS) {
    test(`hints "${label}"`, async ({ vw, page }) => {
      await vw.open("/image-maps-awkward.html");
      await vw.startHints();

      await vw.activateHint(label);
      await expect(page).toHaveURL(new RegExp(`#${fragment}$`));
    });
  }

  test("an ordinary link on the same page keeps its hint", async ({ vw, page }) => {
    await vw.open("/image-maps-awkward.html");
    await vw.startHints();

    // The point of the test. A name that the lookup cannot use must cost this
    // page one hint, and not every hint.
    await vw.activateHint("Ordinary link");
    await expect(page).toHaveURL(/#ordinary-target$/);
  });

  test("hints one area for each map that a name finds", async ({ vw }) => {
    await vw.open("/image-maps-awkward.html");
    await vw.startHints();

    const labels = await vw.hintLabels();

    // Nine areas and one link. The image with the empty name gets no hint,
    // because an empty name names no map. The decoy map gets none either,
    // because no image on the page names it.
    expect(labels).toHaveLength(AWKWARD_AREAS.length + 1);
  });
});

test.describe("discovery on a very large document", () => {
  test("Escape during discovery ends the round and leaves nothing", async ({ vw, page }) => {
    await vw.open("/dom-huge.html");

    // Escape lands while the pass runs. Discovery gives the thread back
    // between two slices, so the key reaches the application there.
    await vw.press("f");
    await vw.press("Escape");

    // An absence needs a window, and time is the goal here: no marker may
    // appear in it.
    await page.waitForTimeout(2_000);
    expect(await vw.hintsVisible()).toBe(false);

    const before = (await vw.snapshot()).counters;
    await page.waitForTimeout(1_000);
    const after = (await vw.snapshot()).counters;

    // A cancelled round leaves no fiber and no listener that draws again.
    expect(after.raf - before.raf).toBe(0);
    expect(after.interval - before.interval).toBe(0);

    // The state is clean: the next round works.
    await vw.startHints();
    await vw.activateHint("Unmistakable beacon");
    await expect(page).toHaveURL(/#beacon-target$/);
  });

  test("a whole round on a large document still finds every link", async ({ vw, page }) => {
    await vw.open("/dom-huge.html");
    await vw.startHints();

    await vw.activateHint("Bulk link 7");
    await expect(page).toHaveURL(/#bulk-7$/);
  });
});
