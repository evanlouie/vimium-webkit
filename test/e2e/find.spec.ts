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
 * It has to: The guard listens for `keydown` on `globalThis` in the **capture**
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

// ---------------------------------------------------------------------------
// Composed order, and the boundary that the reader sees
// ---------------------------------------------------------------------------

/**
 * Does the current highlight sit on `selector`?
 *
 * Both boxes are read in one call, so a scroll between two calls cannot make
 * the answer wrong. The test is a containment test: the highlight covers one
 * word, and the element holds the whole line.
 */
const highlightSits = (
  vw: Vimium,
  selector: string,
  shadowHost: string | null = null,
): Promise<boolean | null> =>
  vw.page.evaluate(
    ([query, host]: readonly [string, string | null]): boolean | null => {
      const harness = globalThis as unknown as {
        __vimiumHarness?: { shadow: ShadowRoot | null };
      };
      const shadow = harness.__vimiumHarness?.shadow ?? null;
      const drawn = shadow?.querySelector(".vw-find__rect--current") ?? null;
      const root: Document | ShadowRoot | null = host === null
        ? document
        : document.querySelector(host)?.shadowRoot ?? null;
      const target = root?.querySelector(query) ?? null;
      if (drawn === null || target === null) return null;
      const box = drawn.getBoundingClientRect();
      const wanted = target.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      return x >= wanted.left - 2 && x <= wanted.right + 2 &&
        y >= wanted.top - 2 && y <= wanted.bottom + 2;
    },
    [selector, shadowHost] as const,
  );

/**
 * Does the current highlight lie exactly on `word` inside `selector`?
 *
 * The rectangle of the word itself is measured, and not the box of the line,
 * so an error of a few pixels in either direction is a failure. Both boxes are
 * read in one call.
 */
const highlightOnWord = (
  vw: Vimium,
  selector: string,
  word: string,
): Promise<boolean | null> =>
  vw.page.evaluate(
    ([query, needle]: readonly [string, string]): boolean | null => {
      const harness = globalThis as unknown as {
        __vimiumHarness?: { shadow: ShadowRoot | null };
      };
      const shadow = harness.__vimiumHarness?.shadow ?? null;
      const drawn = shadow?.querySelector(".vw-find__rect--current") ?? null;
      const line = document.querySelector(query);
      const text = line?.firstChild ?? null;
      if (drawn === null || !(text instanceof Text)) return null;
      const at = text.data.indexOf(needle);
      if (at < 0) return null;
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + needle.length);
      const wanted = range.getBoundingClientRect();
      const box = drawn.getBoundingClientRect();
      return Math.abs(box.left - wanted.left) <= 2 &&
        Math.abs(box.top - wanted.top) <= 2;
    },
    [selector, word] as const,
  );

/** The top of one page element, in viewport coordinates. */
const topOf = (vw: Vimium, selector: string): Promise<number | null> =>
  vw.page.evaluate((query: string): number | null => {
    const element = document.querySelector(query);
    return element === null ? null : element.getBoundingClientRect().top;
  }, selector);

/** The left edge of one page element, in viewport coordinates. */
const leftOf = (vw: Vimium, selector: string): Promise<number | null> =>
  vw.page.evaluate((query: string): number | null => {
    const element = document.querySelector(query);
    return element === null ? null : element.getBoundingClientRect().left;
  }, selector);

