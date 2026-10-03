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
 * The mode owns the keyboard, with `KeyPolicy.Owned`. That is the backstop: a
 * keyboard event that this file does not classify is swallowed, and does not
 * reach the bindings of the page.
 */

import {
  Array,
  Boolean,
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Ref,
  Scope,
  pipe,
  Struct,
} from "effect";
import { Commands } from "~/core/Commands.ts";
import {
  CONTINUE_BUBBLING,
  type HandlerResult,
  PASS_EVENT_TO_PAGE,
  SUPPRESS_EVENT,
  SUPPRESS_PROPAGATION,
} from "~/core/HandlerStack.ts";
import { isEscape, KeyPolicy, Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { isComposing } from "~/domain/Key.ts";
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
import { type TabError, Tabs } from "~/platform/Tabs.ts";
import { Hud } from "~/ui/Hud.ts";
import { Ui } from "~/ui/Ui.ts";
import {
  type Completion,
  CompletionAction,
  completionsFor,
  CompletionState,
  type KnownTab,
  liveTabs,
  type OmnibarSource,
  type Suggestions,
} from "./Completers.ts";
import { makeHistoryIndex } from "./History.ts";
import { makeOmnibarView, OMNIBAR_CSS, type OmnibarView } from "./OmnibarUi.ts";
import { makeSuggester } from "./Suggest.ts";

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const placeholderFor = (source: OmnibarSource): string =>
  pipe(
    Match.value(source),
    Match.whenOr("url", "bookmark", () => "Search or type a URL"),
    Match.when("command", () => "Run a command"),
    Match.when("search", () => "Search the web"),
    Match.exhaustive,
  );

/** The keys, as a session that opens in this tab or in a new one reads them. */
const keyLegend = (newTab: boolean): string =>
  pipe(
    newTab,
    Boolean.match({
      onFalse: () => "↑↓ move · ⏎ open · ⇧⏎ new tab · esc close",
      onTrue: () => "↑↓ move · ⏎ open in a new tab · esc close",
    }),
  );

/** The badge of a suggestion when no engine keyword names the engine. */
const DEFAULT_SUGGESTION_BADGE = "Suggested";

const footerText = (legend: string, badLines: number): string =>
  pipe(
    Match.value(badLines),
    Match.when(0, () => legend),
    Match.when(1, () => `${legend} · 1 malformed searchEngines line`),
    Match.orElse((count) => `${legend} · ${count} malformed searchEngines lines`),
  );

/** The sign in front of the field. */
const promptOf = CompletionState.$match({
  Commands: () => ":",
  Destinations: () => "›",
});

/** A failure to open a tab, with the shortcut of the browser when there is one. */
const tabFailureText = (error: TabError): string =>
  pipe(
    error.nativeAlternative,
    Option.match({
      onNone: () => error.detail,
      onSome: (native) => `${error.detail} (${native})`,
    }),
  );

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type OmnibarKeyAction = "previous" | "next" | "accept" | "accept-new-tab" | "cancel";

/**
 * Read a key press as an omnibar action.
 *
 * Pure, and exported, so that the table of bindings can be read and changed
 * without any thought about the handler stack. `Ctrl+N` and `Ctrl+P` are
 * accepted beside the arrows, for the reason that readline has them, and to
 * agree with the history keys of find mode.
 */
export const omnibarAction = (event: KeyboardEvent): Option.Option<OmnibarKeyAction> =>
  pipe(
    Match.value(event),
    Match.withReturnType<Option.Option<OmnibarKeyAction>>(),
    Match.when(isEscape, () => Option.some("cancel")),
    Match.when({ key: "ArrowUp" }, () => Option.some("previous")),
    Match.when({ key: "ArrowDown" }, () => Option.some("next")),
    Match.when({ key: "Tab", shiftKey: true }, () => Option.some("previous")),
    Match.when({ key: "Tab" }, () => Option.some("next")),
    Match.when({ key: "Enter", shiftKey: true }, () => Option.some("accept-new-tab")),
    Match.when({ key: "Enter" }, () => Option.some("accept")),
    // `Ctrl` alone, as readline has it.
    Match.when({ key: "p", ctrlKey: true, metaKey: false, altKey: false }, () =>
      Option.some("previous"),
    ),
    Match.when({ key: "n", ctrlKey: true, metaKey: false, altKey: false }, () =>
      Option.some("next"),
    ),
    Match.orElse(() => Option.none()),
  );

/**
 * The action of a key, unless an input method is in the middle of a
 * composition. Every key then belongs to that composition.
 */
const keyAction = (event: KeyboardEvent): Option.Option<OmnibarKeyAction> =>
  pipe(
    Match.value(event),
    Match.when(isComposing, () => Option.none<OmnibarKeyAction>()),
    Match.orElse(omnibarAction),
  );

/** Move a choice by `delta`, wrapping at both ends of a list of `length` rows. */
const step =
  (delta: number, length: number) =>
  (selected: number): number =>
    (((selected + delta) % length) + length) % length;

/** Keep a choice inside a list of `length` rows. */
const clamp =
  (length: number) =>
  (selected: number): number =>
    Math.min(Math.max(selected, 0), Math.max(0, length - 1));

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/** The last answer of an engine, and the query that it belongs to. */
interface SuggestionState extends Suggestions {
  /** The whole input that these suggestions answer. */
  readonly query: string;
}

/**
 * Only the suggestions that belong to the query on screen. A late answer for
 * a query that the user has left behind is worse than no answer.
 */
const suggestionsFor = (
  query: string,
): ((answer: Option.Option<SuggestionState>) => Option.Option<Suggestions>) =>
  Option.filter((answer) => answer.query === query.trim());

/** Where suggestions for a query go, and the badge of their rows. */
interface SuggestionTarget {
  readonly template: string;
  readonly text: string;
  readonly badge: string;
}

/**
 * Where suggestions for a query may be asked, if anywhere.
 *
 * A keyword in front sends the suggestions to that engine, which is what the
 * user asked for by typing it. A keyword is an explicit "search this engine
 * for the rest", so it settles the question by itself. Without one, the
 * classification decides, and only a search may go out.
 */
const suggestionTarget = (
  query: string,
  engines: readonly SearchEngine[],
  searchUrl: string,
): Option.Option<SuggestionTarget> =>
  pipe(
    splitKeyword(query, engines),
    Option.map(({ engine, rest }): SuggestionTarget => ({
      template: engine.url,
      text: rest,
      badge: engine.description,
    })),
    Option.orElse(() =>
      pipe(
        query,
        Option.liftPredicate((text) => classifyQuery(text) === "search"),
        Option.map((text): SuggestionTarget => ({
          template: searchUrl,
          text,
          badge: DEFAULT_SUGGESTION_BADGE,
        })),
      ),
    ),
  );

interface Session {
  readonly source: OmnibarSource;
  /** Enter opens a new tab, as Shift and Enter always do. `O` asks for this. */
  readonly newTab: boolean;
  /** Closing this removes the overlay and exits the mode. */
  readonly scope: Scope.Closeable;
  readonly view: OmnibarView;
  readonly rows: Ref.Ref<readonly Completion[]>;
  readonly selected: Ref.Ref<number>;
  readonly suggestions: Ref.Ref<Option.Option<SuggestionState>>;
}

/** The parsed engines, kept against the raw configuration that made them. */
interface EngineCache {
  readonly source: string;
  readonly engines: readonly SearchEngine[];
  readonly badLines: number;
}

const parseEngines = (source: string): EngineCache =>
  pipe(parseSearchEngines(source), ({ engines, diagnostics }) => ({
    source,
    engines,
    badLines: diagnostics.length,
  }));

/**
 * Put a tab that we just opened first, and drop the tabs that are gone. Its
 * signal is the time to judge the others by.
 */
const withOpenedTab =
  (opened: KnownTab) =>
  (tabs: readonly KnownTab[]): readonly KnownTab[] =>
    pipe(
      liveTabs(tabs, opened.heartbeat),
      Array.filter((tab) => tab.url !== opened.url),
      Array.prepend(opened),
    );

/** A fresh signal for one tab, and every other tab that is still live at that time. */
const withSignal =
  (signal: KnownTab) =>
  (tabs: readonly KnownTab[]): readonly KnownTab[] =>
    pipe(
      liveTabs(tabs, signal.heartbeat),
      Array.map((tab) =>
        pipe(tab.url === signal.url, Boolean.match({ onTrue: () => signal, onFalse: () => tab })),
      ),
    );

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Omnibar extends Context.Service<
  Omnibar,
  {
    /** Record this page in the local index, when the user turned the index on. */
    readonly noteVisit: Effect.Effect<void>;
  }
>()("vimium/features/omnibar/Omnibar") {
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
    Effect.gen(function* () {
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
      // Empty until the first read, which therefore always parses. An empty
      // configuration is a value that the user can choose.
      const engineCache = yield* Ref.make(Option.none<EngineCache>());

      /** The engines of the current configuration, parsed at most once. */
      const engines = Effect.fn("Omnibar.engines")(function* () {
        const current = yield* settings.current;
        const cached = yield* Ref.get(engineCache);
        const fresh = pipe(
          cached,
          Option.filter((held) => held.source === current.searchEngines),
          Option.getOrElse(() => parseEngines(current.searchEngines)),
        );
        yield* Ref.set(engineCache, Option.some(fresh));
        return fresh;
      });

      /** The session is still the one on screen. */
      const isLive = (current: Session): Effect.Effect<boolean> =>
        pipe(Ref.get(session), Effect.map(Option.exists((live) => live === current)));

      // ---------------------------------------------------------------
      // Lifecycle
      // ---------------------------------------------------------------

      const close: Effect.Effect<void> = pipe(
        Ref.getAndSet(session, Option.none()),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (current) =>
              pipe(
                suggester.cancel,
                // The scope owns the overlay, the listeners and the mode frame.
                Effect.andThen(Scope.close(current.scope, Exit.void)),
              ),
          }),
        ),
      );

      // ---------------------------------------------------------------
      // Drawing
      // ---------------------------------------------------------------

      /** Draw the list for the text in the field, and give what it drew. */
      const render = Effect.fn("Omnibar.render")(function* (current: Session) {
        const config = yield* settings.current;
        const parsed = yield* engines();
        const query = yield* current.view.value;
        const visits = yield* history.visits;
        const stored = yield* storage.session.current;
        const now = yield* Clock.currentTimeMillis;
        const answer = yield* Ref.get(current.suggestions);

        const state = completionsFor({
          source: current.source,
          query,
          commands: commands.all,
          engines: parsed.engines,
          searchUrl: config.searchUrl,
          visits,
          knownTabs: liveTabs(stored.knownTabs, now),
          suggestions: pipe(answer, suggestionsFor(query)),
          now,
        });

        yield* Ref.set(current.rows, state.rows);
        const selected = yield* Ref.updateAndGet(current.selected, clamp(state.rows.length));

        yield* current.view.setPrefix(promptOf(state));
        yield* current.view.setFooter(footerText(keyLegend(current.newTab), parsed.badLines));
        yield* current.view.render(state.rows, selected);
        return state;
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
      const requestSuggestions = Effect.fn("Omnibar.requestSuggestions")(function* (
        current: Session,
        query: string,
      ) {
        const config = yield* settings.current;
        const parsed = yield* engines();

        // Keyed on the *whole* input, and not on the text that goes to the
        // engine, so that the answer can be compared with what is on screen.
        const forQuery = query.trim();

        yield* pipe(
          suggestionTarget(query, parsed.engines, config.searchUrl),
          Option.match({
            onNone: () => Effect.void,
            onSome: ({ template, text, badge }) =>
              suggester.request(template, text, (_answered, items) =>
                pipe(
                  Ref.set(
                    current.suggestions,
                    Option.some({ query: forQuery, template, badge, items }),
                  ),
                  // Draw again only. To ask again here would loop.
                  Effect.andThen(render(current)),
                  Effect.when(isLive(current)),
                  Effect.asVoid,
                ),
              ),
          }),
        );
      });

      /** Draw, and then ask the engine about the query outside command mode. */
      const refresh = (current: Session): Effect.Effect<void> =>
        pipe(
          render(current),
          Effect.flatMap(
            CompletionState.$match({
              Commands: () => Effect.void,
              Destinations: ({ query }) => requestSuggestions(current, query),
            }),
          ),
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
      const registerOpenedTab = Effect.fn("Omnibar.registerOpenedTab")(function* (
        url: string,
        title: string,
      ) {
        const now = yield* Clock.currentTimeMillis;
        yield* pipe(
          storage.session.update(
            Struct.evolve({ knownTabs: withOpenedTab({ url, title, heartbeat: now }) }),
          ),
          Effect.ignore,
        );
      });

      const openInNewTab = Effect.fn("Omnibar.openInNewTab")(function* (url: string) {
        yield* pipe(
          tabs.open(url, { active: true }),
          Effect.matchEffect({
            onSuccess: (outcome) => registerOpenedTab(outcome.url, ""),
            onFailure: (error) => report.error(tabFailureText(error)),
          }),
        );
      });

      /** Go to a URL in this tab, or in a new one. */
      const goTo = (url: string, newTab: boolean): Effect.Effect<void> =>
        pipe(
          newTab,
          Boolean.match({
            onTrue: () => openInNewTab(url),
            onFalse: () =>
              pipe(
                tabs.navigate(url),
                Effect.catch((error) => report.error(error.detail)),
              ),
          }),
        );

      /** Carry out the action of a chosen row. */
      const perform = (current: Session, newTab: boolean) =>
        CompletionAction.$match({
          // To adopt a keyword is a refinement, and not a destination. The
          // omnibar stays open with the cursor after the keyword.
          Fill: ({ text }) =>
            pipe(
              current.view.setValue(text),
              Effect.andThen(Ref.set(current.selected, 0)),
              Effect.andThen(refresh(current)),
            ),
          Dismiss: () => close,
          // A tier C command is run, and not blocked here. The catalogue owns
          // the refusal, and a second copy of it would move away from the
          // first.
          Command: ({ name }) =>
            pipe(
              close,
              Effect.andThen(commands.run(name, { count: 1, options: {}, event: Option.none() })),
              Effect.catch((error) => report.error(error.detail)),
            ),
          Navigate: ({ url }) => pipe(close, Effect.andThen(goTo(url, newTab))),
        });

      const activate = Effect.fn("Omnibar.activate")(
        function* (index: number, newTab: boolean) {
          const current = yield* pipe(Ref.get(session), Effect.flatMap(Effect.fromOption));
          const row = yield* pipe(
            Ref.get(current.rows),
            Effect.map(Array.get(index)),
            Effect.flatMap(Effect.fromOption),
          );
          yield* pipe(row.action, perform(current, newTab || current.newTab));
        },
        // No session, or no row at the index: the list changed under the key
        // or the click. Nothing happens.
        Effect.catchTag("NoSuchElementError", () => Effect.void),
      );

      /**
       * Start the work of a row, and give the key task back at once.
       *
       * Detached on purpose. To act closes the session, and a fiber of the
       * session scope would be interrupted before it opened the tab.
       * `startImmediately` keeps the call to the manager inside the activation
       * window of the key press.
       */
      const startActivation = (index: number, newTab: boolean): Effect.Effect<void> =>
        pipe(activate(index, newTab), Effect.forkDetach({ startImmediately: true }), Effect.asVoid);

      const startClose: Effect.Effect<void> = pipe(
        close,
        Effect.forkDetach({ startImmediately: true }),
        Effect.asVoid,
      );

      // ---------------------------------------------------------------
      // Keys
      // ---------------------------------------------------------------

      const move = Effect.fn("Omnibar.move")(function* (current: Session, delta: number) {
        const rows = yield* Ref.get(current.rows);
        yield* pipe(
          rows,
          Array.match({
            onEmpty: () => Effect.void,
            // It wraps, because a list this short is faster to cycle than to
            // turn around.
            onNonEmpty: (listed) =>
              pipe(
                Ref.updateAndGet(current.selected, step(delta, listed.length)),
                Effect.flatMap((selected) => current.view.render(listed, selected)),
              ),
          }),
        );
      });

      const acceptSelected = (current: Session, newTab: boolean): Effect.Effect<void> =>
        pipe(
          Ref.get(current.selected),
          Effect.flatMap((index) => startActivation(index, newTab)),
        );

      const onAction = (current: Session, action: OmnibarKeyAction): Effect.Effect<void> =>
        pipe(
          Match.value(action),
          Match.when("previous", () => move(current, -1)),
          Match.when("next", () => move(current, 1)),
          Match.when("accept", () => acceptSelected(current, false)),
          Match.when("accept-new-tab", () => acceptSelected(current, true)),
          Match.when("cancel", () => startClose),
          Match.exhaustive,
        );

      /**
       * Let our own field have the key, and swallow a key from anywhere else.
       *
       * `PASS_EVENT_TO_PAGE` stops the walk down the stack and leaves the
       * event alone, which is exactly "our field types this, and nothing else
       * reacts". A listener of the page on `document` still sees it,
       * retargeted to our shadow host. That cannot be prevented without the
       * extension-origin iframe that upstream Vimium has and we do not.
       */
      const passIfOurs = (view: OmnibarView, event: KeyboardEvent): HandlerResult =>
        pipe(
          view.ownsFocus(event.target),
          Boolean.match({ onTrue: () => PASS_EVENT_TO_PAGE, onFalse: () => SUPPRESS_EVENT }),
        );

      const onKeydown =
        (current: () => Option.Option<Session>, view: OmnibarView) =>
        (event: KeyboardEvent): Effect.Effect<HandlerResult> =>
          pipe(
            Option.all({ action: keyAction(event), live: current() }),
            Option.match({
              onNone: () => Effect.succeed(passIfOurs(view, event)),
              // `preventDefault` is more than tidiness here. Without it Tab
              // moves the focus out of the overlay, and the arrows move the
              // caret in the field.
              onSome: ({ action, live }) => pipe(onAction(live, action), Effect.as(SUPPRESS_EVENT)),
            }),
          );

      // ---------------------------------------------------------------
      // Opening
      // ---------------------------------------------------------------

      /**
       * Draw again for the new text.
       *
       * Any edit makes the choice stale: the row under the cursor is almost
       * never the row that the user now means.
       */
      const onInput: Effect.Effect<void> = pipe(
        Ref.get(session),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (live) => pipe(Ref.set(live.selected, 0), Effect.andThen(refresh(live))),
          }),
        ),
      );

      const open = Effect.fn("Omnibar.open")(function* (source: OmnibarSource, newTab: boolean) {
        yield* close;
        // The omnibar takes the keyboard, so a message that is still on
        // screen is no longer the thing that the user looks at.
        yield* hud.hide;

        const scope = yield* Scope.make();
        const rows = yield* Ref.make<readonly Completion[]>([]);
        const selected = yield* Ref.make(0);
        const suggestions = yield* Ref.make(Option.none<SuggestionState>());

        const view = yield* pipe(
          makeOmnibarView({
            placeholder: placeholderFor(source),
            onInput: () => onInput,
            onActivate: startActivation,
            onDismiss: close,
          }),
          Effect.provideContext(services),
          Scope.provide(scope),
        );

        const mode = yield* pipe(
          modes.enter(
            {
              name: "omnibar",
              indicator: Option.none(),
              // Escape is handled above, and not by the mode, so that the
              // overlay goes and the focus comes back before the frame does.
              exitOn: [],
              // The backstop, and not the mechanism. Read the file comment.
              keyboard: KeyPolicy.Owned(),
              singleton: Option.some("omnibar"),
            },
            {
              keydown: onKeydown(() => Ref.getUnsafe(session), view),
              keypress: (event) => Effect.succeed(passIfOurs(view, event)),
              keyup: (event) => Effect.succeed(passIfOurs(view, event)),
              focus: (event) =>
                // Keep insert mode, which sits below us, from reading a focus on
                // our own field as the page asking for insert mode.
                pipe(
                  view.ownsFocus(event.target),
                  Boolean.match({
                    onTrue: () => SUPPRESS_PROPAGATION,
                    onFalse: () => CONTINUE_BUBBLING,
                  }),
                  Effect.succeed,
                ),
            },
          ),
          Scope.provide(scope),
        );

        const current: Session = {
          source,
          newTab,
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
        yield* mode.onExit(() => pipe(close, Effect.when(isLive(current)), Effect.asVoid));

        yield* view.focus;
        yield* refresh(current);
      });

      // ---------------------------------------------------------------
      // Page bookkeeping
      // ---------------------------------------------------------------

      /** Refresh the signal of the tab at `href`. */
      const beat = Effect.fnUntraced(function* (href: string) {
        const title = yield* dom.probeOrElse(
          () => dom.document.title,
          () => "",
        );
        const now = yield* Clock.currentTimeMillis;
        yield* pipe(
          storage.session.update(
            Struct.evolve({ knownTabs: withSignal({ url: href, title, heartbeat: now }) }),
          ),
          Effect.ignore,
        );
      });

      /**
       * Refresh the signal of this tab, but only when it is already a tab that
       * we opened.
       *
       * To add an entry here would quietly turn a liveness list into a second
       * history index, and that is the very thing that must stay opt-in.
       */
      const heartbeat = Effect.fn("Omnibar.heartbeat")(function* () {
        const href = yield* dom.href;
        const stored = yield* storage.session.current;
        yield* pipe(
          stored.knownTabs,
          Array.some((tab) => tab.url === href),
          Boolean.match({ onFalse: () => Effect.void, onTrue: () => beat(href) }),
        );
      });

      /**
       * Erase the local index.
       *
       * This is a privacy control, and not plumbing. The README documents it as
       * the only way to erase the index, so it must report a failure to erase.
       */
      const clearHistory = Effect.fn("Omnibar.clearHistory")(function* () {
        yield* pipe(
          history.clear,
          Effect.matchEffect({
            onFailure: (error) =>
              report.error(`Could not erase the history index: ${error.detail}`),
            onSuccess: () => report.info("Local history index erased"),
          }),
        );
      });

      // A command body runs on a forked fiber, so it may suspend.
      yield* commands.registerAll({
        "Vomnibar.activate": () => open("url", false),
        "Vomnibar.activateInNewTab": () => open("url", true),
        "Vomnibar.activateCommands": () => open("command", false),
        "Vomnibar.activateSearch": () => open("search", false),
        // Tier C, and still a body. The row explains the refusal and shows the
        // shortcut of the browser, which a silent command cannot do.
        "Vomnibar.activateBookmarks": () => open("bookmark", false),
        "clear-history": () => clearHistory(),
      });

      // The session belongs to the layer scope as well, so that the runtime
      // takes the overlay with it when it stops.
      yield* Effect.addFinalizer(() => close);

      return Omnibar.of({
        noteVisit: pipe(history.record, Effect.andThen(heartbeat())),
      });
    }),
  );
}
