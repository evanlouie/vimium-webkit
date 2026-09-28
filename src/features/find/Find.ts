/**
 * Find mode: the search runtime, and the wiring of the HUD input.
 *
 * Ported in structure from the Vimium `content_scripts/mode_find.js` and
 * `content_scripts/mode_post_find.js` (MIT). The differences that matter:
 *
 * - our own engine lists the matches, so the HUD can say `3/17` where upstream
 *   can only say what it managed to find;
 * - the selection of the document is **not touched** while the user types.
 *   Upstream must move it, because `window.find()` moves it as a side effect.
 *   Only a commit with Enter selects anything here, and that is what makes
 *   Escape a true no-op;
 * - Escape puts back the scroll position that was read when find opened.
 *
 * Two rules hold the design together:
 *
 * 1. **A search does not suspend.** History cycling with the arrow keys runs a
 *    search from inside the `keydown` of the prompt, and the HUD runs that body
 *    inside the dispatch of the browser. Both hot loops therefore stop against
 *    a time budget in place, and neither yields. Read `ARCHITECTURE.md` section
 *    3.
 * 2. **A session is a fiber.** `enter` interrupts the session before it starts
 *    a new one, and the finalizer of the interrupted session puts the scroll
 *    position back. There is no "cancel" flag to keep in step.
 */

