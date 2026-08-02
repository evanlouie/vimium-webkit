/**
 * What a screen reader can reach.
 *
 * The overlay lives in a closed shadow root, and the host used to carry
 * `aria-hidden="true"` for the whole session. Nothing removed it, so a dialog,
 * a prompt, the omnibar and every error message were invisible to assistive
 * technology while they held the keyboard.
 *
 * The rule now: a decoration stays hidden, and a control does not. A hint
 * marker labels a link that the page already offers, so a reader must not read
 * it twice; a dialog is a control, and a reader must reach it.
 *
 * The assertions read the ARIA attributes through the harness accessor,
 * because `page.accessibility` is Chromium-only and cannot enter a closed
 * shadow root.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "./harness/fixtures.ts";
import {
  overlayAriaHidden,
  overlayAttribute,
  overlayCount,
  overlayText,
} from "./harness/overlay.ts";

/** The settings that had no control at all before this change. */
const ADDED_CONTROLS: readonly string[] = [
  "linkHintNumbers",
  "userDefinedLinkHintCss",
  "previousPatterns",
  "nextPatterns",
  "searchUrl",
  "newTabUrl",
  "historyIndexDenylist",
  "historyIndexLimit",
];

/** Wait until a node matching `selector` exists inside the overlay. */
const waitForOverlay = async (
  page: Page,
  selector: string,
): Promise<void> => {
  await page.waitForFunction(
    (query: string) => {
      const host = globalThis as unknown as {
        __vimiumHarness?: { shadow: ShadowRoot | null };
      };
      const shadow = host.__vimiumHarness?.shadow ?? null;
      return shadow !== null && shadow.querySelector(query) !== null;
    },
    selector,
    { timeout: 10_000 },
  );
};

/** Click a button of the overlay by its text. A locator cannot reach it. */
const clickOverlayButton = (page: Page, label: string): Promise<boolean> =>
  page.evaluate((needle: string): boolean => {
    const host = globalThis as unknown as {
      __vimiumHarness?: { shadow: ShadowRoot | null };
    };
    const shadow = host.__vimiumHarness?.shadow ?? null;
    if (shadow === null) return false;
    for (const button of shadow.querySelectorAll("button")) {
      if ((button.textContent ?? "").trim().startsWith(needle)) {
        button.click();
        return true;
      }
    }
    return false;
  }, label);

test.describe("the accessibility tree", () => {
  test("the HUD line is a live region", async ({ vw, page }) => {
    await vw.open("/long-text.html");
    await vw.press("n");
    await vw.waitForHud("No previous search");

    expect(await overlayAttribute(page, '.vw-hud [role="status"]', "aria-live"))
      .not.toBeNull();
    expect(
      await overlayAttribute(page, '.vw-hud [role="status"]', "aria-atomic"),
    ).toBe("true");
    // A live region under a hidden host is never announced.
    expect(await overlayAriaHidden(page, '.vw-hud [role="status"]')).toBe(
      false,
    );
  });

  test("the find prompt has a name and a live status", async ({ vw, page }) => {
    await vw.open("/long-text.html");
    await vw.press("/");
    await waitForOverlay(page, ".vw-hud-input");

    // "/" is the visible label, and no reader can say it. The field carries
    // the same name in words.
    expect(await overlayAttribute(page, ".vw-hud-input", "aria-label"))
      .toBe("Find on the page");
    expect(await overlayAriaHidden(page, ".vw-hud-input")).toBe(false);

    const describedBy = await overlayAttribute(
      page,
      ".vw-hud-input",
      "aria-describedby",
    );
    expect(describedBy).not.toBeNull();
    expect(await overlayAttribute(page, ".vw-hud-count", "id"))
      .toBe(describedBy);
    expect(await overlayAttribute(page, ".vw-hud-count", "aria-live"))
      .toBe("polite");

    await vw.type("hemisphere");
    // The status beside the field carries the mode, and the count after the
    // search is committed. The exact text belongs to `find.spec.ts`; what
    // matters here is that the live region holds it while the field has the
    // focus.
    await expect.poll(() => overlayText(page, ".vw-hud-count")).not.toBe("");
  });

  test("the help dialog is a modal that a reader reaches", async ({ vw, page }) => {
    await vw.open("/long-text.html");
    await vw.press("?");
    await waitForOverlay(page, ".vw-dialog");

    expect(await overlayAttribute(page, ".vw-dialog", "role")).toBe("dialog");
    expect(await overlayAttribute(page, ".vw-dialog", "aria-modal"))
      .toBe("true");
    expect(await overlayAttribute(page, ".vw-dialog", "aria-label"))
      .toContain("help");
    expect(await overlayAriaHidden(page, ".vw-dialog")).toBe(false);
  });

  test("the dialog leaves the tree again when it closes", async ({ vw, page }) => {
    await vw.open("/long-text.html");
    await vw.press("?");
    await waitForOverlay(page, ".vw-dialog");
    await vw.press("Escape");
    await expect.poll(() => overlayCount(page, ".vw-dialog")).toBe(0);

    expect(
      await overlayAttribute(
        page,
        '.vw-layer[data-layer="dialog"]',
        "aria-hidden",
      ),
    ).toBe("true");
  });

  test("every settings control has a label of its own", async ({ vw, page }) => {
    await vw.open("/long-text.html");
    await vw.press("?");
    await waitForOverlay(page, ".vw-dialog");
    expect(await clickOverlayButton(page, "Settings")).toBe(true);
    await waitForOverlay(page, "#vw-set-keyMappings");

    const orphans = await page.evaluate((): readonly string[] => {
      const host = globalThis as unknown as {
        __vimiumHarness?: { shadow: ShadowRoot | null };
      };
      const shadow = host.__vimiumHarness?.shadow ?? null;
      if (shadow === null) return ["no shadow root"];
      const out: string[] = [];
      for (const label of shadow.querySelectorAll("label")) {
        const target = label.getAttribute("for");
        if (target === null) {
          out.push(`a label with no target: ${label.textContent ?? ""}`);
          continue;
        }
        if (shadow.getElementById(target) === null) {
          out.push(`the label points at the absent ${target}`);
        }
      }
      return out;
    });
    expect(orphans).toEqual([]);
  });

  test("the settings dialog holds the settings that it had lost", async ({ vw, page }) => {
    await vw.open("/long-text.html");
    await vw.press("?");
    await waitForOverlay(page, ".vw-dialog");
    expect(await clickOverlayButton(page, "Settings")).toBe(true);
    await waitForOverlay(page, "#vw-set-keyMappings");

    for (const key of ADDED_CONTROLS) {
      // oxlint-disable-next-line no-await-in-loop
      const found = await overlayCount(page, `#vw-set-${key}`);
      expect(found, `#vw-set-${key} is absent`).toBe(1);
    }
  });

  test("a hint marker stays out of the tree", async ({ vw, page }) => {
    await vw.open("/link-dense.html");
    await vw.startHints();

    // The marker decorates a link that the page already offers. A reader that
    // read both would read every link twice.
    expect(await overlayAriaHidden(page, ".vw-hint")).toBe(true);
  });

  test("the omnibar has a name and a reachable field", async ({ vw, page }) => {
    await vw.open("/long-text.html");
    await vw.press("o");
    await waitForOverlay(page, ".vw-omnibar__input");

    expect(await overlayAttribute(page, ".vw-omnibar__input", "aria-label"))
      .not.toBeNull();
    expect(await overlayAriaHidden(page, ".vw-omnibar__input")).toBe(false);
  });
});
