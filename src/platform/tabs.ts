/**
 * Tab operations (IMPLEMENTATION_PLAN.md §7.5).
 *
 * There is no `chrome.tabs` for a userscript. Everything here is either an
 * approximation via `GM_openInTab` or an explicit, user-visible refusal — never
 * a silent no-op (goal G3).
 */

import { Context, Effect, Layer, Schema } from "effect";
import { Gm, type GmSurface, openInTab } from "./gm.ts";

export const TabFailureReason = Schema.Literals([
  "unavailable",
  "blocked",
  "failed",
  "unsafe-url",
]);

export type TabFailureReason = typeof TabFailureReason.Type;

export class TabError extends Schema.TaggedErrorClass<TabError>()("TabError", {
  reason: TabFailureReason,
  detail: Schema.String,
  /** Shown in the HUD when the failure is a permanent capability gap. */
  nativeAlternative: Schema.optional(Schema.String),
}) {}

const tabError = (
  reason: TabFailureReason,
  detail: string,
  nativeAlternative?: string,
): TabError =>
  new TabError({
    reason,
    detail,
    ...(nativeAlternative !== undefined ? { nativeAlternative } : {}),
  });

/**
 * Where a URL came from, which decides how much we trust it.
 *
 * `"page"` covers everything derived from the document or from the user's
 * clipboard: hint `href`s, `rel=next` targets, stored marks, omnibar input.
 * `"internal"` is a URL this script constructed — `gs`'s `view-source:`, the
 * configured `newTabUrl`.
 *
 * The distinction matters because `GM_openInTab` is not subject to the
 * browser's block on navigating from `http:` to `file:`. Without it, a page
 * could offer `<a href="file:///Users/x/.ssh/id_rsa">` and have `F` open it.
 */
export type UrlTrust = "page" | "internal";

/**
 * Schemes we are willing to navigate to, by provenance.
 *
 * `javascript:` and `data:` appear in neither: `GM_openInTab` will happily
 * execute either, and both are trivially reachable from page content.
 */
const PAGE_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "ftp:",
]);

/**
 * The wider set, for URLs we built ourselves.
 *
 * `view-source:` is here because `gs` needs it; managers may still refuse,
 * which surfaces as a normal failure.
 */
const INTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  ...PAGE_SCHEMES,
  "file:",
  "about:",
  "view-source:",
  "chrome:",
  "safari-web-extension:",
]);

export const isNavigableUrl = (
  url: string,
  trust: UrlTrust = "page",
): boolean => {
  try {
    const parsed = new URL(url, document.baseURI);
    const allowed = trust === "internal" ? INTERNAL_SCHEMES : PAGE_SCHEMES;
    return allowed.has(parsed.protocol);
  } catch {
    return false;
  }
};

export interface OpenTabOptions {
  /** `false` requests a background tab; honoured by VM/TM, ignored by quoid. */
  readonly active?: boolean;
  /** Place the new tab immediately after this one. */
  readonly insert?: boolean;
  /** Defaults to `"page"`; only pass `"internal"` for a URL we constructed. */
  readonly trust?: UrlTrust;
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
): Effect.Effect<OpenTabOutcome, TabError> =>
  Effect.suspend((): Effect.Effect<OpenTabOutcome, TabError> => {
    if (!isNavigableUrl(url, options.trust ?? "page")) {
      return Effect.fail(
        tabError("unsafe-url", `refusing to open ${url.slice(0, 60)}`),
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
    }).pipe(
      Effect.mapError((cause) =>
        tabError(
          cause.reason === "unavailable" ? "unavailable" : "blocked",
          cause.detail,
        )
      ),
      Effect.map((result) => ({
        url: absolute,
        viaManager: result.viaManager,
        close: result.handle?.close ? () => result.handle?.close?.() : null,
      })),
    );
  });

/**
 * Close the current tab.
 *
 * Requires `@grant window.close`, which Violentmonkey and Tampermonkey honour
 * and quoid/Stay do not. When unavailable the caller must show the HUD message
 * carried on the error rather than doing nothing.
 */
export const closeCurrentTab = (
  surface: GmSurface,
): Effect.Effect<void, TabError> =>
  Effect.suspend(() => {
    const close = surface.windowClose;
    if (!close) {
      return Effect.fail(
        tabError(
          "unavailable",
          "closing tabs needs Tampermonkey or Violentmonkey",
          "⌘W",
        ),
      );
    }
    return Effect.try({
      try: () => close(),
      catch: (cause) =>
        tabError(
          "failed",
          cause instanceof Error ? cause.message : String(cause),
          "⌘W",
        ),
    });
  });

/**
 * Navigate this tab. Used by every Tier-A navigation command so that a single
 * place decides what a "safe" URL is.
 */
export const navigate = (
  url: string,
  replace = false,
  trust: UrlTrust = "page",
): Effect.Effect<void, TabError> =>
  Effect.suspend(() => {
    if (!isNavigableUrl(url, trust)) {
      return Effect.fail(
        tabError("unsafe-url", `refusing to navigate to ${url.slice(0, 60)}`),
      );
    }
    return Effect.try({
      try: () => {
        if (replace) location.replace(url);
        else location.assign(url);
      },
      catch: (cause) =>
        tabError(
          "failed",
          cause instanceof Error ? cause.message : String(cause),
        ),
    });
  });

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** Tab operations, as a service. */
export class Tabs extends Context.Service<Tabs, {
  readonly open: (
    url: string,
    options?: OpenTabOptions,
  ) => Effect.Effect<OpenTabOutcome, TabError>;
  readonly closeCurrent: Effect.Effect<void, TabError>;
  readonly navigate: (
    url: string,
    replace?: boolean,
    trust?: UrlTrust,
  ) => Effect.Effect<void, TabError>;
}>()("vimium/platform/Tabs") {
  static readonly layer = Layer.effect(
    Tabs,
    Effect.gen(function*() {
      const { surface } = yield* Gm;
      // Plain delegation, not `Effect.fn`; see the note in `clipboard.ts`.
      return Tabs.of({
        open: (url, options = {}) => openTab(surface, url, options),
        closeCurrent: closeCurrentTab(surface),
        navigate: (url, replace, trust) => navigate(url, replace, trust),
      });
    }),
  );
}
