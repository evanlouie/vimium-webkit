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

import {
  Array,
  Boolean,
  Context,
  Effect,
  Iterable,
  Layer,
  Match,
  Option,
  Order,
  pipe,
  String,
} from "effect";
import { Commands } from "~/core/Commands.ts";
import { Keyboard } from "~/core/Keyboard.ts";
import { Report } from "~/core/Report.ts";
import { Settings, type SettingsData } from "~/core/Settings.ts";
import { destinationOf } from "~/domain/SearchEngine.ts";
import { parseUrl } from "~/domain/Url.ts";
import { FrameLink } from "~/frames/Link.ts";
import { Dom } from "~/platform/Dom.ts";
import { Tabs } from "~/platform/Tabs.ts";
import { BRIEFLY, Hud } from "~/ui/Hud.ts";

/** Where `go` opens a URL. */
export type Destination = "this-tab" | "new-tab";

/** A copy of the URL without its query and its fragment. */
const undecorated = (url: URL): URL => {
  const bare = new URL(url.href);
  bare.hash = "";
  bare.search = "";
  return bare;
};

/** The levels of the path, without the empty ones that a double slash leaves. */
const pathSegments = (url: URL): ReadonlyArray<string> =>
  pipe(
    url.pathname.split("/"),
    Array.filter((part) => part.length > 0),
  );

/** The URL with only these levels of the path, as a directory. */
const withSegments =
  (url: URL) =>
  (segments: ReadonlyArray<string>): string => {
    const parent = new URL(url.href);
    parent.pathname = pipe(
      segments,
      Array.match({
        onEmpty: () => "/",
        onNonEmpty: (kept) => `/${pipe(kept, Array.join("/"))}/`,
      }),
    );
    return parent.href;
  };

/** The URL `levels` levels up from this one, when there is anything to go up. */
const upFrom =
  (levels: number) =>
  (url: URL): Option.Option<string> => {
    const decorated = url.hash.length > 0 || url.search.length > 0;
    const bare = undecorated(url);
    const segments = pathSegments(bare);
    // The levels that the path loses, after the query and the fragment.
    const drop = pipe(
      decorated,
      Boolean.match({ onFalse: () => levels, onTrue: () => levels - 1 }),
    );
    return pipe(
      Match.value({ decorated, spent: drop <= 0, atRoot: segments.length === 0 }),
      Match.withReturnType<Option.Option<string>>(),
      Match.when({ decorated: true, spent: true }, () => Option.some(bare.href)),
      Match.when({ atRoot: true }, () => Option.none()),
      Match.when({ spent: true }, () => Option.some(bare.href)),
      Match.orElse(() =>
        pipe(segments, Array.take(segments.length - drop), withSegments(bare), Option.some),
      ),
    );
  };

/**
 * `gu` — drop one level of the path.
 *
 * The fragment and the query go for free: neither is a level. With the earlier
 * rule, `2gu` on a URL that had a fragment removed the fragment and two path
 * segments, which is three steps for a count of two.
 */
export const goUpUrl = (href: string, levels: number): Option.Option<string> =>
  pipe(href, parseUrl, Option.flatMap(upFrom(levels)));

/** The direction of a `rel` link. */
type Rel = "prev" | "next";

/** What `[[` and `]]` look for, and what they call the link. */
const REL_LINKS = {
  prev: {
    selector: 'a[rel~="prev"], a[rel~="previous"], link[rel~="prev"]',
    name: "previous",
    patterns: (settings: SettingsData): string => settings.previousPatterns,
  },
  next: {
    selector: 'a[rel~="next"], link[rel~="next"]',
    name: "next",
    patterns: (settings: SettingsData): string => settings.nextPatterns,
  },
} as const;

const isAnchor = (element: Element): element is HTMLAnchorElement =>
  element instanceof HTMLAnchorElement;

/** A link that a text pattern names, and the rank of the first pattern that does. */
interface Candidate {
  readonly element: HTMLAnchorElement;
  readonly rank: number;
}

const byRank: Order.Order<Candidate> = pipe(
  Order.Number,
  Order.mapInput((candidate: Candidate) => candidate.rank),
);

