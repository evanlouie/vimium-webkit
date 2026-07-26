/**
 * Find mode against `long-text.html`.
 *
 * The interesting property is that a match may span element boundaries: the
 * engine flattens visible text into runs and maps offsets back to `Range`s, so
 * `hemi</span><span>sphere` has to be found exactly like plain `hemisphere`.
 *
 * `n`/`N` are asserted through the document selection, which find deliberately
 * only touches on commit — that is what makes `Escape` a genuine no-op, and it
 * is also the only unambiguous signal that a commit has happened (the HUD shows
 * `1/4` both while typing and after `Enter`).
 */

import { expect, test, type Vimium } from "./harness/fixtures.ts";

const QUERY = "hemisphere";

const commitFind = async (vw: Vimium, query: string): Promise<void> => {
  await vw.press("/");
  await vw.type(query);
  await vw.press("Enter");
};

/** Wait until the committed match is in the document selection. */
const waitForRegion = async (vw: Vimium, region: string): Promise<void> => {
  await expect.poll(async () => (await vw.selection()).region).toBe(region);
};

/**
 * `FindPromptMode` owns the keyboard while the prompt is open.
 *
 * It has to: Stage 0 listens for `keydown` on `globalThis` in the **capture**
 * phase, so it sees every keystroke before the HUD input's own listener could
 * stop it. Without an explicit handler, typing `hemisphere` would run `h`, `m`,
 * `i` and `s` as commands. The mode passes keys through when
 * `hud.ownsFocus(event.target)` and swallows everything else — and `ownsFocus`
 * has to account for the overlay's *closed* shadow root retargeting the event
 * to the host.
 */
test.describe("find", () => {
  test("matches across element boundaries and counts them all", async ({ vw }) => {
    await vw.open("/long-text.html");
    await commitFind(vw, QUERY);

    // Four occurrences: split across two spans, a plain text node, split by
    // `<b>`, and one with a capital (smartcase: a lower-case query is
    // case-insensitive).
    await waitForRegion(vw, "1");
    expect(await vw.hud()).toBe("1/4");

    const selection = await vw.selection();
    expect(selection.text.toLowerCase()).toBe(QUERY);
  });

  test("`n` steps forward and `N` steps back", async ({ vw }) => {
    await vw.open("/long-text.html");
    await commitFind(vw, QUERY);
    await waitForRegion(vw, "1");

    await vw.press("n");
    await waitForRegion(vw, "2");
    expect(await vw.hud()).toBe("2/4");

    await vw.press("n");
    await waitForRegion(vw, "3");

    await vw.press("N");
    await waitForRegion(vw, "2");
    expect(await vw.hud()).toBe("2/4");
  });

  test("`n` wraps around the end of the document", async ({ vw }) => {
    await vw.open("/long-text.html");
    await commitFind(vw, QUERY);
    await waitForRegion(vw, "1");

    await vw.press("n", "n", "n");
    await waitForRegion(vw, "4");

    await vw.press("n");
    await waitForRegion(vw, "1");
  });

  test("reports a query with no matches", async ({ vw }) => {
    await vw.open("/long-text.html");
    await commitFind(vw, "stratosphere");

    await vw.waitForHud("No matches");
  });
});

test.describe("find", () => {
  test("`n` without a previous search says so", async ({ vw }) => {
    await vw.open("/long-text.html");

    await vw.press("n");
    await vw.waitForHud("No previous search");
  });

  test("Escape leaves the scroll position and the selection alone", async ({ vw }) => {
    await vw.open("/long-text.html");
    const before = await vw.scrollOffsets();

    await vw.press("/");
    await vw.type(QUERY);
    await vw.press("Escape");

    // NOTE: while the defect above is unfixed this passes vacuously — the
    // incremental search never runs, so there is nothing to restore. It is kept
    // because it is the assertion that matters once the prompt owns the
    // keyboard: cancelling must undo the scrolling that typing caused.
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(before.y);
    expect((await vw.selection()).text).toBe("");
  });
});
