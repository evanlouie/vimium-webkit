/**
 * The load-bearing spec: does the UI survive a strict Content Security Policy?
 *
 * `IMPLEMENTATION_PLAN.md` §6.3 stakes the entire UI layer on one claim — that
 * a constructed `CSSStyleSheet` adopted into a shadow root is not a
 * `style-src` fetch, and therefore is not policed. Verification item **V1**.
 * If that claim is wrong, the overlay is unstyled on GitHub, Google, and every
 * bank, and the architecture needs rethinking rather than patching.
 *
 * `strict-csp.html` is served with `default-src 'self'; style-src 'self'` as a
 * real response header and contains nothing inline, so any violation reported
 * while it is loaded came from the extension.
 *
 * This is the one spec that legitimately reaches inside the closed shadow root:
 * "the stylesheet applied" has no observable proxy outside it.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "./harness/fixtures.ts";
import { overlayBox, overlayComputedStyle } from "./harness/overlay.ts";

/** Pinned so the palette is the light one and the colour assertion is exact. */
test.use({ colorScheme: "light" });

const openHelp = async (page: Page): Promise<void> => {
  await page.keyboard.press("?");
  await page.waitForFunction(
    () => {
      const host = globalThis as unknown as {
        __vimiumHarness?: { shadow: ShadowRoot | null };
      };
      const shadow = host.__vimiumHarness?.shadow ?? null;
      return shadow !== null && shadow.querySelector(".vw-dialog") !== null;
    },
    undefined,
    { timeout: 10_000 },
  );
};

test.describe("strict CSP", () => {
  test("the help dialog renders and is styled", async ({ vw, page }) => {
    await vw.open("/strict-csp.html");
    await openHelp(page);

    const box = await overlayBox(page, ".vw-dialog");
    expect(box).not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThan(300);
    expect(box?.height ?? 0).toBeGreaterThan(100);

    // `background: var(--vw-bg-raised)` resolves only if *both* the `:host`
    // custom properties and the `.vw-dialog` rule made it through. An
    // unstyled div would be transparent, and an undefined custom property
    // would make the shorthand invalid — so an exact colour is the strongest
    // single signal that the adopted stylesheet is live.
    expect(await overlayComputedStyle(page, ".vw-dialog", "background-color"))
      .toBe("rgb(255, 255, 255)");
    expect(await overlayComputedStyle(page, ".vw-dialog", "border-radius"))
      .toBe("10px");

    // The layer itself is `position: fixed` from the same stylesheet; without
    // it the dialog would be laid out in the flow of an inline custom element.
    expect(
      await overlayComputedStyle(
        page,
        '.vw-layer[data-layer="dialog"]',
        "position",
      ),
    ).toBe("fixed");
  });

  test("no CSP violation is reported", async ({ vw, page }) => {
    // The overlay host is styled through `host.style.setProperty()`, never a
    // `style` attribute: a `style` attribute is governed by `style-src-attr`
    // (falling back to `style-src`), so under `style-src 'self'` the whole
    // declaration block is discarded and a violation is reported. CSP does not
    // police CSSOM, which is what keeps `all: initial`, the stacking context,
    // and the visual-viewport transform alive on strict-CSP sites.

    await vw.open("/strict-csp.html");
    await openHelp(page);
    // Hints install a second stylesheet lazily, on the first session.
    await page.keyboard.press("Escape");
    await vw.startHints();
    await page.keyboard.press("Escape");

    const snapshot = await vw.snapshot();
    const reported = snapshot.violations.map((violation) =>
      `${violation.directive} blocked=${violation.blockedUri} sample=${violation.sample}`
    );
    expect(reported).toEqual([]);
  });

  test("hint markers are styled under the policy", async ({ vw, page }) => {
    await vw.open("/strict-csp.html");
    await vw.startHints();

    // `background-image` on `.vw-hint` is a gradient that exists nowhere else;
    // if `hintCss` had been blocked the markers would be transparent.
    const background = await overlayComputedStyle(
      page,
      ".vw-hint:not(.vw-hint--hidden)",
      "background-image",
    );
    expect(background).toContain("linear-gradient");
  });

  test("hints still activate under the policy", async ({ vw, page }) => {
    await vw.open("/strict-csp.html");
    await vw.startHints();

    await vw.activateHint("Strict CSP link");
    await expect(page).toHaveURL(/#csp-target$/);
  });
});

test.describe("strict CSP on the capability floor", () => {
  // quoid's Userscripts exposes only the promise-flavoured `GM.*`, so Stage 1
  // hydrates settings across an async hop before the UI exists (V12).
  test.use({ gmVariant: "async", scriptHandler: "Harness/Userscripts" });

  test("boots and styles the dialog with promise-only storage", async ({ vw, page }) => {
    await vw.open("/strict-csp.html");
    await openHelp(page);

    expect(await overlayComputedStyle(page, ".vw-dialog", "background-color"))
      .toBe("rgb(255, 255, 255)");
    // Violations are asserted in the sibling case above; the point here is
    // that the async storage hop does not change the styling outcome.
  });
});
