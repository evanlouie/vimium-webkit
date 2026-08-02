/**
 * Moving around: history, the URL hierarchy, the `rel` links and the frames.
 *
 * Everything here is a tier A or tier B command body. The catalogue in
 * `~/domain/Command.ts` says what each one is; this file says what each one
 * does.
 *
 * Every navigation goes through the `Tabs` service, so that one place decides
 * what a safe URL is.
 */

import { Context, Effect, Layer, Option } from "effect";
import { Commands } from "~/core/Commands.ts";
import { Keyboard } from "~/core/Keyboard.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { FrameLink } from "~/frames/Link.ts";
import { Dom } from "~/platform/Dom.ts";
import { Tabs } from "~/platform/Tabs.ts";
import { Hud } from "~/ui/Hud.ts";

/**
 * A bare word becomes a search. Anything that looks like a URL is a URL.
 *
 * Pure, and exported, so that the rule is testable without a document.
 */
export const toUrl = (input: string, searchUrl: string): string => {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  if (/^[^\s/]+\.[^\s/]{2,}(\/|$)/.test(trimmed)) return `https://${trimmed}`;
  return searchUrl.replace("%s", encodeURIComponent(trimmed));
};

/**
 * `gu` — drop one level of the path.
 *
 * The fragment and the query go for free: neither is a level. With the earlier
 * rule, `2gu` on a URL that had a fragment removed the fragment and two path
 * segments, which is three steps for a count of two.
 */
export const goUpUrl = (
  href: string,
  levels: number,
): Option.Option<string> => {
  try {
    const url = new URL(href);
    const hadDecoration = url.hash.length > 0 || url.search.length > 0;
    url.hash = "";
    url.search = "";
    if (hadDecoration && levels <= 1) return Option.some(url.href);

    const segments = url.pathname.split("/").filter((part) => part.length > 0);
    if (segments.length === 0) return Option.none();
    const drop = hadDecoration ? levels - 1 : levels;
    if (drop <= 0) return Option.some(url.href);
    segments.splice(Math.max(0, segments.length - drop));
    url.pathname = `/${segments.join("/")}${segments.length > 0 ? "/" : ""}`;
    return Option.some(url.href);
  } catch {
    return Option.none();
  }
};

/**
 * `[[` and `]]` — find the "previous" or the "next" link.
 *
 * A `rel` attribute wins over a text rule, because it is not ambiguous.
 * Upstream Vimium does the same.
 */
export const findRelLink = (
  document: Document,
  rel: "prev" | "next",
  patterns: readonly string[],
): Option.Option<HTMLAnchorElement> => {
  const relSelector = rel === "prev"
    ? 'a[rel~="prev"], a[rel~="previous"], link[rel~="prev"]'
    : 'a[rel~="next"], link[rel~="next"]';

  // `querySelectorAll`, and not `querySelector`. A `<link rel="next">` is in
  // `<head>` and therefore comes first in tree order. On the usual layout for
  // paginated content — a machine-readable `<link>` and a visible `<a>` — the
  // first match was the `<link>`, and the unambiguous anchor beside it was
  // abandoned for a text rule.
  for (const tagged of document.querySelectorAll(relSelector)) {
    if (tagged instanceof HTMLAnchorElement) return Option.some(tagged);
  }

  const normalised = patterns
    .map((pattern) => pattern.trim().toLowerCase())
    .filter((pattern) => pattern.length > 0);

  const candidates: Array<{ element: HTMLAnchorElement; rank: number }> = [];
  for (const anchor of document.querySelectorAll("a[href]")) {
    if (!(anchor instanceof HTMLAnchorElement)) continue;
    const text = (anchor.textContent ?? "").trim().toLowerCase();
    const label = (anchor.getAttribute("aria-label") ?? "").trim()
      .toLowerCase();
    const haystack = `${text} ${label}`.trim();
    if (haystack.length === 0 || haystack.length > 60) continue;
    const rank = normalised.findIndex((pattern) =>
      haystack === pattern || haystack.includes(pattern)
    );
    if (rank !== -1) candidates.push({ element: anchor, rank });
  }

  candidates.sort((left, right) => left.rank - right.rank);
  const best = candidates[0];
  return best === undefined ? Option.none() : Option.some(best.element);
};