/** The text of a link and its accessible label, as one lower-case string. */
const linkText = (anchor: HTMLAnchorElement): string => {
  const text = (anchor.textContent ?? "").trim().toLowerCase();
  const label = (anchor.getAttribute("aria-label") ?? "").trim().toLowerCase();
  return `${text} ${label}`.trim();
};

/** A character that `\b` counts as part of a word, as in upstream Vimium. */
const WORD_CHARACTER = /^\w$/u;

/** Is the character at `index` a word character? Outside the text there is none. */
const wordCharacterAt =
  (index: number) =>
  (text: string): boolean =>
    pipe(
      text,
      String.charAt(index),
      Option.exists((char) => WORD_CHARACTER.test(char)),
    );

/** Every index at which a pattern that is not empty starts in `text`. */
const occurrences = (text: string, pattern: string): ReadonlyArray<number> =>
  Array.unfold(text.indexOf(pattern), (index) =>
    pipe(
      index,
      Option.liftPredicate((found) => found !== -1),
      Option.map((found) => [found, text.indexOf(pattern, found + 1)] as const),
    ),
  );

/**
 * Does the text hold the pattern as a word?
 *
 * An end of the pattern that is a word character must not touch another word
 * character, as `\b` asks in upstream Vimium. "prev" therefore does not name
 * "Preview", and "back" does not name "Feedback". A pattern of symbols, such
 * as `»`, still matches anywhere.
 */
const holdsWord =
  (text: string) =>
  (pattern: string): boolean => {
    const end = pattern.length;
    const guardsStart = wordCharacterAt(0)(pattern);
    const guardsEnd = wordCharacterAt(end - 1)(pattern);
    return pipe(
      occurrences(text, pattern),
      Array.some(
        (index) =>
          !(guardsStart && wordCharacterAt(index - 1)(text)) &&
          !(guardsEnd && wordCharacterAt(index + end)(text)),
      ),
    );
  };

/** The link as a candidate, when one of the patterns names it. A long text names nothing. */
const candidateOf =
  (patterns: ReadonlyArray<string>) =>
  (anchor: HTMLAnchorElement): Option.Option<Candidate> =>
    pipe(
      linkText(anchor),
      Option.liftPredicate((haystack) => haystack.length > 0 && haystack.length <= 60),
      Option.flatMap((haystack) => pipe(patterns, Array.findFirstIndex(holdsWord(haystack)))),
      Option.map((rank) => ({ element: anchor, rank })),
    );

/** The first link that the best-ranked pattern names, in document order. */
const textLink = (
  document: Document,
  patterns: ReadonlyArray<string>,
): Option.Option<HTMLAnchorElement> => {
  const normalised = pipe(
    patterns,
    Array.map((pattern) => pattern.trim().toLowerCase()),
    Array.filter((pattern) => pattern.length > 0),
  );
  return pipe(
    document.querySelectorAll("a[href]"),
    Array.fromIterable,
    Array.filter(isAnchor),
    Array.map(candidateOf(normalised)),
    Array.getSomes,
    Array.sort(byRank),
    Array.head,
    Option.map(({ element }) => element),
  );
};

/**
 * `[[` and `]]` — find the "previous" or the "next" link.
 *
 * A `rel` attribute wins over a text rule, because it is not ambiguous.
 * Upstream Vimium does the same.
 */
export const findRelLink = (
  document: Document,
  rel: Rel,
  patterns: readonly string[],
): Option.Option<HTMLAnchorElement> =>
  pipe(
    // `querySelectorAll`, and not `querySelector`. A `<link rel="next">` is in
    // `<head>` and therefore comes first in tree order. On the usual layout for
    // paginated content — a machine-readable `<link>` and a visible `<a>` — the
    // first match was the `<link>`, and the unambiguous anchor beside it was
    // abandoned for a text rule.
    document.querySelectorAll(REL_LINKS[rel].selector),
    Iterable.findFirst(isAnchor),
    Option.orElse(() => textLink(document, patterns)),
  );

/** "key", or "3 keys". */
const keysLabel = (count: number): string =>
  pipe(count === 1, Boolean.match({ onFalse: () => `${count} keys`, onTrue: () => "key" }));

