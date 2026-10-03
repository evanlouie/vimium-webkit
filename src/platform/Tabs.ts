/**
 * Tab operations.
 *
 * A userscript has no `chrome.tabs`. Everything here is either an approximation
 * through the manager, or a refusal that the user can see. Nothing here does
 * nothing quietly.
 */

import { Array, Boolean, Context, Effect, Layer, Match, Option, Schema, pipe } from "effect";
import { Dom } from "./Dom.ts";
import { Gm, type GmError, OpenInTabResult } from "./Gm.ts";

/** How a tab was opened, as the manager reports it. `Tabs.open` gives it back. */
export { OpenInTabResult };

export const TabFailureReason = Schema.Literals(["unavailable", "blocked", "failed", "unsafe-url"]);

export type TabFailureReason = typeof TabFailureReason.Type;

export class TabError extends Schema.TaggedError<TabError>()("TabError", {
  reason: TabFailureReason,
  detail: Schema.String,
  /**
   * Shown in the HUD when the failure is a permanent gap in the manager. A
   * failure that names none has none.
   */
  nativeAlternative: pipe(
    Schema.OptionFromOptional(Schema.String),
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
}) {}

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
const PAGE_SCHEMES: ReadonlyArray<string> = ["http:", "https:", "ftp:"];

/**
 * The wider set, for a URL that we built.
 *
 * `view-source:` is here because the `gs` command needs it. A manager can still
 * refuse, and that refusal becomes a normal failure.
 */
const INTERNAL_SCHEMES: ReadonlyArray<string> = pipe(
  PAGE_SCHEMES,
  Array.appendAll(["file:", "about:", "view-source:", "chrome:", "safari-web-extension:"]),
);

const schemesFor = (trust: UrlTrust): ReadonlyArray<string> =>
  pipe(
    Match.value(trust),
    Match.when("page", () => PAGE_SCHEMES),
    Match.when("internal", () => INTERNAL_SCHEMES),
    Match.exhaustive,
  );

const parseUrl = Option.liftThrowable((url: string, baseUri: string) => new URL(url, baseUri));

/** The URL, resolved, when it is one that we will go to, given where it came from. */
const navigableUrl =
  (baseUri: string, trust: UrlTrust) =>
  (url: string): Option.Option<URL> =>
    pipe(
      parseUrl(url, baseUri),
      Option.filter((parsed) => pipe(schemesFor(trust), Array.contains(parsed.protocol))),
    );

/** A manager with no tab API is a gap. Any other failure means that the tab was stopped. */
const openFailure = (cause: GmError): TabError =>
  new TabError({
    reason: pipe(
      Match.value(cause.reason),
      Match.withReturnType<TabFailureReason>(),
      Match.when("unavailable", () => "unavailable"),
      Match.when("failed", () => "blocked"),
      Match.exhaustive,
    ),
    detail: cause.detail,
  });

const closeFailure = (cause: GmError): TabError =>
  pipe(
    Match.value(cause.reason),
    Match.when(
      "unavailable",
      () =>
        new TabError({
          reason: "unavailable",
          detail: "closing a tab needs Tampermonkey or Violentmonkey",
          nativeAlternative: Option.some("⌘W"),
        }),
    ),
    Match.when(
      "failed",
      () =>
        new TabError({
          reason: "failed",
          detail: cause.detail,
          nativeAlternative: Option.some("⌘W"),
        }),
    ),
    Match.exhaustive,
  );

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
  /** `Window` means that `window.open` was used, and the tab took focus. */
  readonly opened: OpenInTabResult;
}

export class Tabs extends Context.Service<
  Tabs,
  {
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
  }
>()("vimium/platform/Tabs") {
  static readonly layer: Layer.Layer<Tabs, never, Gm | Dom> = Layer.effect(
    Tabs,
    Effect.gen(function* () {
      const gm = yield* Gm;
      const dom = yield* Dom;

      /** The URL, resolved against this document, or the refusal that names it. */
      const checked = (
        url: string,
        trust: UrlTrust,
        refusal: string,
      ): Effect.Effect<URL, TabError> =>
        pipe(
          url,
          navigableUrl(dom.document.baseURI, trust),
          Effect.fromOption(
            () => new TabError({ reason: "unsafe-url", detail: `${refusal} ${url.slice(0, 60)}` }),
          ),
        );

      const open = Effect.fn("Tabs.open")(function* (url: string, options: OpenTabOptions = {}) {
        const target = yield* checked(url, options.trust ?? "page", "refusing to open");
        const active = options.active ?? true;

        const opened = yield* pipe(
          gm.openInTab(target.href, {
            active,
            insert: options.insert ?? true,
            setParent: true,
            // Tampermonkey's older spelling. Others ignore it.
            loadInBackground: !active,
          }),
          Effect.mapError(openFailure),
        );

        return { url: target.href, opened };
      });

      const closeCurrent = pipe(gm.closeWindow, Effect.mapError(closeFailure));

      const navigate = Effect.fn("Tabs.navigate")(function* (
        url: string,
        options: { readonly replace?: boolean; readonly trust?: UrlTrust } = {},
      ) {
        yield* checked(url, options.trust ?? "page", "refusing to go to");
        return yield* pipe(
          dom.attempt("location.assign", () =>
            pipe(
              options.replace === true,
              Boolean.match({
                onFalse: () => dom.window.location.assign(url),
                onTrue: () => dom.window.location.replace(url),
              }),
            ),
          ),
          Effect.mapError((cause) => new TabError({ reason: "failed", detail: cause.detail })),
        );
      });

      return Tabs.of({ open, closeCurrent, navigate });
    }),
  );
}