test.describe("find in composed order", () => {
  test("visits the matches in the order that the reader sees", async ({ vw }) => {
    await vw.open("/find-composed.html");
    await commitFind(vw, "widget");

    // alpha is light DOM, beta is the shadow tree of the card, delta is the
    // light child that the slot of the card draws, and gamma is light DOM
    // again. Tree order would give alpha, delta, gamma, beta.
    await vw.waitForHud("1/4");
    await expect.poll(() => highlightSits(vw, "#alpha")).toBe(true);

    await vw.press("n");
    await vw.waitForHud("2/4");
    await expect.poll(() => highlightSits(vw, "#head", "#card")).toBe(true);

    await vw.press("n");
    await vw.waitForHud("3/4");
    await expect.poll(() => highlightSits(vw, "#delta")).toBe(true);

    await vw.press("n");
    await vw.waitForHud("4/4");
    await expect.poll(() => highlightSits(vw, "#gamma")).toBe(true);
  });

  test("does not match across two blocks that the reader sees apart", async ({ vw }) => {
    await vw.open("/find-composed.html");
    // `<p>north</p><p>west</p>`, with nothing between the two blocks. The
    // reader sees two lines, so `northwest` is not a word on this page.
    await commitFind(vw, "northwest");

    await vw.waitForHud("No matches");
  });

  test("still matches across inline markup on one line", async ({ vw }) => {
    await vw.open("/long-text.html");
    await commitFind(vw, QUERY);

    await vw.waitForHud("1/4");
  });
});

// ---------------------------------------------------------------------------
// A container that scrolls on its own
// ---------------------------------------------------------------------------

test.describe("find inside a nested scroll container", () => {
  test("Escape puts the panel back where the user left it", async ({ vw }) => {
    await vw.open("/find-nested-scroll.html");
    const before = await vw.scrollOffsets("#panel");
    expect(before.y).toBe(0);

    await vw.press("/");
    await vw.type(QUERY);
    // The match is far down inside the panel, so the incremental search has to
    // scroll the panel to show it. Without this the test would prove nothing.
    await expect.poll(async () => (await vw.scrollOffsets("#panel")).y)
      .toBeGreaterThan(0);

    await vw.press("Escape");

    await expect.poll(async () => (await vw.scrollOffsets("#panel")).y)
      .toBe(before.y);
    await expect.poll(async () => (await vw.scrollOffsets()).y).toBe(0);
  });

  test("the highlight follows the text when the panel scrolls", async ({ vw }) => {
    await vw.open("/find-nested-scroll.html");
    await commitFind(vw, QUERY);
    await expect.poll(() => highlightOnWord(vw, "#needle", QUERY)).toBe(true);

    const before = await topOf(vw, "#needle");
    await vw.page.evaluate(() => {
      const panel = document.getElementById("panel");
      if (panel !== null) panel.scrollTop = panel.scrollTop + 60;
    });
    // The text moved. A highlight that only follows the window scroll is now
    // 60 pixels away from its match.
    await expect.poll(() => topOf(vw, "#needle")).not.toBe(before);

    await expect.poll(() => highlightOnWord(vw, "#needle", QUERY)).toBe(true);
  });

  test("the highlight follows the text after a reflow", async ({ vw }) => {
    await vw.open("/find-nested-scroll.html");
    await commitFind(vw, QUERY);
    await expect.poll(() => highlightOnWord(vw, "#needle", QUERY)).toBe(true);

    const before = await topOf(vw, "#needle");
    // A block that arrives above the panel. Nothing scrolls, and the window is
    // not resized, so only a measurement can find the new place of the match.
    await vw.page.evaluate(() => {
      const banner = document.createElement("div");
      banner.style.height = "120px";
      document.body.insertBefore(banner, document.body.firstChild);
    });
    await expect.poll(() => topOf(vw, "#needle")).not.toBe(before);

    await expect.poll(() => highlightOnWord(vw, "#needle", QUERY)).toBe(true);
  });

  test("the highlight follows the text after a resize", async ({ vw }) => {
    await vw.open("/find-nested-scroll.html");
    await commitFind(vw, QUERY);
    await expect.poll(() => highlightOnWord(vw, "#needle", QUERY)).toBe(true);

    // The panel has a margin in percent, so a narrower window moves it.
    const before = await leftOf(vw, "#needle");
    await vw.page.setViewportSize({ width: 900, height: 700 });
    await expect.poll(() => leftOf(vw, "#needle")).not.toBe(before);

    await expect.poll(() => highlightOnWord(vw, "#needle", QUERY)).toBe(true);
  });
});