import {
  Array,
  Boolean,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  FiberHandle,
  Layer,
  Match,
  Number,
  Option,
  Ref,
  Scope,
  Struct,
  pipe,
} from "effect";
import { constVoid } from "effect/Function";
import { Commands } from "~/core/Commands.ts";
import {
  CONTINUE_BUBBLING,
  type HandlerResult,
  PASS_EVENT_TO_PAGE,
  SUPPRESS_EVENT,
  SUPPRESS_PROPAGATION,
} from "~/core/HandlerStack.ts";
import { ExitTrigger, KeyPolicy, Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import {
  ParsedFindQuery,
  parseFindQuery,
  type ReadyFindQuery,
  toRegExp,
  wordQuery,
} from "~/domain/FindQuery.ts";
import { FIND_HISTORY_LIMIT } from "~/domain/Persisted.ts";
import { Capabilities } from "~/platform/Capabilities.ts";
import { Dom } from "~/platform/Dom.ts";
import { elementAt } from "~/platform/Elements.ts";
import { Storage } from "~/platform/Storage.ts";
import type { HudPromptOptions } from "~/ui/Hud.ts";
import { BRIEFLY, Hud, HudDuration, KeyClaim } from "~/ui/Hud.ts";
import { Ui } from "~/ui/Ui.ts";
import {
  collectTextRuns,
  DEFAULT_MAX_CHARACTERS,
  type FindMatch,
  firstMatchInView,
  indexAtSelection,
  matchesInRuns,
  type RunSearch,
  type TextRun,
  wordUnderCursor,
} from "./Engine.ts";
import { FIND_CSS, FIND_STYLE_KEY, type Highlighter, makeHighlighter } from "./Highlight.ts";

// ---------------------------------------------------------------------------
// The result of one search
// ---------------------------------------------------------------------------

/** What one search found, in the terms that the HUD reports. */
export type SearchOutcome = Data.TaggedEnum<{
  /** The query is empty, so there is nothing to say. */
  NoQuery: Record<never, never>;
  /** The pattern is not a regular expression that compiles. */
  BadPattern: { readonly message: string };
  NoMatches: {
    /** See `Matches.stopped`. */
    readonly stopped: boolean;
  };
  Matches: {
    readonly count: number;
    /** The index of the current match, from zero. */
    readonly index: number;
    /**
     * True when the search stopped before the end of the page.
     *
     * The time budget stops it, and so does a match that is longer than the
     * engine can read. The counts are then the counts of the text that was
     * read, and not of the page. The HUD says so, because a wrong `3/17` is
     * worse than no number.
     */
    readonly stopped: boolean;
  };
}>;

export const SearchOutcome = Data.taggedEnum<SearchOutcome>();

const partialNote: (stopped: boolean) => string = Boolean.match({
  onFalse: () => "",
  onTrue: () => "  (stopped before the end of the page)",
});

/** `"3/17"`, `"No matches"`, or the message of the bad pattern. */
export const statusText: (outcome: SearchOutcome) => string = SearchOutcome.$match({
  NoQuery: () => "",
  BadPattern: ({ message }) => `Bad pattern: ${message}`,
  NoMatches: ({ stopped }) => `No matches${partialNote(stopped)}`,
  Matches: ({ count, index, stopped }) => `${index + 1}/${count}${partialNote(stopped)}`,
});

/** Newest first, without a repeat, and capped. Pure, so the cap is testable. */
export const pushHistory = (history: ReadonlyArray<string>, query: string): ReadonlyArray<string> =>
  pipe(
    query.trim(),
    Option.liftPredicate((trimmed) => trimmed.length > 0),
    Option.match({
      onNone: () => history,
      onSome: (trimmed) =>
        pipe(
          history,
          Array.filter((entry) => entry !== trimmed),
          Array.prepend(trimmed),
          Array.take(FIND_HISTORY_LIMIT),
        ),
    }),
  );

// ---------------------------------------------------------------------------
// The matches of the last search
// ---------------------------------------------------------------------------

/** The matches of the last search, and the one that is current. */
type Hits = Data.TaggedEnum<{
  None: Record<never, never>;
  Found: {
    readonly matches: Array.NonEmptyReadonlyArray<FindMatch>;
    /** The index of the current match. It is always in range. */
    readonly current: number;
    /**
     * Did the search that gave these matches stop before the end of the page?
     *
     * `n` and `N` do not search again, so they must report the stop of the
     * search that gave them their matches. A count that is partial stays
     * partial.
     */
    readonly partial: boolean;
  };
}>;

const Hits = Data.taggedEnum<Hits>();

type Found = Data.TaggedEnum.Value<Hits, "Found">;

const NO_HITS: Hits = Hits.None();

const NO_RUNS: ReadonlyArray<TextRun> = [];

const NOTHING_FOUND: RunSearch = { matches: [], stopped: false };

/**
 * The matches of one search.
 *
 * `anchor` is where the caller would like to land. Without one, the search
 * lands on the first match in view.
 */
const hitsOf = (search: RunSearch, anchor: Option.Option<number>): Hits =>
  pipe(
    search.matches,
    Array.match({
      onEmpty: () => NO_HITS,
      onNonEmpty: (matches) =>
        Hits.Found({
          matches,
          current: pipe(
            anchor,
            Option.getOrElse(() => firstMatchInView(matches)),
            Number.clamp({ minimum: 0, maximum: matches.length - 1 }),
          ),
          partial: search.stopped,
        }),
    }),
  );

const matchesOutcome = ({ matches, current, partial }: Found): SearchOutcome =>
  SearchOutcome.Matches({ count: matches.length, index: current, stopped: partial });

/** The report of a search of `query` that gave `search`, and `hits` from it. */
const outcomeOf = (query: ParsedFindQuery, search: RunSearch, hits: Hits): SearchOutcome =>
  pipe(
    query,
    ParsedFindQuery.$match({
      Empty: () => SearchOutcome.NoQuery(),
      Invalid: ({ error }) => SearchOutcome.BadPattern({ message: error }),
      Ready: () =>
        pipe(
          hits,
          Hits.$match({
            None: () => SearchOutcome.NoMatches({ stopped: search.stopped }),
            Found: matchesOutcome,
          }),
        ),
    }),
  );

/** `n` and `N`: the current match moves by `delta`, and wraps, as it does in Vim. */
const stepped =
  (delta: number) =>
  (found: Found): Found => {
    const count = found.matches.length;
    return pipe(
      found,
      Struct.assign({ current: (((found.current + delta) % count) + count) % count }),
    );
  };

/** The current match becomes the one that holds the caret, or the one just after it. */
const anchoredAt =
  (selection: Selection) =>
  (found: Found): Found =>
    pipe(
      indexAtSelection(selection, found.matches),
      Option.match({
        onNone: () => found,
        onSome: (current) => pipe(found, Struct.assign({ current })),
      }),
    );

const currentMatchOf: (hits: Hits) => Option.Option<FindMatch> = Hits.$match({
  None: () => Option.none(),
  Found: ({ matches, current }) => pipe(matches, Array.get(current)),
});

/**
 * Where a commit lands: on the match that the user was looking at, or on the
 * first match when nothing was current.
 */
const commitAnchor: (hits: Hits) => number = Hits.$match({
  None: () => 0,
  Found: ({ current }) => current,
});

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/**
 * The way that `n` moves through the matches, and the words of the prompt
 * that sets it.
 *
 * `?` turns `n` around for the whole session, exactly as in Vim.
 */
interface Heading {
  readonly step: 1 | -1;
  readonly label: string;
  /** A screen reader cannot read "/" as a name for the field. */
  readonly ariaLabel: string;
  readonly indicator: string;
}

const FORWARD: Heading = {
  step: 1,
  label: "/",
  ariaLabel: "Find on the page",
  indicator: "Find",
};

const BACKWARD: Heading = {
  step: -1,
  label: "?",
  ariaLabel: "Find backwards on the page",
  indicator: "Find (backwards)",
};

const headingOf: (backwards: boolean) => Heading = Boolean.match({
  onFalse: () => FORWARD,
  onTrue: () => BACKWARD,
});

/**
 * Where history cycling stands.
 *
 * Slot 0 is the draft: the text that the user typed before the first step.
 * Slot `n` is entry `n - 1` of the history, which is newest first.
 */
interface Browsing {
  readonly slot: number;
  readonly draft: string;
}

const NOT_BROWSING: Browsing = { slot: 0, draft: "" };

/**
 * One step of `delta` through `history`, from a field that holds `typed`.
 *
 * The draft is kept when a step leaves it, so that a step back down gives it
 * back. A step below the draft goes nowhere, and gives no text.
 */
const browse =
  (history: Array.NonEmptyReadonlyArray<string>, delta: number, typed: string) =>
  (browsing: Browsing): readonly [Option.Option<string>, Browsing] => {
    const draft = pipe(
      browsing.slot === 0,
      Boolean.match({
        onTrue: () => typed,
        onFalse: () => browsing.draft,
      }),
    );
    return pipe(
      browsing.slot + delta,
      Option.liftPredicate((slot) => slot >= 0),
      Option.map((slot) => Math.min(slot, history.length)),
      Option.match({
        onNone: () => [Option.none(), { slot: browsing.slot, draft }] as const,
        onSome: (slot) =>
          [pipe(history, Array.prepend(draft), Array.get(slot)), { slot, draft }] as const,
      }),
    );
  };

/**
 * The step through the history that a key asks for.
 *
 * `<c-p>` and `<c-n>` are other names for the arrow keys, for the reason that
 * readline has them: the arrow keys are far from the home row.
 */
const historyStep = (event: KeyboardEvent): Option.Option<number> =>
  pipe(
    Match.value(event),
    Match.when({ key: "ArrowUp" }, () => 1),
    Match.when({ key: "ArrowDown" }, () => -1),
    Match.when({ ctrlKey: true, key: "p" }, () => 1),
    Match.when({ ctrlKey: true, key: "n" }, () => -1),
    Match.option,
  );

/** Our own HUD input. It lives in our realm, so `instanceof` answers for it. */
const isInput = (target: EventTarget | null): target is HTMLInputElement =>
  target instanceof HTMLInputElement;

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

interface ScrollPosition {
  readonly x: number;
  readonly y: number;
}

/** The live highlight overlay, and the scope that owns it. */
interface LiveHighlight {
  readonly scope: Scope.Closeable;
  readonly highlighter: Highlighter;
}

/** Does any part of `rect` lie inside the viewport? */
const isInView = (
  rect: DOMRect,
  viewport: { readonly width: number; readonly height: number },
): boolean =>
  rect.bottom >= 0 && rect.top <= viewport.height && rect.right >= 0 && rect.left <= viewport.width;

export class Find extends Context.Service<
  Find,
  {
    readonly enter: (options: { readonly backwards: boolean }) => Effect.Effect<void>;
    /** `n` and `N`. */
    readonly step: (count: number) => Effect.Effect<void>;
    /** `*` and `#`. */
    readonly searchWordUnderCursor: (direction: 1 | -1) => Effect.Effect<void>;
    readonly clear: Effect.Effect<void>;
  }
>()("vimium/features/find/Find") {
  static readonly layer: Layer.Layer<
    Find,
    never,
    Dom | Ui | Hud | Settings | Modes | Commands | Report | Capabilities | Storage
  > = Layer.effect(
    Find,
    Effect.gen(function* () {
      const dom = yield* Dom;
      const ui = yield* Ui;
      const hud = yield* Hud;
      const settings = yield* Settings;
      const modes = yield* Modes;
      const commands = yield* Commands;
      const report = yield* Report;
      const capabilities = yield* Capabilities;
      const storage = yield* Storage;

      const doc = dom.document;
      const win = dom.window;

      // The services that the highlighter needs, captured once. The overlay is
      // built in a scope of its own, and that scope is not the layer scope, so
      // the context must travel with it.
      const overlayServices = yield* Effect.context<Dom | Ui>();

      // -- state ---------------------------------------------------------

      /**
       * The text runs of the page.
       *
       * They are collected once for each *session*, and not once for each
       * keystroke. The walk is the expensive half, because it reaches into
       * layout for every element, and a walk on every character makes an
       * incremental find unusable on a large document.
       */
      const runs = yield* Ref.make(NO_RUNS);
      const hits = yield* Ref.make(NO_HITS);
      const query = yield* Ref.make<Option.Option<ParsedFindQuery>>(Option.none());
      const heading = yield* Ref.make(FORWARD);
      const highlight = yield* Ref.make<Option.Option<LiveHighlight>>(Option.none());
      /** The scope of the mode that lives on after Enter. */
      const postScope = yield* Ref.make<Option.Option<Scope.Closeable>>(Option.none());
      const sessionFiber = yield* FiberHandle.make<void, never>();

      // -- the browser ---------------------------------------------------

      const selection: Effect.Effect<Option.Option<Selection>> = dom.probeOr(
        () => Option.fromNullishOr(win.getSelection()),
        Option.none<Selection>(),
      );

      /** Read the selection inside `dom.probeOr`. No selection gives `fallback`. */
      const probeSelection = <A>(
        read: (selection: Selection) => A,
        fallback: A,
      ): Effect.Effect<A> =>
        pipe(
          selection,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(fallback),
              onSome: (target) => dom.probeOr(() => read(target), fallback),
            }),
          ),
        );

      const readScroll: Effect.Effect<ScrollPosition> = dom.probeOr(
        () => ({ x: win.scrollX, y: win.scrollY }),
        { x: 0, y: 0 },
      );

      // `instant`, because a restore is a jump. The smooth scrolling of Safari
      // cannot be cancelled, so it would fight the next command.
      const restoreScroll = (position: ScrollPosition): Effect.Effect<void> =>
        dom.probeOr(
          () => win.scrollTo({ left: position.x, top: position.y, behavior: "instant" }),
          undefined,
        );

      // -- the highlight overlay -----------------------------------------

      const ensureStyles = ui.setStyle(FIND_STYLE_KEY, FIND_CSS);

      /** Take the whole overlay away. */
      const closeHighlight = pipe(
        highlight,
        Ref.getAndSet(Option.none<LiveHighlight>()),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (live) => Scope.close(live.scope, Exit.void),
          }),
        ),
      );

      /** Hide every rectangle, and keep the overlay for the next search. */
      const hideHighlight = pipe(
        Ref.get(highlight),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (live) => live.highlighter.clear,
          }),
        ),
      );

      const buildHighlight = Effect.gen(function* () {
        yield* ensureStyles;
        const scope = yield* Scope.make();
        const highlighter = yield* pipe(
          makeHighlighter,
          Effect.provideContext(overlayServices),
          Scope.provide(scope),
        );
        yield* pipe(highlight, Ref.set(Option.some({ scope, highlighter })));
        return highlighter;
      });

      /**
       * The highlighter, built on first use.
       *
       * It lives in a scope of its own, so that `clear` can take the whole
       * overlay away and a later search can build a new one.
       */
      const ensureHighlight = Effect.fn("Find.ensureHighlight")(function* () {
        const live = yield* Ref.get(highlight);
        return yield* pipe(
          live,
          Option.match({
            onSome: (live) => Effect.succeed(live.highlighter),
            onNone: () => buildHighlight,
          }),
        );
      });

      const draw = Effect.fn("Find.draw")(function* () {
        const latest = yield* Ref.get(hits);
        yield* pipe(
          latest,
          Hits.$match({
            None: () => hideHighlight,
            Found: ({ matches, current }) =>
              pipe(
                ensureHighlight(),
                Effect.flatMap((highlighter) => highlighter.render(matches, current)),
              ),
          }),
        );
      });

      /**
       * Drop the matches, the runs and the overlay. The query stays, so `n`
       * still works afterwards.
       */
      const clearState = Effect.gen(function* () {
        yield* closeHighlight;
        yield* pipe(runs, Ref.set(NO_RUNS));
        yield* pipe(hits, Ref.set(NO_HITS));
      });

      /**
       * Hold the matches for the enclosing scope.
       *
       * A match holds a live `Range`, and a `Range` pins the nodes at its two
       * boundaries. One session measured 4001 detached nodes and up to 500 live
       * ranges, and they survived every soft navigation after it. The finalizer
       * is what gives them back, so no caller has to remember a teardown call.
       */
      const holdMatches: Effect.Effect<void, never, Scope.Scope> = Effect.addFinalizer(
        () => clearState,
      );

      // -- searching -----------------------------------------------------

      /**
       * Walk the document again.
       *
       * Once for each session, and not once for each keystroke.
       */
      const refreshRuns = Effect.fn("Find.refreshRuns")(function* () {
        const collected = yield* dom.probeOr<ReadonlyArray<TextRun>>(
          () =>
            collectTextRuns({
              view: win,
              document: doc,
              capabilities,
              excludeHost: Option.some(ui.shadow.host),
              maxCharacters: DEFAULT_MAX_CHARACTERS,
            }),
          [],
        );
        yield* pipe(runs, Ref.set(collected));
      });

      /**
       * The matches of `parsed` in the runs that are already collected. A
       * query that does not compile finds nothing.
       */
      const runQuery = (parsed: ParsedFindQuery): Effect.Effect<RunSearch> =>
        pipe(
          toRegExp(parsed),
          Option.match({
            onNone: () => Effect.succeed(NOTHING_FOUND),
            onSome: (pattern) =>
              pipe(
                Ref.get(runs),
                Effect.flatMap((collected) =>
                  dom.probeOr(() => matchesInRuns(doc, collected, pattern), NOTHING_FOUND),
                ),
              ),
          }),
        );

      /**
       * Run `raw` against the runs that are already collected, and draw again.
       *
       * `anchor` is where the caller would like to land. It is used so that one
       * more character does not throw away the match that the user was already
       * looking at.
       */
      const search = Effect.fn("Find.search")(function* (
        raw: string,
        anchor: Option.Option<number>,
      ) {
        // `currentUnsafe`, because this runs inside the `keydown` of the
        // prompt, and nothing on that path may suspend.
        const parsed = parseFindQuery(raw, {
          regexFindMode: settings.currentUnsafe().regexFindMode,
        });
        yield* pipe(query, Ref.set(Option.some(parsed)));
        const found = yield* runQuery(parsed);
        const latest = hitsOf(found, anchor);
        yield* pipe(hits, Ref.set(latest));
        yield* draw();
        return outcomeOf(parsed, found, latest);
      });

      /**
       * The matches of the last search. With none, the document is walked
       * again and searched again first, because it may have changed since.
       */
      const liveHits = (raw: string): Effect.Effect<Hits> =>
        pipe(
          Ref.get(hits),
          Effect.flatMap(
            Hits.$match({
              Found: (found) => Effect.succeed<Hits>(found),
              None: () =>
                pipe(
                  refreshRuns(),
                  Effect.andThen(search(raw, Option.none())),
                  Effect.andThen(Ref.get(hits)),
                ),
            }),
          ),
        );

      /**
       * Put the current match in the selection of the document.
       *
       * This happens on a commit only. It is what lets `y`, visual mode and the
       * own ⌘C of the user continue from where find stopped.
       */
      const selectCurrent = Effect.fn("Find.selectCurrent")(function* () {
        const match = yield* pipe(Ref.get(hits), Effect.map(currentMatchOf));
        const target = yield* selection;
        yield* pipe(
          Option.all({ match, target }),
          Option.match({
            onNone: () => Effect.void,
            // Ignored: Safari refuses a range inside a shadow tree, and the
            // overlay still shows the user where the match is.
            onSome: ({ match, target }) =>
              pipe(
                dom.attempt("Selection.addRange", () => {
                  target.removeAllRanges();
                  target.addRange(match.range.cloneRange());
                }),
                Effect.ignore,
              ),
          }),
        );
      });

      /**
       * Bring `range` into view, and draw again.
       *
       * Each scroll runs only while the match is still out of view. A read or
       * a scroll that throws stops the rest, and nothing is drawn.
       */
      const reveal = Effect.fn("Find.reveal")(
        function* (range: Range) {
          const viewport = yield* ui.viewport;
          const outOfView = dom.attempt(
            "Range.getBoundingClientRect",
            () => !isInView(range.getBoundingClientRect(), viewport),
          );

          // `scrollIntoView` on the element that holds the match comes first.
          // It is the only thing that understands a nested scroll container
          // without us writing one again.
          yield* pipe(
            dom.attempt("Element.scrollIntoView", () =>
              pipe(
                elementAt(range.startContainer),
                Option.match({
                  onNone: constVoid,
                  onSome: (anchor) =>
                    anchor.scrollIntoView({
                      block: "center",
                      inline: "nearest",
                      behavior: "instant",
                    }),
                }),
              ),
            ),
            Effect.when(outOfView),
          );

          // The element can be much larger than the match, for example a whole
          // article. Correct the rest against the rectangle of the range.
          yield* pipe(
            dom.attempt("Window.scrollBy", () =>
              win.scrollBy({
                top: range.getBoundingClientRect().top - viewport.height / 3,
                left: 0,
                behavior: "instant",
              }),
            ),
            Effect.when(outOfView),
          );

          yield* draw();
        },
        Effect.catchTag("DomError", () => Effect.void),
      );

      /**
       * Bring the current match into view.
       *
       * `behavior: "instant"` everywhere. The smooth scrolling of Safari cannot
       * be cancelled, so a user who holds `n` would queue a second of animation
       * that they cannot stop.
       */
      const scrollToCurrent = Effect.fn("Find.scrollToCurrent")(function* () {
        const match = yield* pipe(Ref.get(hits), Effect.map(currentMatchOf));
        yield* pipe(
          match,
          Option.match({
            onNone: () => Effect.void,
            onSome: ({ range }) => reveal(range),
          }),
        );
      });

      /** `n` and `N` over matches that exist. The search wraps, as it does in Vim. */
      const stepBy = Effect.fn("Find.stepBy")(function* (found: Found, delta: number) {
        const moved = stepped(delta)(found);
        yield* pipe(hits, Ref.set<Hits>(moved));
        yield* draw();
        yield* scrollToCurrent();
        return moved;
      });

      /** Select the current match, and say where it is. */
      const showMatch = Effect.fn("Find.showMatch")(function* (found: Found, prefix: string) {
        yield* selectCurrent();
        yield* hud.show(`${prefix}${statusText(matchesOutcome(found))}`, BRIEFLY);
      });

      // -- the mode that lives on after Enter -----------------------------

      const closePost = pipe(
        postScope,
        Ref.getAndSet(Option.none<Scope.Closeable>()),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (scope) => Scope.close(scope, Exit.void),
          }),
        ),
      );

      /**
       * The mode that lives on after Enter.
       *
       * Ported from the `mode_post_find.js` of Vimium, without the handling of
       * an editable element: upstream goes into insert mode when the match
       * lands in a text field, and a feature here does not call another
       * feature. The highlights stay until Escape, a click or a change of
       * focus.
       */
      const enterPost = Effect.fn("Find.enterPost")(function* () {
        yield* closePost;
        const scope = yield* Scope.make();
        const handle = yield* pipe(
          // The matches belong to this scope. A `Range` for each match holds
          // the nodes at its boundaries, and this is what gives them back.
          holdMatches,
          Effect.andThen(
            modes.enter(
              {
                name: "post-find",
                indicator: Option.none(),
                exitOn: [ExitTrigger.Escape(), ExitTrigger.Click(), ExitTrigger.Focus()],
                keyboard: KeyPolicy.Shared(),
                singleton: Option.some("find"),
              },
              {
                // Everything except Escape, which the mode itself takes,
                // belongs to the page and to the key trie of normal mode, so
                // that `n` and `N` keep working.
                keydown: (): Effect.Effect<HandlerResult> => Effect.succeed(CONTINUE_BUBBLING),
              },
            ),
          ),
          Scope.provide(scope),
        );
        // The scope owns the mode, and the mode now owns the scope. An exit
        // for any reason therefore closes the scope, and a defect exit leaves
        // no scope that only the next `closePost` would release. The scope is
        // stored first, because `onExit` runs its body at once when the mode
        // already exited.
        yield* pipe(postScope, Ref.set(Option.some(scope)));
        yield* handle.onExit(() => pipe(clearState, Effect.andThen(closePost)));
      });

      /** Open the mode again when nothing holds the highlights. */
      const ensurePost = Effect.fn("Find.ensurePost")(function* () {
        const scope = yield* Ref.get(postScope);
        const names = yield* modes.activeNames;
        const live = pipe(
          scope,
          Option.exists(() => pipe(names, Array.contains("post-find"))),
        );
        yield* pipe(
          live,
          Boolean.match({
            onTrue: () => Effect.void,
            onFalse: () => enterPost(),
          }),
        );
      });

      // -- the prompt ----------------------------------------------------

      const showStatus = Effect.fn("Find.showStatus")(function* (outcome: SearchOutcome) {
        const status = statusText(outcome);
        // The line stays until the next message. The count is a live status,
        // and not an announcement.
        const live = () => hud.show(status, HudDuration.Sticky());
        yield* pipe(
          outcome,
          SearchOutcome.$match({
            // Rule: a failure that the user must see goes through `Report`.
            BadPattern: () => report.error(status),
            NoQuery: live,
            NoMatches: live,
            Matches: live,
          }),
        );
      });

      const runIncremental = Effect.fn("Find.runIncremental")(function* (value: string) {
        const outcome = yield* search(value, Option.none());
        yield* showStatus(outcome);
        yield* scrollToCurrent();
      });

      /**
       * Build the options of the HUD prompt for one session.
       *
       * History cycling writes straight into `event.target`. That looks like a
       * break of the layers, and it is a deliberate one: `onKeydown` can only
       * *take* a key, and it cannot change the text of the field, and the field
       * is our own element inside our own closed shadow root. Widening the
       * interface of the HUD for one feature would cost more.
       */
      const promptOptions = Effect.fn("Find.promptOptions")(function* (
        prompt: Heading,
        history: ReadonlyArray<string>,
      ) {
        const browsing = yield* Ref.make(NOT_BROWSING);

        const applyHistory = (
          input: HTMLInputElement,
          entries: Array.NonEmptyReadonlyArray<string>,
          delta: number,
          value: string,
        ): Effect.Effect<void> =>
          pipe(
            browsing,
            Ref.modify(browse(entries, delta, value)),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (entry) =>
                  pipe(
                    Effect.sync(() => {
                      input.value = entry;
                    }),
                    // The `input` listener of the HUD does not fire for a
                    // write from a script, so the incremental search is
                    // started by hand.
                    Effect.andThen(runIncremental(entry)),
                  ),
              }),
            ),
          );

        /** A history key that is aimed at our own input is taken, even with no history. */
        const takeHistoryKey = (
          event: KeyboardEvent,
          delta: number,
          value: string,
        ): Effect.Effect<KeyClaim> =>
          pipe(
            event.target,
            Option.liftPredicate(isInput),
            Option.match({
              onNone: () => Effect.succeed(KeyClaim.Pass()),
              onSome: (input) =>
                pipe(
                  history,
                  Array.match({
                    onEmpty: () => Effect.void,
                    onNonEmpty: (entries) => applyHistory(input, entries, delta, value),
                  }),
                  Effect.as(KeyClaim.Taken()),
                ),
            }),
          );

        return {
          label: prompt.label,
          ariaLabel: prompt.ariaLabel,
          placeholder: "search",
          onInput: runIncremental,
          onKeydown: (event: KeyboardEvent, value: string) =>
            pipe(
              historyStep(event),
              Option.match({
                onNone: () => Effect.succeed(KeyClaim.Pass()),
                onSome: (delta) => takeHistoryKey(event, delta, value),
              }),
            ),
        } satisfies HudPromptOptions;
      });

      /**
       * Give the key to our own HUD input, and swallow everything else.
       *
       * `PASS_EVENT_TO_PAGE` stops the walk of the stack without touching the
       * event, which is exactly "our input types this, and nothing else acts".
       * A listener of the page on `document` still sees the key, retargeted to
       * our shadow host. Without an iframe of our own origin there is no way to
       * prevent that.
       *
       * The mode must claim these keys. The key bridge listens on `window` in
       * the capture phase, so it sees every keystroke before the capture
       * listener of the HUD input can stop it. Without a handler here, typing
       * `hemisphere` into the find field would run `h`, `m`, `i` and `s` as
       * commands.
       */
      const passIfOurs = (event: KeyboardEvent): Effect.Effect<HandlerResult> =>
        pipe(
          hud.ownsFocus(event.target),
          Boolean.match({
            onTrue: () => PASS_EVENT_TO_PAGE,
            onFalse: () => SUPPRESS_EVENT,
          }),
          Effect.succeed,
        );

      /**
       * Stop insert mode, which sits below us, from reading focus on our own
       * input as the page asking for insert mode.
       */
      const claimOurFocus = (event: FocusEvent): Effect.Effect<HandlerResult> =>
        pipe(
          hud.ownsFocus(event.target),
          Boolean.match({
            onTrue: () => SUPPRESS_PROPAGATION,
            onFalse: () => CONTINUE_BUBBLING,
          }),
          Effect.succeed,
        );

      const promptSession = Effect.fn("Find.promptSession")(function* (prompt: Heading) {
        const committed = yield* Ref.make(false);
        const snapshot = yield* readScroll;

        // The one place that undoes what a cancelled search disturbed. It
        // runs for Escape, for a blur, and for an interruption from `clear`
        // or from a second `enter`.
        const undo = pipe(
          clearState,
          Effect.andThen(restoreScroll(snapshot)),
          Effect.andThen(hud.hide),
        );
        yield* Effect.addFinalizer(() =>
          pipe(
            Ref.get(committed),
            Effect.flatMap(
              Boolean.match({
                onTrue: () => Effect.void,
                onFalse: () => undo,
              }),
            ),
          ),
        );

        yield* pipe(heading, Ref.set(prompt));
        yield* ensureStyles;
        // The mode that lives on holds the same singleton group, and its exit
        // body clears the state. It is closed first, so that the walk below
        // is not thrown away.
        yield* closePost;
        yield* clearState;

        const handle = yield* modes.enter(
          {
            name: "find",
            indicator: Option.some(prompt.indicator),
            // The HUD input owns Escape: it has to settle the prompt, and an
            // exit at the level of the mode would leave the prompt open.
            exitOn: [],
            keyboard: KeyPolicy.Shared(),
            singleton: Option.some("find"),
          },
          {
            keydown: passIfOurs,
            keypress: passIfOurs,
            keyup: passIfOurs,
            focus: claimOurFocus,
          },
        );

        yield* refreshRuns();

        const { queries } = yield* storage.findHistory.current;
        const options = yield* promptOptions(prompt, queries);

        // A mode can also end without the user: `exitAll` runs on a soft
        // navigation. The prompt must not stay open and hold the keyboard.
        const abandoned = yield* Deferred.make<void>();
        yield* handle.onExit(() =>
          pipe(abandoned, Deferred.succeed<void>(undefined), Effect.asVoid),
        );

        const abandonment = pipe(Deferred.await(abandoned), Effect.as(Option.none<string>()));
        const answer = yield* pipe(hud.prompt(options), Effect.race(abandonment));

        yield* pipe(committed, Ref.set(Option.isSome(answer)));
        return answer;
      });

      /**
       * Save `text` in the history.
       *
       * Detached, because the group waits for its own debounce before the
       * write completes. The user must not wait half a second for the
       * highlight.
       */
      const rememberQuery = (text: string): Effect.Effect<void> =>
        pipe(
          storage.findHistory.update((history) => ({
            queries: Array.copy(pushHistory(history.queries, text)),
          })),
          Effect.catch((error) => report.error(`Could not save the search: ${error.detail}`)),
          Effect.forkDetach,
          Effect.asVoid,
        );

      const noMatchesFor = (text: string): Effect.Effect<void> =>
        pipe(hud.show(`No matches for "${text}"`, BRIEFLY), Effect.andThen(clearState));

      /**
       * Settle on the current match.
       *
       * The match stays selected. That is what lets `n`, `N`, `y` and visual
       * mode all continue from where find stopped.
       */
      const settle = Effect.fn("Find.settle")(function* (outcome: SearchOutcome) {
        yield* scrollToCurrent();
        yield* selectCurrent();
        yield* hud.show(statusText(outcome), BRIEFLY);
        yield* enterPost();
      });

      const commitQuery = Effect.fn("Find.commitQuery")(function* (text: string) {
        yield* rememberQuery(text);
        const anchor = yield* pipe(Ref.get(hits), Effect.map(commitAnchor));
        const outcome = yield* search(text, Option.some(anchor));
        yield* hud.hide;
        yield* pipe(
          outcome,
          SearchOutcome.$match({
            BadPattern: () => pipe(report.error(statusText(outcome)), Effect.andThen(clearState)),
            NoQuery: () => noMatchesFor(text),
            NoMatches: () => noMatchesFor(text),
            Matches: () => settle(outcome),
          }),
        );
      });

      const commit = Effect.fn("Find.commit")(function* (raw: string) {
        yield* pipe(
          raw.trim(),
          Option.liftPredicate((trimmed) => trimmed.length > 0),
          Option.match({
            onNone: () => pipe(clearState, Effect.andThen(hud.hide)),
            onSome: commitQuery,
          }),
        );
      });

      const runSession = Effect.fn("Find.runSession")(function* (prompt: Heading) {
        const answer = yield* pipe(promptSession(prompt), Effect.scoped);
        yield* pipe(
          answer,
          Option.match({
            onNone: () => Effect.void,
            onSome: commit,
          }),
        );
      });

      /** Land on the match *after* the caret, and not on the one under it. */
      const landAfterCaret = Effect.fn("Find.landAfterCaret")(function* (
        found: Found,
        word: string,
        direction: 1 | -1,
      ) {
        const target = yield* selection;
        const anchored = pipe(
          target,
          Option.map((target) => anchoredAt(target)(found)),
          Option.getOrElse(() => found),
        );
        const moved = yield* stepBy(anchored, direction);
        yield* showMatch(moved, `${word}  `);
        yield* enterPost();
      });

      const searchWord = Effect.fn("Find.searchWord")(function* (
        word: string,
        parsed: ReadyFindQuery,
        direction: 1 | -1,
      ) {
        yield* ensureStyles;
        yield* closePost;
        yield* clearState;
        yield* refreshRuns();
        // `*` and `#` set the direction outright. Upstream does the same, and
        // it is what makes a following `n` continue the way that the user
        // just went.
        yield* pipe(heading, Ref.set(headingOf(direction < 0)));
        yield* search(parsed.raw, Option.none());
        const latest = yield* Ref.get(hits);
        yield* pipe(
          latest,
          Hits.$match({
            None: () => noMatchesFor(word),
            Found: (found) => landAfterCaret(found, word, direction),
          }),
        );
      });

      const stepQuery = Effect.fn("Find.stepQuery")(function* (
        last: ParsedFindQuery,
        count: number,
      ) {
        yield* ensureStyles;
        // The highlights need an owner. Without one they would stay on screen
        // with nothing left to take them away. The mode is opened before the
        // step, because opening it drops a mode that already ended, and that
        // release clears the matches.
        yield* ensurePost();
        const { step: sign } = yield* Ref.get(heading);
        const latest = yield* liveHits(last.raw);
        yield* pipe(
          latest,
          Hits.$match({
            None: () => hud.show(`No matches for "${last.raw}"`, BRIEFLY),
            Found: (found) =>
              pipe(
                stepBy(found, count * sign),
                Effect.flatMap((moved) => showMatch(moved, "")),
              ),
          }),
        );
      });

      // -- the public methods --------------------------------------------

      const enter = Effect.fn("Find.enter")(function* (options: { readonly backwards: boolean }) {
        // The old session is stopped *before* the new one reads the scroll
        // position. Its finalizer puts the old position back, and a new
        // snapshot taken first would be that old position.
        yield* FiberHandle.clear(sessionFiber);
        yield* pipe(
          runSession(headingOf(options.backwards)),
          FiberHandle.run(sessionFiber),
          Effect.asVoid,
        );
      });

      const step = Effect.fn("Find.step")(function* (count: number) {
        const last = yield* Ref.get(query);
        yield* pipe(
          last,
          Option.match({
            onNone: () => hud.show("No previous search", BRIEFLY),
            onSome: (parsed) => stepQuery(parsed, count),
          }),
        );
      });

      const searchWordUnderCursor = Effect.fn("Find.searchWordUnderCursor")(function* (
        direction: 1 | -1,
      ) {
        const word = yield* probeSelection(wordUnderCursor, "");
        const noWord = () => hud.show("No word under the cursor", BRIEFLY);
        yield* pipe(
          wordQuery(word),
          ParsedFindQuery.$match({
            Empty: noWord,
            Invalid: noWord,
            Ready: (parsed) => searchWord(word, parsed, direction),
          }),
        );
      });

      const clearAll = Effect.fn("Find.clear")(function* () {
        yield* FiberHandle.clear(sessionFiber);
        yield* closePost;
        yield* clearState;
        yield* hud.hide;
      });

      // The layer scope owns the session, the overlay and the mode that lives
      // on. Closing the runtime therefore takes every `Range` with it.
      yield* Effect.addFinalizer(() => pipe(closePost, Effect.andThen(clearState)));

      const service = Find.of({
        enter,
        step,
        searchWordUnderCursor,
        clear: clearAll(),
      });

      yield* commands.registerAll({
        enterFindMode: () => service.enter({ backwards: false }),
        performFind: ({ count }) => service.step(count),
        performBackwardsFind: ({ count }) => service.step(-count),
        searchWordForwards: () => service.searchWordUnderCursor(1),
        searchWordBackwards: () => service.searchWordUnderCursor(-1),
      });

      return service;
    }),
  );
}