export class Navigation extends Context.Service<Navigation, {
  /** Go to a URL, or search for the text. This is the shared `go` step. */
  readonly go: (
    input: string,
    options: { readonly newTab: boolean },
  ) => Effect.Effect<void>;
}>()("vimium/features/Navigation") {
  static readonly layer: Layer.Layer<
    Navigation,
    never,
    | Commands
    | Dom
    | FrameLink
    | Hud
    | Keyboard
    | Report
    | Settings
    | Tabs
  > = Layer.effect(
    Navigation,
    Effect.gen(function*() {
      const commands = yield* Commands;
      const dom = yield* Dom;
      const link = yield* FrameLink;
      const hud = yield* Hud;
      const keyboard = yield* Keyboard;
      const report = yield* Report;
      const settings = yield* Settings;
      const tabs = yield* Tabs;

      const go = Effect.fn("Navigation.go")(
        function*(input: string, options: { readonly newTab: boolean }) {
          const current = yield* settings.current;
          const url = toUrl(input, current.searchUrl);
          yield* Effect.catch(
            options.newTab
              ? Effect.asVoid(tabs.open(url, { active: true }))
              : tabs.navigate(url),
            (error) => report.error(error.detail),
          );
        },
      );

      const followRelLink = Effect.fn("Navigation.followRelLink")(
        function*(rel: "prev" | "next") {
          const current = yield* settings.current;
          const patterns = rel === "prev"
            ? current.previousPatterns.split(",")
            : current.nextPatterns.split(",");
          const link = yield* dom.probeOr(
            () => findRelLink(dom.document, rel, patterns),
            Option.none<HTMLAnchorElement>(),
          );
          if (Option.isNone(link)) {
            yield* report.error(
              `No "${rel === "prev" ? "previous" : "next"}" link found`,
            );
            return;
          }
          yield* Effect.ignore(
            dom.attempt("HTMLAnchorElement.click", () => {
              link.value.click();
            }),
          );
        },
      );

      yield* commands.registerAll({
        reload: () =>
          Effect.ignore(
            dom.attempt("location.reload", () => {
              dom.window.location.reload();
            }),
          ),

        goBack: ({ count }) =>
          Effect.ignore(
            dom.attempt("history.go", () => {
              dom.window.history.go(-count);
            }),
          ),

        goForward: ({ count }) =>
          Effect.ignore(
            dom.attempt("history.go", () => {
              dom.window.history.go(count);
            }),
          ),

        goUp: ({ count }) =>
          Effect.gen(function*() {
            const href = yield* dom.href;
            const url = goUpUrl(href, count);
            if (Option.isNone(url)) {
              yield* report.error("Already at the root of this site");
              return;
            }
            yield* Effect.catch(
              tabs.navigate(url.value),
              (error) => report.error(error.detail),
            );
          }),

        goToRoot: () =>
          Effect.gen(function*() {
            const href = yield* dom.href;
            yield* Effect.catch(
              tabs.navigate(new URL("/", href).href),
              (error) => report.error(error.detail),
            );
          }),

        goPrevious: () => followRelLink("prev"),
        goNext: () => followRelLink("next"),

        toggleViewSource: () =>
          Effect.gen(function*() {
            const href = yield* dom.href;
            // `internal` trust: we built this URL from our own location, and
            // `view-source:` is deliberately outside the set that a
            // page-supplied URL may use.
            yield* Effect.catch(
              tabs.open(`view-source:${href}`, {
                active: true,
                trust: "internal",
              }),
              () =>
                report.error(
                  "Your userscript manager refused to open view-source:",
                ),
            );
          }),

        nextFrame: () =>
          Effect.catch(
            link.focusFrame(1),
            (error) => report.error(error.detail),
          ),

        mainFrame: () =>
          Effect.catch(
            link.focusFrame(-1),
            (error) => report.error(error.detail),
          ),

        passNextKey: ({ count }) =>
          Effect.gen(function*() {
            yield* hud.show(
              `Passing the next ${
                count === 1 ? "key" : `${count} keys`
              } to the page`,
            );
            yield* keyboard.passNextKey(count);
          }),
      });

      return Navigation.of({ go });
    }),
  );
}
