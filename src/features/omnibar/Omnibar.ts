/**
 * Omnibar-lite: the session, the mode and the commands.
 *
 * This is not a copy of the address bar. A userscript has no `chrome.history`
 * and no `chrome.bookmarks`, so the omnibar offers the sources that it can be
 * complete about — the commands and the search engines — beside sources that
 * it names honestly: our own opt-in index, and the tabs that we opened. Every
 * row says which source it came from.
 *
 * **Who owns the keyboard.** The text field is a true in-page element inside
 * our closed shadow root, so the handler stack sees every keystroke that the
 * user aims at it. That is a problem and an opportunity:
 *
 * - **Problem.** `SUPPRESS_EVENT` calls `preventDefault`, so to suppress every
 *   key would stop the field from receiving any text.
 * - **Opportunity.** We see the events first, so we can take exactly the
 *   navigation keys and give the rest on with `PASS_EVENT_TO_PAGE`. That stops
 *   the walk down the stack — normal mode and insert mode never see a
 *   character that was typed into the omnibar — and it keeps the default
 *   action, so the field still types the character.
 *
 * The mode is declared `suppressAllKeyboardEvents`. That is the backstop: a
 * keyboard event that this file does not classify is swallowed, and does not
 * reach the bindings of the page.
 */

import {
  Clock,
  Context,
  Effect,
  Exit,
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
import { isEscape, Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { isComposing } from "~/domain/Key.ts";
import type { SessionState } from "~/domain/Persisted.ts";
import {
  classifyQuery,
  parseSearchEngines,
  type SearchEngine,
  splitKeyword,
} from "~/domain/SearchEngine.ts";
import { Capabilities } from "~/platform/Capabilities.ts";
import { Clipboard } from "~/platform/Clipboard.ts";
import { Dom } from "~/platform/Dom.ts";
import { Gm } from "~/platform/Gm.ts";
import { Storage } from "~/platform/Storage.ts";
import { Tabs } from "~/platform/Tabs.ts";
import { Hud } from "~/ui/Hud.ts";
import { Ui } from "~/ui/Ui.ts";
import {
  type Completion,
  completionsFor,
  liveTabs,
  type OmnibarSource,
} from "./Completers.ts";
import { makeHistoryIndex } from "./History.ts";
import { makeOmnibarView, OMNIBAR_CSS, type OmnibarView } from "./OmnibarUi.ts";
import { makeSuggester } from "./Suggest.ts";

export type { OmnibarSource } from "./Completers.ts";

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const PLACEHOLDERS: Readonly<Record<OmnibarSource, string>> = {
  url: "Search or type a URL",
  command: "Run a command",
  search: "Search the web",
  bookmark: "Search or type a URL",
};

const KEY_LEGEND = "↑↓ move · ⏎ open · ⇧⏎ new tab · esc close";

/** The badge of a suggestion when no engine keyword names the engine. */
const DEFAULT_SUGGESTION_BADGE = "Suggested";

const footerText = (badLines: number): string =>
  badLines === 0 ? KEY_LEGEND : `${KEY_LEGEND} · ${badLines} malformed ` +
    `searchEngines line${badLines === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type OmnibarKeyAction =
  | "previous"
  | "next"
  | "accept"
  | "accept-new-tab"
  | "cancel";

/**
 * Read a key press as an omnibar action.
 *
 * Pure, and exported, so that the table of bindings can be read and changed
 * without any thought about the handler stack. `Ctrl+N` and `Ctrl+P` are
 * accepted beside the arrows, for the reason that readline has them, and to
 * agree with the history keys of find mode.
 */
export const omnibarAction = (
  event: KeyboardEvent,
): Option.Option<OmnibarKeyAction> => {
  if (isEscape(event)) return Option.some("cancel");

  switch (event.key) {
    case "ArrowUp":
      return Option.some("previous");
    case "ArrowDown":
      return Option.some("next");
    case "Tab":
      return Option.some(event.shiftKey ? "previous" : "next");
    case "Enter":
      return Option.some(event.shiftKey ? "accept-new-tab" : "accept");
    default:
      break;
  }

  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    if (event.key === "p") return Option.some("previous");
    if (event.key === "n") return Option.some("next");
  }
  return Option.none();
};

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/** The suggestions on screen, and the query that they belong to. */
interface SuggestionState {
  /** The whole input that these suggestions answer. */
  readonly query: string;
  readonly badge: string;
  readonly items: readonly string[];
}

interface Session {
  readonly source: OmnibarSource;
  /** Closing this removes the overlay and exits the mode. */
  readonly scope: Scope.Closeable;
  readonly view: OmnibarView;
  readonly rows: Ref.Ref<readonly Completion[]>;
  readonly selected: Ref.Ref<number>;
  readonly suggestions: Ref.Ref<SuggestionState>;
}

/** The parsed engines, kept against the raw configuration that made them. */
interface EngineCache {
  readonly source: string;
  readonly engines: readonly SearchEngine[];
  readonly badLines: number;
}

/**
 * A configuration string that no user can type.
 *
 * The first read must always parse, and an empty configuration is a value that
 * the user can choose.
 */
const NO_ENGINE_SOURCE = "\u0000 never parsed";

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Omnibar extends Context.Service<Omnibar, {
  readonly open: (
    source: OmnibarSource,
    initialQuery?: string,
  ) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  /** Record this page in the local index, when the user turned the index on. */
  readonly noteVisit: Effect.Effect<void>;
  /**
   * Erase the local index.
   *
   * This is a privacy control, and not plumbing. The README documents it as the
   * only way to erase the index, so it must report a failure to erase.
   */
  readonly clearHistory: Effect.Effect<void>;
}>()("vimium/features/omnibar/Omnibar") {
  static readonly layer: Layer.Layer<
    Omnibar,
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
    | Tabs
    | Clipboard
    | Gm
  > = Layer.effect(
    Omnibar,
    Effect.gen(function*() {
      const commands = yield* Commands;
      const dom = yield* Dom;
      const hud = yield* Hud;
      const modes = yield* Modes;
      const report = yield* Report;
      const settings = yield* Settings;
      const storage = yield* Storage;
      const tabs = yield* Tabs;
      const ui = yield* Ui;

      const history = yield* makeHistoryIndex;
      const suggester = yield* makeSuggester;

      // The services that the view needs, captured once. A session is opened
      // from a command body, which carries nothing of its own.
      const services = yield* Effect.context<Dom | Ui>();

      // Installed once, with the layer. CSSOM only: a `<style>` element here
      // would obey the `style-src` of the page and be dropped on any site with
      // a strict policy.
      yield* ui.addStyle(OMNIBAR_CSS);

      const session = yield* Ref.make(Option.none<Session>());
      const engineCache = yield* Ref.make<EngineCache>({
        source: NO_ENGINE_SOURCE,
        engines: [],
        badLines: 0,
      });

      /** The engines of the current configuration, parsed at most once. */
      const engines = Effect.fn("Omnibar.engines")(function*() {
        const current = yield* settings.current;
        const cached = yield* Ref.get(engineCache);
        if (cached.source === current.searchEngines) return cached;
        const parsed = parseSearchEngines(current.searchEngines);
        const next: EngineCache = {
          source: current.searchEngines,
          engines: parsed.engines,
          badLines: parsed.diagnostics.length,
        };
        yield* Ref.set(engineCache, next);
        return next;
      });

      // ---------------------------------------------------------------
      // Lifecycle
      // ---------------------------------------------------------------

      const close: Effect.Effect<void> = Effect.gen(function*() {
        const current = yield* Ref.getAndSet(session, Option.none());
        if (Option.isNone(current)) return;
        yield* suggester.cancel;
        // The scope owns the overlay, the listeners and the mode frame.
        yield* Scope.close(current.value.scope, Exit.void);
      });

      // ---------------------------------------------------------------
      // Suggestions
      // ---------------------------------------------------------------

      /**
       * Ask the engine for completions, if the user has said that we may.
       *
       * Two gates stand before anything leaves the device. The second one is
       * the one that was once absent: a query goes out only when it is truly a
       * *search*. Suggestions were asked for in every session that was not a
       * command session, so a URL that the user typed — an internal host name,
       * a test machine, a single-use link from a message — went to the search
       * engine on its way to being opened.
       */
      const requestSuggestions = Effect.fn("Omnibar.requestSuggestions")(
        function*(current: Session, query: string) {
          const config = yield* settings.current;
          const parsed = (yield* engines()).engines;

          // A keyword in front sends the suggestions to that engine, which is
          // what the user asked for by typing it.
          const split = splitKeyword(query, parsed);
          const template = Option.isSome(split)
            ? split.value.engine.url
            : config.searchUrl;
          const text = Option.isSome(split) ? split.value.rest : query;

          // A keyword is an explicit "search this engine for the rest", so it
          // settles the question by itself. Without one, the classification
          // decides, and only a search may go out.
          if (Option.isNone(split) && classifyQuery(text) !== "search") return;

          const badge = Option.isSome(split)
            ? split.value.engine.description
            : DEFAULT_SUGGESTION_BADGE;

          // Keyed on the *whole* input, and not on the text that goes to the
          // engine, so that the answer can be compared with what is on screen.
          const forQuery = query.trim();

          yield* suggester.request(
            template,
            text,
            (_answered, items) =>
              Effect.gen(function*() {
                const live = yield* Ref.get(session);
                if (Option.isNone(live) || live.value !== current) return;
                yield* Ref.set(current.suggestions, {
                  query: forQuery,
                  badge,
                  items,
                });
                // Draw again only. To ask again here would loop.
                yield* render(current, false);
              }),
          );
        },
      );

      // ---------------------------------------------------------------
      // Drawing
      // ---------------------------------------------------------------

      const render: (
        current: Session,
        askForSuggestions: boolean,
      ) => Effect.Effect<void> = Effect.fn("Omnibar.render")(
        function*(current: Session, askForSuggestions: boolean) {
          const config = yield* settings.current;
          const parsed = yield* engines();
          const query = yield* current.view.value;
          const visits = yield* history.visits;
          const stored = yield* storage.session.current;
          const now = yield* Clock.currentTimeMillis;
          const suggestion = yield* Ref.get(current.suggestions);

          const state = completionsFor({
            source: current.source,
            query,
            commands: commands.all,
            engines: parsed.engines,
            searchUrl: config.searchUrl,
            visits,
            knownTabs: liveTabs(stored.knownTabs, now),
            // Only the suggestions that belong to the query on screen. A late
            // answer for a query that the user has left behind is worse than
            // no answer.
            suggestions: suggestion.query === query.trim()
              ? suggestion.items
              : [],
            suggestionEngine: suggestion.badge,
            now,
          });

          yield* Ref.set(current.rows, state.rows);
          const selected = yield* Ref.updateAndGet(
            current.selected,
            (value) =>
              Math.min(Math.max(value, 0), Math.max(0, state.rows.length - 1)),
          );

          yield* current.view.setPrefix(state.commandMode ? ":" : "›");
          yield* current.view.setFooter(footerText(parsed.badLines));
          yield* current.view.render(state.rows, selected);

          if (askForSuggestions && !state.commandMode) {
            yield* requestSuggestions(current, state.effectiveQuery);
          }
        },
      );

      // ---------------------------------------------------------------
      // Acting on a row
      // ---------------------------------------------------------------

      /**
       * Remember a tab that we opened, so that it can appear as "Recent".
       *
       * The list is pruned on every write. A list of tabs that are gone is
       * both misleading in the completion list and growth without a limit in
       * storage.
       */
      const registerOpenedTab = Effect.fn("Omnibar.registerOpenedTab")(
        function*(url: string, title: string) {
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.ignore(
            storage.session.update((current): SessionState => ({
              ...current,
              knownTabs: [
                { url, title, heartbeat: now },
                ...liveTabs(current.knownTabs, now).filter(
                  (tab) => tab.url !== url,
                ),
              ],
            })),
          );
        },
      );

      const openInNewTab = Effect.fn("Omnibar.openInNewTab")(
        function*(url: string) {
          yield* Effect.matchEffect(tabs.open(url, { active: true }), {
            onSuccess: (outcome) => registerOpenedTab(outcome.url, ""),
            onFailure: (error) =>
              report.error(
                error.nativeAlternative === undefined
                  ? error.detail
                  : `${error.detail} (${error.nativeAlternative})`,
              ),
          });
        },
      );

      const activate = Effect.fn("Omnibar.activate")(
        function*(index: number, newTab: boolean) {
          const live = yield* Ref.get(session);
          if (Option.isNone(live)) return;
          const current = live.value;
          const row = (yield* Ref.get(current.rows))[index];
          if (row === undefined) return;

          switch (row.action.type) {
            case "fill": {
              // To adopt a keyword is a refinement, and not a destination. The
              // omnibar stays open with the cursor after the keyword.
              yield* current.view.setValue(row.action.text);
              yield* Ref.set(current.selected, 0);
              yield* render(current, true);
              return;
            }
            case "none": {
              yield* close;
              return;
            }
            case "command": {
              const name = row.action.name;
              yield* close;
              // A tier C command is run, and not blocked here. The catalogue
              // owns the refusal, and a second copy of it would move away from
              // the first.
              yield* Effect.catch(
                commands.run(name, { count: 1, options: {}, event: null }),
                (error) => report.error(error.detail),
              );
              return;
            }
            case "navigate": {
              const url = row.action.url;
              yield* close;
              if (newTab) {
                yield* openInNewTab(url);
                return;
              }
              yield* Effect.catch(
                tabs.navigate(url),
                (error) => report.error(error.detail),
              );
              return;
            }
          }
        },
      );

      /**
       * Start the work of a row, and give the key task back at once.
       *
       * Detached on purpose. To act closes the session, and a fiber of the
       * session scope would be interrupted before it opened the tab.
       * `startImmediately` keeps the call to the manager inside the activation
       * window of the key press.
       */
      const startActivation = (
        index: number,
        newTab: boolean,
      ): Effect.Effect<void> =>
        Effect.asVoid(Effect.forkDetach(activate(index, newTab), {
          startImmediately: true,
        }));

      const startClose: Effect.Effect<void> = Effect.asVoid(
        Effect.forkDetach(close, { startImmediately: true }),
      );

      // ---------------------------------------------------------------
      // Keys
      // ---------------------------------------------------------------

      const move = Effect.fn("Omnibar.move")(
        function*(current: Session, delta: number) {
          const rows = yield* Ref.get(current.rows);
          if (rows.length === 0) return;
          // It wraps, because a list this short is faster to cycle than to
          // turn around.
          const selected = yield* Ref.updateAndGet(
            current.selected,
            (value) =>
              (((value + delta) % rows.length) + rows.length) %
              rows.length,
          );
          yield* current.view.render(rows, selected);
        },
      );

      const onAction = (
        current: Session,
        action: OmnibarKeyAction,
      ): Effect.Effect<void> => {
        switch (action) {
          case "previous":
            return move(current, -1);
          case "next":
            return move(current, 1);
          case "accept":
            return Effect.flatMap(
              Ref.get(current.selected),
              (index) => startActivation(index, false),
            );
          case "accept-new-tab":
            return Effect.flatMap(
              Ref.get(current.selected),
              (index) => startActivation(index, true),
            );
          case "cancel":
            return startClose;
        }
      };

      /**
       * Let our own field have the key, and swallow a key from anywhere else.
       *
       * `PASS_EVENT_TO_PAGE` stops the walk down the stack and leaves the
       * event alone, which is exactly "our field types this, and nothing else
       * reacts". A listener of the page on `document` still sees it,
       * retargeted to our shadow host. That cannot be prevented without the
       * extension-origin iframe that upstream Vimium has and we do not.
       */
      const passIfOurs = (
        view: OmnibarView,
        event: KeyboardEvent,
      ): HandlerResult =>
        view.ownsFocus(event.target) ? PASS_EVENT_TO_PAGE : SUPPRESS_EVENT;

      const onKeydown = (
        current: () => Option.Option<Session>,
        view: OmnibarView,
      ) =>
      (event: KeyboardEvent): Effect.Effect<HandlerResult> =>
        Effect.gen(function*() {
          // An input method is in the middle of a composition. Every key
          // belongs to that composition.
          if (isComposing(event)) return passIfOurs(view, event);

          const action = omnibarAction(event);
          if (Option.isNone(action)) return passIfOurs(view, event);

          const live = current();
          if (Option.isNone(live)) return passIfOurs(view, event);
          yield* onAction(live.value, action.value);
          // `preventDefault` is more than tidiness here. Without it Tab moves
          // the focus out of the overlay, and the arrows move the caret in the
          // field.
          return SUPPRESS_EVENT;
        });

      // ---------------------------------------------------------------
      // Opening
      // ---------------------------------------------------------------

      const open = Effect.fn("Omnibar.open")(
        function*(source: OmnibarSource, initialQuery?: string) {
          yield* close;
          // The omnibar takes the keyboard, so a message that is still on
          // screen is no longer the thing that the user looks at.
          yield* hud.hide;

          const scope = yield* Scope.make();
          const inScope = <A, R>(
            effect: Effect.Effect<A, never, R>,
          ): Effect.Effect<A, never, Exclude<R, Scope.Scope>> =>
            Effect.provideService(effect, Scope.Scope, scope);

          const rows = yield* Ref.make<readonly Completion[]>([]);
          const selected = yield* Ref.make(0);
          const suggestions = yield* Ref.make<SuggestionState>({
            query: "",
            badge: DEFAULT_SUGGESTION_BADGE,
            items: [],
          });

          const view = yield* inScope(Effect.provideContext(
            makeOmnibarView({
              placeholder: PLACEHOLDERS[source],
              onInput: () =>
                Effect.gen(function*() {
                  const live = yield* Ref.get(session);
                  if (Option.isNone(live)) return;
                  // Any edit makes the choice stale: the row under the cursor
                  // is almost never the row that the user now means.
                  yield* Ref.set(live.value.selected, 0);
                  yield* render(live.value, true);
                }),
              onActivate: startActivation,
              onDismiss: close,
            }),
            services,
          ));

          const mode = yield* inScope(modes.enter({
            name: "omnibar",
            indicator: null,
            // Escape is handled above, and not by the mode, so that the
            // overlay goes and the focus comes back before the frame does.
            exitOnEscape: false,
            // The backstop, and not the mechanism. Read the file comment.
            suppressAllKeyboardEvents: true,
            singleton: "omnibar",
          }, {
            keydown: onKeydown(() => Ref.getUnsafe(session), view),
            keypress: (event) => Effect.succeed(passIfOurs(view, event)),
            keyup: (event) => Effect.succeed(passIfOurs(view, event)),
            focus: (event) =>
              // Keep insert mode, which sits below us, from reading a focus on
              // our own field as the page asking for insert mode.
              Effect.succeed(
                view.ownsFocus(event.target)
                  ? SUPPRESS_PROPAGATION
                  : CONTINUE_BUBBLING,
              ),
          }));

          const current: Session = {
            source,
            scope,
            view,
            rows,
            selected,
            suggestions,
          };
          yield* Ref.set(session, Option.some(current));

          // Anything that removes us — another singleton mode, a navigation —
          // must take the overlay with it, or the user is left with a field
          // that cannot be reached.
          yield* mode.onExit(() =>
            Effect.gen(function*() {
              const live = yield* Ref.get(session);
              if (Option.isSome(live) && live.value === current) yield* close;
            })
          );

          // The optional first query is what "open a link with the omnibar"
          // gives us.
          yield* view.setValue(initialQuery ?? "");
          yield* view.focus;
          yield* render(current, true);
        },
      );

      // ---------------------------------------------------------------
      // Page bookkeeping
      // ---------------------------------------------------------------

      /**
       * Refresh the signal of this tab, but only when it is already a tab that
       * we opened.
       *
       * To add an entry here would quietly turn a liveness list into a second
       * history index, and that is the very thing that must stay opt-in.
       */
      const heartbeat = Effect.fn("Omnibar.heartbeat")(function*() {
        const href = yield* dom.href;
        const stored = yield* storage.session.current;
        if (!stored.knownTabs.some((tab) => tab.url === href)) return;

        const title = yield* dom.probeOr(() => dom.document.title, "");
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.ignore(
          storage.session.update((current): SessionState => ({
            ...current,
            knownTabs: liveTabs(current.knownTabs, now).map((tab) =>
              tab.url === href ? { url: href, title, heartbeat: now } : tab
            ),
          })),
        );
      });

      const clearHistory = Effect.fn("Omnibar.clearHistory")(function*() {
        yield* Effect.matchEffect(history.clear, {
          onFailure: (error) =>
            report.error(
              `Could not erase the history index: ${error.detail}`,
            ),
          onSuccess: () => report.info("Local history index erased"),
        });
      });

      const service = Omnibar.of({
        open,
        close,
        noteVisit: Effect.andThen(history.record, heartbeat()),
        clearHistory: clearHistory(),
      });

      // A command body runs on a forked fiber, so it may suspend.
      yield* commands.registerAll({
        "Vomnibar.activate": () => service.open("url"),
        "Vomnibar.activateInNewTab": () => service.open("url"),
        "Vomnibar.activateCommands": () => service.open("command"),
        "Vomnibar.activateSearch": () => service.open("search"),
        // Tier C, and still a body. The row explains the refusal and shows the
        // shortcut of the browser, which a silent command cannot do.
        "Vomnibar.activateBookmarks": () => service.open("bookmark"),
        "clear-history": () => service.clearHistory,
      });

      // The session belongs to the layer scope as well, so that the runtime
      // takes the overlay with it when it stops.
      yield* Effect.addFinalizer(() => close);

      return service;
    }),
  );
}
