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
  Context,
  Deferred,
  Effect,
  Exit,
  FiberHandle,
  Layer,
  Option,
  Ref,
  Scope,
} from "effect";
import { Commands } from "~/core/Commands.ts";
import {
  CONTINUE_BUBBLING,
  type HandlerResult,
  PASS_EVENT_TO_PAGE,
  SUPPRESS_EVENT,
  SUPPRESS_PROPAGATION,
} from "~/core/HandlerStack.ts";
import { Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import {
  type ParsedFindQuery,
  parseFindQuery,
  toRegExp,
  wordQuery,
} from "~/domain/FindQuery.ts";
import { FIND_HISTORY_LIMIT } from "~/domain/Persisted.ts";
import { Capabilities } from "~/platform/Capabilities.ts";
import { Dom } from "~/platform/Dom.ts";
import { Storage } from "~/platform/Storage.ts";
import type { HudPromptOptions } from "~/ui/Hud.ts";
import { Hud } from "~/ui/Hud.ts";
import { Ui } from "~/ui/Ui.ts";
import {
  collectTextRuns,
  type FindMatch,
  firstMatchInView,
  indexAtSelection,
  matchesInRuns,
  type RunCollection,
  type RunSearch,
  type TextRun,
  wordUnderCursor,
} from "./Engine.ts";
import {
  FIND_CSS,
  FIND_STYLE_KEY,
  type Highlighter,
  makeHighlighter,
} from "./Highlight.ts";

// ---------------------------------------------------------------------------
// The result of one search
// ---------------------------------------------------------------------------

export interface SearchOutcome {
  readonly count: number;
  /**
   * The index of the current match, from zero.
   *
   * It is `-1` when there is none.
   */
  readonly index: number;
  readonly empty: boolean;
  readonly error: Option.Option<string>;
  /**
   * True when the search stopped before the end of the page.
   *
   * The time budget stops it, and so does a match that is longer than the
   * engine can read. The counts are then the counts of the text that was read,
   * and not of the page. The HUD says so, because a wrong `3/17` is worse than
   * no number.
   */
  readonly stopped: boolean;
}

const NO_QUERY: SearchOutcome = {
  count: 0,
  index: -1,
  empty: true,
  error: Option.none(),
  stopped: false,
};

/** `"3/17"`, `"No matches"`, or the message of the bad pattern. */
export const statusText = (outcome: SearchOutcome): string => {
  if (Option.isSome(outcome.error)) {
    return `Bad pattern: ${outcome.error.value}`;
  }
  if (outcome.empty) return "";
  const late = outcome.stopped ? "  (stopped before the end of the page)" : "";
  if (outcome.count === 0) return `No matches${late}`;
  return `${outcome.index + 1}/${outcome.count}${late}`;
};

/** Newest first, without a repeat, and capped. Pure, so the cap is testable. */
export const pushHistory = (
  history: ReadonlyArray<string>,
  query: string,
): ReadonlyArray<string> => {
  const trimmed = query.trim();
  if (trimmed.length === 0) return history;
  return [trimmed, ...history.filter((entry) => entry !== trimmed)]
    .slice(0, FIND_HISTORY_LIMIT);
};

const clampIndex = (index: number, count: number): number =>
  count === 0 ? -1 : Math.max(0, Math.min(index, count - 1));

/** The element that holds the start of a range, for `scrollIntoView`. */
const elementFor = (range: Range): Option.Option<Element> => {
  const container = range.startContainer;
  return Option.fromNullishOr(
    container instanceof Element ? container : container.parentElement,
  );
};

interface ScrollPosition {
  readonly x: number;
  readonly y: number;
}

/**
 * Where one scroll container stood before find moved it.
 *
 * `scrollIntoView` moves every ancestor that can scroll, and not only the
 * window. Escape must give each of them back.
 */
interface ScrollSnapshot {
  readonly element: Element;
  readonly left: number;
  readonly top: number;
}

/**
 * The containers between `element` and the page that can scroll.
 *
 * The walk crosses a shadow boundary through the host, because a match inside
 * an open shadow root has ancestors on both sides of it. `documentElement` and
 * `body` are left out: the window position is recorded on its own, and it is
 * the value that a restore must write.
 */
const scrollAncestors = (element: Element): ReadonlyArray<Element> => {
  const found: Element[] = [];
  let node: Node | null = element;
  while (node !== null) {
    if (
      node instanceof Element && node !== node.ownerDocument?.documentElement &&
      node !== node.ownerDocument?.body &&
      (node.scrollHeight > node.clientHeight + 1 ||
        node.scrollWidth > node.clientWidth + 1)
    ) {
      found.push(node);
    }
    const parent: Node | null = node.parentNode;
    node = parent === null
      ? null
      : parent instanceof ShadowRoot
      ? parent.host
      : parent;
  }
  return found;
};

/** The live highlight overlay, and the scope that owns it. */
interface LiveHighlight {
  readonly scope: Scope.Closeable;
  readonly highlighter: Highlighter;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Find extends Context.Service<Find, {
  readonly enter: (
    options: { readonly backwards: boolean },
  ) => Effect.Effect<void>;
  /** `n` and `N`. */
  readonly step: (count: number) => Effect.Effect<void>;
  /** `*` and `#`. */
  readonly searchWordUnderCursor: (
    direction: 1 | -1,
  ) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}>()("vimium/features/find/Find") {
  static readonly layer: Layer.Layer<
    Find,
    never,
    | Dom
    | Ui
    | Hud
    | Settings
    | Modes
    | Commands
    | Report
    | Capabilities
    | Storage
  > = Layer.effect(
    Find,
    Effect.gen(function*() {
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
      const runs = yield* Ref.make<ReadonlyArray<TextRun>>([]);
      const matches = yield* Ref.make<ReadonlyArray<FindMatch>>([]);
      const current = yield* Ref.make(-1);
      const query = yield* Ref.make<Option.Option<ParsedFindQuery>>(
        Option.none(),
      );
      /** `?` turns `n` around for the whole session, exactly as in Vim. */
      const backwards = yield* Ref.make(false);
      const highlight = yield* Ref.make<Option.Option<LiveHighlight>>(
        Option.none(),
      );
      /** The scope of the mode that lives on after Enter. */
      const postScope = yield* Ref.make<Option.Option<Scope.Closeable>>(
        Option.none(),
      );
      /**
       * Did the last search stop before the end of the page?
       *
       * `n` and `N` do not search again, so they must report the stop of the
       * search that gave them their matches. A count that is partial stays
       * partial.
       */
      const partial = yield* Ref.make(false);
      /**
       * Did the walk of the page stop before its end?
       *
       * The character budget and the time budget both stop it. Every search
       * that reads those runs is then partial, however fast the match is.
       */
      const runsPartial = yield* Ref.make(false);
      /**
       * Where each nested container stood before find moved it.
       *
       * The list is written the first time that find is about to scroll for a
       * match, and the first value for one container is kept. A cancel puts
       * every container back, and a commit keeps what the user now sees.
       */
      const scrolled = yield* Ref.make<ReadonlyArray<ScrollSnapshot>>([]);
      const sessionFiber = yield* FiberHandle.make<void, never>();

      // -- the browser ---------------------------------------------------

      const selection: Effect.Effect<Option.Option<Selection>> = dom.probeOr(
        () => Option.fromNullishOr(win.getSelection()),
        Option.none<Selection>(),
      );

      const readScroll: Effect.Effect<ScrollPosition> = dom.probeOr(
        () => ({ x: win.scrollX, y: win.scrollY }),
        { x: 0, y: 0 },
      );

      const restoreScroll = (position: ScrollPosition): Effect.Effect<void> =>
        Effect.asVoid(dom.probeOr(() => {
          // `instant`, because a restore is a jump. The smooth scrolling of
          // Safari cannot be cancelled, so it would fight the next command.
          win.scrollTo({
            left: position.x,
            top: position.y,
            behavior: "instant",
          });
          return true;
        }, false));

      const forgetScrollAncestors = Ref.set(scrolled, []);

      /**
       * Record every container that the next scroll can move.
       *
       * It runs before the scroll, and it keeps the value that a container had
       * when find first touched it. A container that find moves twice is
       * therefore restored to where the user left it, and not to where the
       * search before the last one put it.
       */
      const recordScrollAncestors = Effect.fn("Find.recordScrollAncestors")(
        function*(element: Element) {
          const seen = yield* dom.probeOr<ReadonlyArray<ScrollSnapshot>>(
            () =>
              scrollAncestors(element).map((node) => ({
                element: node,
                left: node.scrollLeft,
                top: node.scrollTop,
              })),
            [],
          );
          if (seen.length === 0) return;
          yield* Ref.update(scrolled, (current) => {
            const merged = [...current];
            for (const snapshot of seen) {
              const known = merged.some((entry) =>
                entry.element === snapshot.element
              );
              if (!known) merged.push(snapshot);
            }
            return merged;
          });
        },
      );

      /** Put every recorded container back, innermost first. */
      const restoreScrollAncestors = Effect.gen(function*() {
        const snapshots = yield* Ref.getAndSet(scrolled, []);
        if (snapshots.length === 0) return;
        yield* dom.probeOr(() => {
          for (const snapshot of snapshots) {
            snapshot.element.scrollLeft = snapshot.left;
            snapshot.element.scrollTop = snapshot.top;
          }
          return true;
        }, false);
      });

      // -- the highlight overlay -----------------------------------------

      const ensureStyles = ui.setStyle(FIND_STYLE_KEY, FIND_CSS);

      const closeHighlight = Effect.gen(function*() {
        const live = yield* Ref.getAndSet(highlight, Option.none());
        if (Option.isSome(live)) {
          yield* Scope.close(live.value.scope, Exit.void);
        }
      });

      /**
       * The highlighter, built on first use.
       *
       * It lives in a scope of its own, so that `clear` can take the whole
       * overlay away and a later search can build a new one.
       */
      const ensureHighlight = Effect.fn("Find.ensureHighlight")(function*() {
        const live = yield* Ref.get(highlight);
        if (Option.isSome(live)) return live.value.highlighter;
        yield* ensureStyles;
        const scope = yield* Scope.make();
        const highlighter = yield* Effect.provideService(
          Effect.provideContext(makeHighlighter, overlayServices),
          Scope.Scope,
          scope,
        );
        yield* Ref.set(highlight, Option.some({ scope, highlighter }));
        return highlighter;
      });

      const draw = Effect.fn("Find.draw")(function*() {
        const found = yield* Ref.get(matches);
        if (found.length === 0) {
          const live = yield* Ref.get(highlight);
          if (Option.isSome(live)) yield* live.value.highlighter.clear;
          return;
        }
        const highlighter = yield* ensureHighlight();
        yield* highlighter.render(found, yield* Ref.get(current));
      });

      /**
       * Drop the matches, the runs and the overlay. The query stays, so `n`
       * still works afterwards.
       */
      const clearState = Effect.gen(function*() {
        yield* closeHighlight;
        yield* Ref.set(runs, []);
        yield* Ref.set(matches, []);
        yield* Ref.set(current, -1);
        yield* Ref.set(partial, false);
        yield* Ref.set(runsPartial, false);
      });

      /**
       * Hold the matches for the enclosing scope.
       *
       * A match holds a live `Range`, and a `Range` pins the nodes at its two
       * boundaries. One session measured 4001 detached nodes and up to 500 live
       * ranges, and they survived every soft navigation after it. The release
       * step is what gives them back, so no caller has to remember a teardown
       * call.
       */
      const holdMatches: Effect.Effect<void, never, Scope.Scope> = Effect
        .asVoid(
          Effect.acquireRelease(Ref.get(matches), () => clearState),
        );

      // -- searching -----------------------------------------------------

      /**
       * Walk the document again.
       *
       * Once for each session, and not once for each keystroke.
       */
      const refreshRuns = Effect.fn("Find.refreshRuns")(function*() {
        const collected = yield* dom.probeOr<RunCollection>(
          () =>
            collectTextRuns({
              view: win,
              document: doc,
              capabilities,
              excludeHost: Option.some(ui.shadow.host),
            }),
          { runs: [], stopped: false },
        );
        yield* Ref.set(runs, collected.runs);
        yield* Ref.set(runsPartial, collected.stopped);
      });

      /**
       * Run `raw` against the runs that are already collected, and draw again.
       *
       * `anchor` is where the caller would like to land. It is used so that one
       * more character does not throw away the match that the user was already
       * looking at.
       */
      const search = Effect.fn("Find.search")(
        function*(raw: string, anchor: Option.Option<number>) {
          // `currentUnsafe`, because this runs inside the `keydown` of the
          // prompt, and nothing on that path may suspend.
          const parsed = parseFindQuery(raw, {
            regexFindMode: settings.currentUnsafe().regexFindMode,
          });
          yield* Ref.set(query, Option.some(parsed));

          if (parsed.isEmpty || Option.isSome(parsed.error)) {
            yield* Ref.set(matches, []);
            yield* Ref.set(current, -1);
            yield* Ref.set(partial, false);
            yield* draw();
            return parsed.isEmpty ? NO_QUERY : {
              count: 0,
              index: -1,
              empty: false,
              error: parsed.error,
              stopped: false,
            };
          }

          const pattern = toRegExp(parsed);
          const collected = yield* Ref.get(runs);
          const search = Option.isNone(pattern)
            ? { matches: [] as ReadonlyArray<FindMatch>, stopped: false }
            : yield* dom.probeOr<RunSearch>(
              () => matchesInRuns(doc, collected, pattern.value),
              { matches: [], stopped: false },
            );
          const found = search.matches;
          // The walk of the page is the other half of the count. A search that
          // read every run of a page that was only half collected is still a
          // partial answer, and the HUD must say so.
          const stopped = search.stopped || (yield* Ref.get(runsPartial));

          yield* Ref.set(matches, found);
          yield* Ref.set(partial, stopped);
          yield* Ref.set(
            current,
            found.length === 0 ? -1 : clampIndex(
              Option.getOrElse(anchor, () => firstMatchInView(found)),
              found.length,
            ),
          );
          yield* draw();

          return {
            count: found.length,
            index: yield* Ref.get(current),
            empty: false,
            error: Option.none<string>(),
            stopped,
          };
        },
      );

      /** Run the last query again against a document that is walked again. */
      const research = Effect.fn("Find.research")(function*() {
        const last = yield* Ref.get(query);
        if (Option.isNone(last)) return NO_QUERY;
        yield* refreshRuns();
        return yield* search(last.value.raw, Option.none());
      });

      const currentMatch: Effect.Effect<Option.Option<FindMatch>> = Effect.gen(
        function*() {
          const found = yield* Ref.get(matches);
          return Option.fromNullishOr(found[yield* Ref.get(current)]);
        },
      );

      /**
       * Put the current match in the selection of the document.
       *
       * This happens on a commit only. It is what lets `y`, visual mode and the
       * own ⌘C of the user continue from where find stopped.
       */
      const selectCurrent = Effect.fn("Find.selectCurrent")(function*() {
        const match = yield* currentMatch;
        if (Option.isNone(match)) return;
        const target = yield* selection;
        if (Option.isNone(target)) return;
        // Ignored: Safari refuses a range inside a shadow tree, and the overlay
        // still shows the user where the match is.
        yield* Effect.ignore(dom.attempt("Selection.addRange", () => {
          target.value.removeAllRanges();
          target.value.addRange(match.value.range.cloneRange());
        }));
      });

      /**
       * Bring the current match into view.
       *
       * `behavior: "instant"` everywhere. The smooth scrolling of Safari cannot
       * be cancelled, so a user who holds `n` would queue a second of animation
       * that they cannot stop.
       */
      const scrollToCurrent = Effect.fn("Find.scrollToCurrent")(function*() {
        const match = yield* currentMatch;
        if (Option.isNone(match)) return;
        const range = match.value.range;
        const viewport = yield* ui.viewport;

        const inView = (): boolean => {
          const rect = range.getBoundingClientRect();
          return rect.bottom >= 0 && rect.top <= viewport.height &&
            rect.right >= 0 && rect.left <= viewport.width;
        };

        // The record comes before the move, and only when a move is needed.
        // `scrollIntoView` below moves every ancestor that can scroll, and a
        // cancel has to give each of them back.
        const needsScroll = yield* dom.probeOr(() => !inView(), false);
        if (needsScroll) {
          const anchor = elementFor(range);
          if (Option.isSome(anchor)) {
            yield* recordScrollAncestors(anchor.value);
          }
        }

        const done = yield* dom.probeOr(() => {
          if (inView()) return true;

          // `scrollIntoView` on the element that holds the match comes first.
          // It is the only thing that understands a nested scroll container
          // without us writing one again.
          const anchor = elementFor(range);
          if (Option.isSome(anchor)) {
            anchor.value.scrollIntoView({
              block: "center",
              inline: "nearest",
              behavior: "instant",
            });
          }
          if (inView()) return true;

          // The element can be much larger than the match, for example a whole
          // article. Correct the rest against the rectangle of the range.
          const rect = range.getBoundingClientRect();
          win.scrollBy({
            top: rect.top - viewport.height / 3,
            left: 0,
            behavior: "instant",
          });
          return true;
        }, false);

        if (done) yield* draw();
      });

      /** Move to the match nearest to the selection, without stepping. */
      const anchorToSelection = Effect.fn("Find.anchorToSelection")(
        function*(direction: 1 | -1) {
          const target = yield* selection;
          if (Option.isNone(target)) return;
          const found = yield* Ref.get(matches);
          const index = indexAtSelection(target.value, found, direction);
          if (Option.isSome(index)) yield* Ref.set(current, index.value);
        },
      );

      /** `n` and `N`. The search wraps, as it does in Vim. */
      const stepBy = Effect.fn("Find.stepBy")(function*(delta: number) {
        if (Option.isNone(yield* Ref.get(query))) return NO_QUERY;
        if ((yield* Ref.get(matches)).length === 0) {
          const outcome = yield* research();
          if (outcome.count === 0) return outcome;
        }

        const found = yield* Ref.get(matches);
        const count = found.length;
        if (count === 0) {
          return {
            count: 0,
            index: -1,
            empty: false,
            error: Option.none(),
            stopped: yield* Ref.get(partial),
          };
        }

        const index = yield* Ref.get(current);
        const start = index < 0 ? firstMatchInView(found) : index;
        const next = (((start + delta) % count) + count) % count;
        yield* Ref.set(current, next);
        yield* draw();
        yield* scrollToCurrent();

        return {
          count,
          index: next,
          empty: false,
          error: Option.none(),
          stopped: yield* Ref.get(partial),
        };
      });

      // -- the mode that lives on after Enter -----------------------------

      const closePost = Effect.gen(function*() {
        const scope = yield* Ref.getAndSet(postScope, Option.none());
        if (Option.isSome(scope)) yield* Scope.close(scope.value, Exit.void);
      });

      /**
       * The mode that lives on after Enter.
       *
       * Ported from the `mode_post_find.js` of Vimium, without the handling of
       * an editable element: upstream goes into insert mode when the match
       * lands in a text field, and a feature here does not call another
       * feature. The highlights stay until Escape, a click or a change of
       * focus.
       */
      const enterPost = Effect.fn("Find.enterPost")(function*() {
        yield* closePost;
        const scope = yield* Scope.make();
        const handle = yield* Effect.provideService(
          Effect.gen(function*() {
            // The matches belong to this scope. A `Range` for each match holds
            // the nodes at its boundaries, and this is what gives them back.
            yield* holdMatches;
            return yield* modes.enter({
              name: "post-find",
              indicator: null,
              exitOnEscape: true,
              exitOnClick: true,
              exitOnFocus: true,
              singleton: "find",
            }, {
              // Everything except Escape, which the mode itself takes, belongs
              // to the page and to the key trie of normal mode, so that `n` and
              // `N` keep working.
              keydown: (): Effect.Effect<HandlerResult> =>
                Effect.succeed(CONTINUE_BUBBLING),
            });
          }),
          Scope.Scope,
          scope,
        );
        // The scope owns the mode, and the mode now owns the scope. An exit
        // for any reason therefore closes the scope, and a defect exit leaves
        // no scope that only the next `closePost` would release. The scope is
        // stored first, because `onExit` runs its body at once when the mode
        // already exited.
        yield* Ref.set(postScope, Option.some(scope));
        yield* handle.onExit(() => Effect.andThen(clearState, closePost));
      });

      /** Open the mode again when nothing holds the highlights. */
      const ensurePost = Effect.fn("Find.ensurePost")(function*() {
        const scope = yield* Ref.get(postScope);
        if (Option.isNone(scope)) {
          yield* enterPost();
          return;
        }
        const names = yield* modes.activeNames;
        if (!names.includes("post-find")) yield* enterPost();
      });

      // -- the prompt ----------------------------------------------------

      const showStatus = Effect.fn("Find.showStatus")(
        function*(outcome: SearchOutcome) {
          if (Option.isSome(outcome.error)) {
            // Rule: a failure that the user must see goes through `Report`.
            yield* report.error(statusText(outcome));
            return;
          }
          // A duration of zero holds the line until the next message. The
          // count is a live status, and not an announcement.
          yield* hud.show(statusText(outcome), 0);
        },
      );

      const runIncremental = Effect.fn("Find.runIncremental")(
        function*(value: string) {
          const outcome = yield* search(value, Option.none());
          yield* showStatus(outcome);
          if (outcome.count > 0) yield* scrollToCurrent();
        },
      );

      /**
       * Build the options of the HUD prompt for one session.
       *
       * History cycling writes straight into `event.target`. That looks like a
       * break of the layers, and it is a deliberate one: `onKeydown` can only
       * *take* a key, and it cannot change the text of the field, and the field
       * is our own element inside our own closed shadow root. Widening the
       * interface of the HUD for one feature would cost more.
       */
      const promptOptions = Effect.fn("Find.promptOptions")(
        function*(options: {
          readonly backwards: boolean;
          readonly history: ReadonlyArray<string>;
        }) {
          const historyIndex = yield* Ref.make(-1);
          const draft = yield* Ref.make("");

          const applyHistory = (
            event: KeyboardEvent,
            delta: number,
            value: string,
          ): Effect.Effect<boolean> =>
            Effect.gen(function*() {
              const input = event.target;
              if (!(input instanceof HTMLInputElement)) return false;
              if (options.history.length === 0) return true;

              const index = yield* Ref.get(historyIndex);
              if (index === -1) yield* Ref.set(draft, value);
              const next = index + delta;
              if (next < -1) return true;

              const chosen = Math.min(next, options.history.length - 1);
              yield* Ref.set(historyIndex, chosen);
              const stored = yield* Ref.get(draft);
              const entry = chosen === -1
                ? stored
                : options.history[chosen] ?? stored;
              yield* Effect.sync(() => {
                input.value = entry;
              });
              // The `input` listener of the HUD does not fire for a write from
              // a script, so the incremental search is started by hand.
              yield* runIncremental(entry);
              return true;
            });

          return {
            label: options.backwards ? "?" : "/",
            // A screen reader cannot read "/" as a name for the field.
            ariaLabel: options.backwards
              ? "Find backwards on the page"
              : "Find on the page",
            placeholder: "search",
            onInput: runIncremental,
            onKeydown: (event: KeyboardEvent, value: string) =>
              Effect.gen(function*() {
                if (event.key === "ArrowUp") {
                  return yield* applyHistory(event, 1, value);
                }
                if (event.key === "ArrowDown") {
                  return yield* applyHistory(event, -1, value);
                }
                // `<c-p>` and `<c-n>` as the other names for the history, for
                // the reason that readline has them: the arrow keys are far
                // from the home row.
                if (event.ctrlKey && event.key === "p") {
                  return yield* applyHistory(event, 1, value);
                }
                if (event.ctrlKey && event.key === "n") {
                  return yield* applyHistory(event, -1, value);
                }
                return false;
              }),
          } satisfies HudPromptOptions;
        },
      );

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
      const passIfOurs = (
        event: KeyboardEvent,
      ): Effect.Effect<HandlerResult> =>
        Effect.succeed(
          hud.ownsFocus(event.target) ? PASS_EVENT_TO_PAGE : SUPPRESS_EVENT,
        );

      const promptSession = Effect.fn("Find.promptSession")(
        function*(isBackwards: boolean) {
          const committed = yield* Ref.make(false);
          const snapshot = yield* readScroll;
          // The list belongs to this session. A container that an earlier `n`
          // moved is not this session to give back.
          yield* forgetScrollAncestors;

          // The one place that undoes what a cancelled search disturbed. It
          // runs for Escape, for a blur, and for an interruption from `clear`
          // or from a second `enter`.
          yield* Effect.addFinalizer(() =>
            Effect.gen(function*() {
              if (yield* Ref.get(committed)) {
                yield* forgetScrollAncestors;
                return;
              }
              yield* clearState;
              // The nested containers come first, and the window last: a
              // container that is put back can move the page under it.
              yield* restoreScrollAncestors;
              yield* restoreScroll(snapshot);
              yield* hud.hide;
            })
          );

          yield* Ref.set(backwards, isBackwards);
          yield* ensureStyles;
          // The mode that lives on holds the same singleton group, and its exit
          // body clears the state. It is closed first, so that the walk below
          // is not thrown away.
          yield* closePost;
          yield* clearState;

          const handle = yield* modes.enter({
            name: "find",
            indicator: isBackwards ? "Find (backwards)" : "Find",
            // The HUD input owns Escape: it has to settle the prompt, and an
            // exit at the level of the mode would leave the prompt open.
            exitOnEscape: false,
            singleton: "find",
          }, {
            keydown: passIfOurs,
            keypress: passIfOurs,
            keyup: passIfOurs,
            // Stop insert mode, which sits below us, from reading focus on our
            // own input as the page asking for insert mode.
            focus: (event) =>
              Effect.succeed(
                hud.ownsFocus(event.target)
                  ? SUPPRESS_PROPAGATION
                  : CONTINUE_BUBBLING,
              ),
          });

          yield* refreshRuns();

          const history = (yield* storage.findHistory.current).queries;
          const options = yield* promptOptions({
            backwards: isBackwards,
            history,
          });

          // A mode can also end without the user: `exitAll` runs on a soft
          // navigation. The prompt must not stay open and hold the keyboard.
          const abandoned = yield* Deferred.make<void>();
          yield* handle.onExit(() =>
            Effect.asVoid(Deferred.succeed(abandoned, undefined))
          );

          const answer = yield* Effect.race(
            hud.prompt(options),
            Effect.as(Deferred.await(abandoned), Option.none<string>()),
          );

          if (Option.isSome(answer)) yield* Ref.set(committed, true);
          return answer;
        },
      );

      const commit = Effect.fn("Find.commit")(function*(raw: string) {
        const trimmed = raw.trim();
        if (trimmed.length === 0) {
          yield* clearState;
          yield* hud.hide;
          return;
        }

        // Detached, because the group waits for its own debounce before the
        // write completes. The user must not wait half a second for the
        // highlight.
        yield* Effect.asVoid(Effect.forkDetach(
          Effect.catch(
            storage.findHistory.update((history) => ({
              queries: [...pushHistory(history.queries, trimmed)],
            })),
            (error) =>
              report.error(`Could not save the search: ${error.detail}`),
          ),
        ));

        const outcome = yield* search(
          trimmed,
          Option.some(yield* Ref.get(current)),
        );
        yield* hud.hide;

        if (Option.isSome(outcome.error)) {
          yield* report.error(statusText(outcome));
          yield* clearState;
          return;
        }
        if (outcome.count === 0) {
          yield* hud.show(`No matches for "${trimmed}"`);
          yield* clearState;
          return;
        }

        // The match stays selected. That is what lets `n`, `N`, `y` and visual
        // mode all continue from where find stopped.
        yield* scrollToCurrent();
        yield* selectCurrent();
        yield* hud.show(statusText(outcome));
        yield* enterPost();
      });

      const runSession = Effect.fn("Find.runSession")(
        function*(isBackwards: boolean) {
          const answer = yield* Effect.scoped(promptSession(isBackwards));
          if (Option.isSome(answer)) yield* commit(answer.value);
        },
      );

      // -- the public methods --------------------------------------------

      const enter = Effect.fn("Find.enter")(
        function*(options: { readonly backwards: boolean }) {
          // The old session is stopped *before* the new one reads the scroll
          // position. Its finalizer puts the old position back, and a new
          // snapshot taken first would be that old position.
          yield* FiberHandle.clear(sessionFiber);
          yield* Effect.asVoid(
            FiberHandle.run(sessionFiber, runSession(options.backwards)),
          );
        },
      );

      const step = Effect.fn("Find.step")(function*(count: number) {
        const last = yield* Ref.get(query);
        if (Option.isNone(last)) {
          yield* hud.show("No previous search");
          return;
        }
        yield* ensureStyles;
        // The highlights need an owner. Without one they would stay on screen
        // with nothing left to take them away. The mode is opened before the
        // step, because opening it drops a mode that already ended, and that
        // release clears the matches.
        yield* ensurePost();
        const outcome = yield* stepBy(
          (yield* Ref.get(backwards)) ? -count : count,
        );
        if (outcome.count === 0) {
          yield* hud.show(`No matches for "${last.value.raw}"`);
          return;
        }
        yield* selectCurrent();
        yield* hud.show(statusText(outcome));
      });

      const searchWordUnderCursor = Effect.fn("Find.searchWordUnderCursor")(
        function*(direction: 1 | -1) {
          const target = yield* selection;
          const word = Option.isNone(target)
            ? ""
            : yield* dom.probeOr(() => wordUnderCursor(target.value), "");
          if (word.length === 0) {
            yield* hud.show("No word under the cursor");
            return;
          }

          const parsed = wordQuery(word);
          if (Option.isNone(toRegExp(parsed))) {
            yield* hud.show("No word under the cursor");
            return;
          }

          yield* ensureStyles;
          yield* closePost;
          yield* clearState;
          // `*` commits at once, so nothing here is ever put back. The list is
          // dropped so that it holds no element of the page.
          yield* forgetScrollAncestors;
          yield* refreshRuns();
          // `*` and `#` set the direction outright. Upstream does the same, and
          // it is what makes a following `n` continue the way that the user
          // just went.
          yield* Ref.set(backwards, direction < 0);

          const outcome = yield* search(parsed.raw, Option.none());
          if (outcome.count === 0) {
            yield* hud.show(`No matches for "${word}"`);
            yield* clearState;
            return;
          }

          // The anchor is the match that the step must leave, and not the one
          // that it lands on. `*` therefore goes to the occurrence after the
          // caret, and `#` to the one before it. Upstream does the same.
          yield* anchorToSelection(direction);
          const stepped = yield* stepBy(direction);
          yield* selectCurrent();
          yield* hud.show(`${word}  ${statusText(stepped)}`);
          yield* enterPost();
        },
      );

      const clearAll = Effect.fn("Find.clear")(function*() {
        yield* FiberHandle.clear(sessionFiber);
        yield* closePost;
        yield* clearState;
        // The list holds an `Element` for each container, so an abandoned list
        // would hold a subtree of the page as well.
        yield* forgetScrollAncestors;
        yield* hud.hide;
      });

      // The layer scope owns the session, the overlay and the mode that lives
      // on. Closing the runtime therefore takes every `Range` with it.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function*() {
          yield* closePost;
          yield* clearState;
          yield* forgetScrollAncestors;
        })
      );

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
