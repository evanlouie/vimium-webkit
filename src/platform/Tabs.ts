/**
 * Tab operations.
 *
 * A userscript has no `chrome.tabs`. Everything here is either an approximation
 * through the manager, or a refusal that the user can see. Nothing here does
 * nothing quietly.
 */

import { Context, Effect, Layer, Option, Schema } from "effect";
import { Dom } from "./Dom.ts";
import { Gm } from "./Gm.ts";

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
  /** Shown in the HUD when the failure is a permanent gap in the manager. */
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
    ...(nativeAlternative === undefined ? {} : { nativeAlternative }),
  });

/**
 * Where a URL came from, which decides how much we trust it.
 *
 * `"page"` covers everything that comes from the document or from the user's
 * clipboard: a hint target, a `rel=next` target, a stored mark, omnibar input.
 * `"internal"` is a URL that this script built, such as the `view-source:` URL
 * of the `gs` command, or the configured new-tab URL.
 *
 * The difference matters. `GM_openInTab` is not subject to the browser's block
 * on a move from `http:` to `file:`. Without this rule a page could offer
 * `<a href="file:///Users/x/.ssh/id_rsa">` and have a hint open it.
 */
export type UrlTrust = "page" | "internal";

/**
 * The schemes that we will go to, by source.
 *
 * `javascript:` and `data:` are in neither set. `GM_openInTab` runs both, and
 * page content can reach both with no difficulty.
 */
const PAGE_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "ftp:"]);

/**
 * The wider set, for a URL that we built.
 *
 * `view-source:` is here because the `gs` command needs it. A manager can still
 * refuse, and that refusal becomes a normal failure.
 */
const INTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  ...PAGE_SCHEMES,
  "file:",
  "about:",
  "view-source:",
  "chrome:",
  "safari-web-extension:",
]);

/** Is this URL one that we will go to, given where it came from? */
export const isNavigableUrl = (
  url: string,
  baseUri: string,
  trust: UrlTrust = "page",
): boolean => {
  try {
    const parsed = new URL(url, baseUri);
    const allowed = trust === "internal" ? INTERNAL_SCHEMES : PAGE_SCHEMES;
    return allowed.has(parsed.protocol);
  } catch {
    return false;
  }
};

export interface OpenTabOptions {
  /** `false` asks for a background tab. Violentmonkey and Tampermonkey obey. */
  readonly active?: boolean;
  /** Put the new tab immediately after this one. */
  readonly insert?: boolean;
  /** It defaults to `"page"`. Pass `"internal"` only for a URL that we built. */
  readonly trust?: UrlTrust;
}

export interface OpenTabOutcome {
  readonly url: string;
  /** `false` means that `window.open` was used, and the tab took focus. */
  readonly viaManager: boolean;
  readonly close: Option.Option<Effect.Effect<void>>;
}

export class Tabs extends Context.Service<Tabs, {
  /**
   * Open a URL in a new tab.
   *
   * Always prefer this to `window.open`. On WebKit `window.open` needs fresh
   * synchronous activation and cannot make a background tab, so a `t` command
   * through it either takes the focus or is stopped by the popup blocker.
   */
  readonly open: (
    url: string,
    options?: OpenTabOptions,
  ) => Effect.Effect<OpenTabOutcome, TabError>;

  /**
   * Close this tab.
   *
   * It needs `@grant window.close`, which Violentmonkey and Tampermonkey
   * honour and the others do not. When it is absent, the caller must show the
   * message on the error, and must not do nothing.
   */
  readonly closeCurrent: Effect.Effect<void, TabError>;

  /** Go to a URL in this tab. One place decides what a safe URL is. */
  readonly navigate: (
    url: string,
    options?: { readonly replace?: boolean; readonly trust?: UrlTrust },
  ) => Effect.Effect<void, TabError>;
}>()("vimium/platform/Tabs") {
  static readonly layer: Layer.Layer<Tabs, never, Gm | Dom> = Layer.effect(
    Tabs,
    Effect.gen(function*() {
      const gm = yield* Gm;
      const dom = yield* Dom;

      const open = Effect.fn("Tabs.open")(
        function*(url: string, options: OpenTabOptions = {}) {
          const base = dom.document.baseURI;
          if (!isNavigableUrl(url, base, options.trust ?? "page")) {
            return yield* tabError(
              "unsafe-url",
              `refusing to open ${url.slice(0, 60)}`,
            );
          }

          const absolute = new URL(url, base).href;
          const active = options.active ?? true;

          const result = yield* Effect.mapError(
            gm.openInTab(absolute, {
              active,
              insert: options.insert ?? true,
              setParent: true,
              // Tampermonkey's older spelling. Others ignore it.
              loadInBackground: !active,
            }),
            (cause) =>
              tabError(
                cause.reason === "unavailable" ? "unavailable" : "blocked",
                cause.detail,
              ),
          );

          const handle = result.handle;
          return {
            url: absolute,
            viaManager: result.viaManager,
            close: handle?.close === undefined ? Option.none() : Option.some(
              Effect.sync(() => {
                handle.close?.();
              }),
            ),
          };
        },
      );

      const closeCurrent = Effect.mapError(
        gm.closeWindow,
        (cause) =>
          cause.reason === "unavailable"
            ? tabError(
              "unavailable",
              "closing a tab needs Tampermonkey or Violentmonkey",
              "⌘W",
            )
            : tabError("failed", cause.detail, "⌘W"),
      );

      const navigate = Effect.fn("Tabs.navigate")(
        function*(
          url: string,
          options: { readonly replace?: boolean; readonly trust?: UrlTrust } =
            {},
        ) {
          const base = dom.document.baseURI;
          if (!isNavigableUrl(url, base, options.trust ?? "page")) {
            return yield* tabError(
              "unsafe-url",
              `refusing to go to ${url.slice(0, 60)}`,
            );
          }
          return yield* Effect.mapError(
            dom.attempt("location.assign", () => {
              if (options.replace === true) dom.window.location.replace(url);
              else dom.window.location.assign(url);
            }),
            (cause) => tabError("failed", cause.detail),
          );
        },
      );

      return Tabs.of({ open, closeCurrent, navigate });
    }),
  );
}
