/**
 * Tab operations (IMPLEMENTATION_PLAN.md §7.5).
 *
 * There is no `chrome.tabs` for a userscript. Everything here is either an
 * approximation via `GM_openInTab` or an explicit, user-visible refusal — never
 * a silent no-op (goal G3).
 */

import { err, ok, type Result, ResultAsync } from "neverthrow";
import { type GmSurface, liftResult, openInTab } from "./gm.ts";

export type TabErrorKind = "unavailable" | "blocked" | "failed" | "unsafe-url";

export interface TabError {
  readonly kind: TabErrorKind;
  readonly message: string;
  /** Shown in the HUD when the failure is a permanent capability gap. */
  readonly nativeAlternative?: string;
}

const tabError = (
  kind: TabErrorKind,
  message: string,
  nativeAlternative?: string,
): TabError => ({ kind, message, nativeAlternative });

/**
 * Schemes we are willing to navigate to.
 *
 * `javascript:` and `data:` are excluded because hint targets and clipboard
 * contents are attacker-influenced, and `GM_openInTab` will happily execute
 * either. `view-source:` is allowed because `gs` needs it; managers may still
 * refuse, which surfaces as a normal failure.
 */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "ftp:",
  "file:",
  "about:",
  "view-source:",
  "chrome:",
  "safari-web-extension:",
]);

export const isNavigableUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url, document.baseURI);
    return ALLOWED_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
};

export interface OpenTabOptions {
  /** `false` requests a background tab; honoured by VM/TM, ignored by quoid. */
  readonly active?: boolean;
  /** Place the new tab immediately after this one. */
  readonly insert?: boolean;
}

export interface OpenTabOutcome {
  readonly url: string;
  /** `false` means we fell back to `window.open` and lost background placement. */
  readonly viaManager: boolean;
  readonly close: (() => void) | null;
}

/**
 * Open `url` in a new tab.
 *
 * Always prefer this over `window.open`: on WebKit `window.open` needs *fresh,
 * synchronous* transient activation and cannot background a tab at all, so a
 * `t`-style command routed through it either steals focus or is swallowed by
 * the popup blocker.
 */
export const openTab = (
  surface: GmSurface,
  url: string,
  options: OpenTabOptions = {},
): ResultAsync<OpenTabOutcome, TabError> => {
  if (!isNavigableUrl(url)) {
    return liftResult(
      err(tabError("unsafe-url", `refusing to open ${url.slice(0, 60)}`)),
    );
  }

  const absolute = new URL(url, document.baseURI).href;
  const active = options.active ?? true;

  return openInTab(surface, absolute, {
    active,
    insert: options.insert ?? true,
    setParent: true,
    // Tampermonkey's legacy spelling; harmlessly ignored elsewhere.
    loadInBackground: !active,
  })
    .mapErr((cause) =>
      tabError(
        cause.kind === "unavailable" ? "unavailable" : "blocked",
        cause.message,
      )
    )
    .map((result) => ({
      url: absolute,
      viaManager: result.viaManager,
      close: result.handle?.close ? () => result.handle?.close?.() : null,
    }));
};

/**
 * Close the current tab.
 *
 * Requires `@grant window.close`, which Violentmonkey and Tampermonkey honour
 * and quoid/Stay do not. When unavailable the caller must show the HUD message
 * carried on the error rather than doing nothing.
 */
export const closeCurrentTab = (surface: GmSurface): Result<void, TabError> => {
  const close = surface.windowClose;
  if (!close) {
    return err(
      tabError(
        "unavailable",
        "closing tabs needs Tampermonkey or Violentmonkey",
        "⌘W",
      ),
    );
  }
  try {
    close();
    return ok(undefined);
  } catch (cause) {
    return err(
      tabError(
        "failed",
        cause instanceof Error ? cause.message : String(cause),
        "⌘W",
      ),
    );
  }
};

/**
 * Navigate this tab. Used by every Tier-A navigation command so that a single
 * place decides what a "safe" URL is.
 */
export const navigate = (
  url: string,
  replace = false,
): Result<void, TabError> => {
  if (!isNavigableUrl(url)) {
    return err(
      tabError("unsafe-url", `refusing to navigate to ${url.slice(0, 60)}`),
    );
  }
  try {
    if (replace) location.replace(url);
    else location.assign(url);
    return ok(undefined);
  } catch (cause) {
    return err(
      tabError(
        "failed",
        cause instanceof Error ? cause.message : String(cause),
      ),
    );
  }
};