export class Navigation extends Context.Service<
  Navigation,
  {
    /** Go to a URL, or search for the text. This is the shared `go` step. */
    readonly go: (input: string, destination: Destination) => Effect.Effect<void>;
  }
>()("vimium/features/Navigation") {
  static readonly layer: Layer.Layer<
    Navigation,
    never,
    Commands | Dom | FrameLink | Hud | Keyboard | Report | Settings | Tabs
  > = Layer.effect(
    Navigation,
    Effect.gen(function* () {
      const commands = yield* Commands;
      const dom = yield* Dom;
      const link = yield* FrameLink;
      const hud = yield* Hud;
      const keyboard = yield* Keyboard;
      const report = yield* Report;
      const settings = yield* Settings;
      const tabs = yield* Tabs;

      /** A refusal reaches the user in the words of the service that refused. */
      const reportFailure = (error: { readonly detail: string }): Effect.Effect<void> =>
        report.error(error.detail);

      const navigate = (url: string): Effect.Effect<void> =>
        pipe(tabs.navigate(url), Effect.catch(reportFailure));

      /** A DOM call whose failure leaves nothing to say. */
      const attempt = (api: string, run: () => void): Effect.Effect<void> =>
        pipe(dom.attempt(api, run), Effect.ignore);

      const go = Effect.fn("Navigation.go")(function* (input: string, destination: Destination) {
        const current = yield* settings.current;
        // The rule of the omnibar, without the engine keywords: a pasted text
        // is a URL or a search with the default engine.
        const { url } = destinationOf(input, [], current.searchUrl);
        yield* pipe(
          Match.value(destination),
          Match.when("this-tab", () => tabs.navigate(url)),
          Match.when("new-tab", () => pipe(tabs.open(url, { active: true }), Effect.asVoid)),
          Match.exhaustive,
          Effect.catch(reportFailure),
        );
      });

      const followRelLink = Effect.fn("Navigation.followRelLink")(function* (rel: Rel) {
        const current = yield* settings.current;
        const { name, patterns } = REL_LINKS[rel];
        const texts = patterns(current).split(",");
        const found = yield* dom.probeOrElse(
          () => findRelLink(dom.document, rel, texts),
          Option.none,
        );
        yield* pipe(
          found,
          Option.match({
            onNone: () => report.error(`No "${name}" link found`),
            onSome: (anchor) =>
              attempt("HTMLAnchorElement.click", () => {
                anchor.click();
              }),
          }),
        );
      });

      yield* commands.registerAll({
        reload: () =>
          attempt("location.reload", () => {
            dom.window.location.reload();
          }),

        goBack: ({ count }) =>
          attempt("history.go", () => {
            dom.window.history.go(-count);
          }),

        goForward: ({ count }) =>
          attempt("history.go", () => {
            dom.window.history.go(count);
          }),

        goUp: ({ count }) =>
          pipe(
            dom.href,
            Effect.map((href) => goUpUrl(href, count)),
            Effect.flatMap(
              Option.match({
                onNone: () => report.error("Already at the root of this site"),
                onSome: navigate,
              }),
            ),
          ),

        goToRoot: () =>
          pipe(
            dom.href,
            Effect.map((href) => new URL("/", href).href),
            Effect.flatMap(navigate),
          ),

        goPrevious: () => followRelLink("prev"),
        goNext: () => followRelLink("next"),

        toggleViewSource: () =>
          pipe(
            dom.href,
            // `internal` trust: we built this URL from our own location, and
            // `view-source:` is deliberately outside the set that a
            // page-supplied URL may use.
            Effect.flatMap((href) =>
              tabs.open(`view-source:${href}`, {
                active: true,
                trust: "internal",
              }),
            ),
            Effect.asVoid,
            Effect.catch(() =>
              report.error("Your userscript manager refused to open view-source:"),
            ),
          ),

        nextFrame: () => pipe(link.focusFrame(1), Effect.catch(reportFailure)),

        mainFrame: () => pipe(link.focusFrame(-1), Effect.catch(reportFailure)),

        passNextKey: ({ count }) =>
          pipe(
            hud.show(`Passing the next ${keysLabel(count)} to the page`, BRIEFLY),
            Effect.andThen(keyboard.passNextKey(count)),
          ),
      });

      return Navigation.of({ go });
    }),
  );
}
