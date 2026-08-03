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
  overlayActiveBox,
  overlayActiveElement,
  overlayAriaHidden,
  overlayAttribute,
  overlayCount,
  overlayFocusWithin,
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

  test("an error goes to the assertive region, and stays out of the polite one", async ({ vw, page }) => {
    await vw.open("/long-text.html");

    // Both regions are built with the HUD, and neither changes its politeness
    // again. A reader keeps the politeness that a region had when it entered
    // the tree, so a region that became assertive with its text could speak an
    // error politely, or not at all.
    expect(await overlayAttribute(page, '.vw-hud [role="status"]', "aria-live"))
      .toBe("polite");
    expect(await overlayAttribute(page, '.vw-hud [role="alert"]', "aria-live"))
      .toBe("assertive");

    // A mark that nobody set is a failure, and a failure reaches the user
    // through `Report`, which draws it with the error tone.
    await vw.press("`");
    await vw.press("z");
    await vw.waitForHud("is not set");

    expect(await overlayText(page, '.vw-hud [role="alert"]')).toContain(
      "is not set",
    );
    expect(await overlayText(page, '.vw-hud [role="status"]')).toBe("");
    // The politeness must be the same as before the error.
    expect(await overlayAttribute(page, '.vw-hud [role="status"]', "aria-live"))
      .toBe("polite");
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

  test("removes the dialog before it hides the layer", async ({ vw, page }) => {
    await vw.open("/long-text.html");
    await vw.press("?");
    await waitForOverlay(page, ".vw-dialog");

    // A layer that carries `aria-hidden="true"` while it still holds the
    // focused element is the state that browsers warn about, because a screen
    // reader loses the focused node. A scope releases in the reverse order of
    // its acquisitions, so the layer is opened before the dialog is built.
    await page.evaluate((): boolean => {
      const host = globalThis as unknown as {
        __vimiumHarness?: { shadow: ShadowRoot | null };
        __vwCloseLog?: string[];
      };
      const shadow = host.__vimiumHarness?.shadow ?? null;
      const layer = shadow?.querySelector('.vw-layer[data-layer="dialog"]') ??
        null;
      if (layer === null) return false;
      const log: string[] = [];
      host.__vwCloseLog = log;
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "childList" && record.removedNodes.length > 0) {
            log.push("the dialog left the layer");
            continue;
          }
          if (record.type === "attributes") {
            log.push(`aria-hidden=${layer.getAttribute("aria-hidden")}`);
          }
        }
      }).observe(layer, {
        attributes: true,
        attributeFilter: ["aria-hidden"],
        childList: true,
      });
      return true;
    });

    await vw.press("Escape");
    await expect.poll(() => overlayCount(page, ".vw-dialog")).toBe(0);

    const log = await page.evaluate((): readonly string[] => {
      const host = globalThis as unknown as { __vwCloseLog?: string[] };
      return host.__vwCloseLog ?? [];
    });
    expect(log).toContain("aria-hidden=true");
    expect(log[0]).toBe("the dialog left the layer");
  });

  test("the help dialog keeps the focus inside itself", async ({ vw, page }) => {
    await vw.open("/long-text.html");
    await vw.press("?");
    await waitForOverlay(page, ".vw-dialog");

    // `aria-modal="true"` says that the rest of the page is unavailable. The
    // keyboard must agree with that claim. Without the trap the first Tab put
    // the focus on `document.body`, and every Tab after it stayed there.
    for (let press = 0; press < 6; press++) {
      // oxlint-disable-next-line no-await-in-loop
      await vw.press("Tab");
      // oxlint-disable-next-line no-await-in-loop
      const inside = await overlayFocusWithin(page, ".vw-dialog");
      // oxlint-disable-next-line no-await-in-loop
      const active = await overlayActiveElement(page);
      expect(inside, `press ${press + 1} left the dialog for ${active}`)
        .toBe(true);
    }

    // Shift and Tab must stay inside as well.
    await page.keyboard.press("Shift+Tab");
    expect(await overlayFocusWithin(page, ".vw-dialog")).toBe(true);
  });

  test("the settings dialog keeps the focus inside itself", async ({ vw, page }) => {
    await vw.open("/long-text.html");
    await vw.press("?");
    await waitForOverlay(page, ".vw-dialog");
    expect(await clickOverlayButton(page, "Settings")).toBe(true);
    await waitForOverlay(page, "#vw-set-keyMappings");

    // Backwards from the dialog box, which is the far end of a long form.
    // Forwards from there the trap must wrap to the first control.
    await page.keyboard.press("Shift+Tab");
    expect(await overlayFocusWithin(page, ".vw-dialog")).toBe(true);
    expect(await overlayActiveElement(page)).toBe("button.vw-button");

    await vw.press("Tab");
    expect(await overlayFocusWithin(page, ".vw-dialog")).toBe(true);

    for (let press = 0; press < 6; press++) {
      // oxlint-disable-next-line no-await-in-loop
      await vw.press("Tab");
      // oxlint-disable-next-line no-await-in-loop
      expect(await overlayFocusWithin(page, ".vw-dialog")).toBe(true);
    }
  });

  test("the settings dialog scrolls the focused control into view", async ({ vw, page }) => {
    await vw.open("/long-text.html");
    await vw.press("?");
    await waitForOverlay(page, ".vw-dialog");
    expect(await clickOverlayButton(page, "Settings")).toBe(true);
    await waitForOverlay(page, "#vw-set-keyMappings");

    // The dialog box scrolls, and the settings form is longer than it. With
    // `focus({ preventScroll: true })` the ninth press put the focus on a
    // control at 833 px, the box ended at 794 px, and nothing moved. A sighted
    // keyboard user pressed Tab, saw no change and could not find the focus.
    const height = page.viewportSize()?.height ?? 800;
    for (let press = 0; press < 12; press++) {
      // oxlint-disable-next-line no-await-in-loop
      await vw.press("Tab");
      // oxlint-disable-next-line no-await-in-loop
      const box = await overlayActiveBox(page);
      // oxlint-disable-next-line no-await-in-loop
      const name = await overlayActiveElement(page);
      expect(box, `press ${press + 1} focused nothing`).not.toBeNull();
      expect(box?.top ?? -1, `press ${press + 1} put ${name} above the view`)
        .toBeGreaterThanOrEqual(-1);
      expect(
        (box?.top ?? 0) + (box?.height ?? 0),
        `press ${press + 1} put ${name} below the view`,
      ).toBeLessThanOrEqual(height + 1);
    }
  });

  test("the dialog gives the focus back when it closes", async ({ vw, page }) => {
    await vw.open("/long-text.html");
    await page.evaluate(() => {
      const beacon = document.createElement("a");
      beacon.id = "beacon";
      beacon.href = "#beacon";
      beacon.textContent = "beacon";
      document.body.appendChild(beacon);
      beacon.focus();
    });
    expect(await vw.focusedId()).toBe("beacon");

    await vw.press("?");
    await waitForOverlay(page, ".vw-dialog");
    await vw.press("Escape");
    await expect.poll(() => overlayCount(page, ".vw-dialog")).toBe(0);

    // A modal that drops the focus leaves the user at the top of the document.
    await expect.poll(() => vw.focusedId()).toBe("beacon");
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

  test("the settings dialog says which field it refused", async ({ vw, page }) => {
    await vw.open("/long-text.html");
    await vw.press("?");
    await waitForOverlay(page, ".vw-dialog");
    expect(await clickOverlayButton(page, "Settings")).toBe(true);
    await waitForOverlay(page, "#vw-set-keyMappings");

    // One digit is not a hint alphabet, so the write function keeps the
    // stored value. The user typed, pressed Save, saw the old value again and
    // got no reason for it. The message area is a `role="alert"` region, so a
    // reader speaks the reason as well.
    await page.evaluate((): boolean => {
      const host = globalThis as unknown as {
        __vimiumHarness?: { shadow: ShadowRoot | null };
      };
      const shadow = host.__vimiumHarness?.shadow ?? null;
      const input = shadow?.getElementById("vw-set-linkHintNumbers") ?? null;
      if (!(input instanceof HTMLInputElement)) return false;
      input.value = "1";
      return true;
    });
    expect(await clickOverlayButton(page, "Save")).toBe(true);

    await expect.poll(() => overlayText(page, ".vw-problem"))
      .toContain("Digits that choose among filtered hints");
    expect(await overlayAttribute(page, ".vw-problem", "role")).toBe("alert");
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

    // A name of its own, and not the placeholder: the placeholder changes with
    // the source, and a reader that announces it would say it twice.
    const name = await overlayAttribute(
      page,
      ".vw-omnibar__input",
      "aria-label",
    );
    const placeholder = await overlayAttribute(
      page,
      ".vw-omnibar__input",
      "placeholder",
    );
    expect(name ?? "").not.toBe("");
    expect(name).not.toBe(placeholder);
    expect(await overlayAriaHidden(page, ".vw-omnibar__input")).toBe(false);
  });
});
