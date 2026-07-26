/**
 * Omnibar-lite (IMPLEMENTATION_PLAN.md §6.7).
 *
 * `createOmnibar` owns the session lifecycle: overlay, mode, completion
 * snapshot, and the network-backed suggestion stream. The pure pieces —
 * engine-config parsing, scoring, completion assembly — are re-exported because
 * the settings UI and the tests want them, not because they are part of the
 * runtime contract.
 *
 * The framing is the important part. This is not a `⌘L` clone: there is no
 * `chrome.history` and no `chrome.bookmarks` for a userscript, so the omnibar
 * offers the things it can actually be complete about (commands, search
 * engines) alongside clearly-labelled partial sources (our own opt-in frecency
 * index, tabs we opened ourselves) and says so on every row.
 */

import type {
  AppContext,
  CommandDef,
  OmnibarApi,
  OmnibarSource,
} from "~/core/context.ts";
import { navigate, openTab } from "~/platform/tabs.ts";
import type { SessionState } from "~/settings/schema.ts";
import { type Completion, completionsFor, liveTabs } from "./completers.ts";
import { parseSearchEngines, type SearchEngine } from "./engines.ts";
import {
  createHistoryIndex,
  type HistoryIndexApi,
  type RecordingBlock,
} from "./history.ts";
import { type OmnibarKeyAction, OmnibarMode } from "./mode.ts";
import { OMNIBAR_CSS } from "./styles.ts";
import { createSuggester, type Suggester } from "./suggest.ts";
import { OmnibarView } from "./ui.ts";

export type {
  EngineDiagnostic,
  ParsedSearchEngines,
  QueryKind,
  SearchEngine,
} from "./engines.ts";
export {
  buildSearchUrl,
  classifyQuery,
  enginesMatchingPrefix,
  parseSearchEngines,
  resolveQuery,
  splitKeyword,
  toNavigableUrl,
} from "./engines.ts";
export type { FrecencyInput, ScoreTarget } from "./scoring.ts";
export {
  frecencyScore,
  historyScore,
  recencyScore,
  scoreCandidate,
  scoreText,
  tokenize,
} from "./scoring.ts";
export type {
  Completion,
  CompletionAction,
  CompletionInput,
  CompletionKind,
  CompletionState,
  KnownTab,
} from "./completers.ts";
export {
  completeCommands,
  completeEngines,
  completeHistory,
  completeNavigate,
  completeRecent,
  completeSuggestions,
  completionsFor,
  MAX_RESULTS,
} from "./completers.ts";
export type {
  HistoryIndexApi,
  PrivacyProbe,
  RecordingBlock,
} from "./history.ts";
export {
  canonicaliseUrl,
  createHistoryIndex,
  detectPrivateBrowsing,
  globToRegExp,
  matchesDenylist,
  mergeVisit,
} from "./history.ts";
export type { Suggester } from "./suggest.ts";
export {
  createSuggester,
  parseSuggestResponse,
  suggestEndpointFor,
} from "./suggest.ts";
export { OMNIBAR_CSS } from "./styles.ts";
export { omnibarAction, OmnibarMode } from "./mode.ts";
export { OmnibarView } from "./ui.ts";

/**
 * The omnibar surface, plus the hooks the bootstrap and the command registry
 * need.
 *
 * `noteVisit` is here rather than on `OmnibarApi` because it is wiring, not a
 * user-facing verb: it is called once per page load.
 */
export interface OmnibarLiteApi extends OmnibarApi {
  /**
   * Record this page in the opt-in frecency index and refresh the heartbeat for
   * this tab. Safe and cheap to call unconditionally: every privacy gate lives
   * inside, and with `enableHistoryIndex` off this is a no-op.
   */
  noteVisit(): void;
  /** `null` when recording is on; otherwise why it is off. For HUD messages. */
  historyRecordingBlockedBy(): RecordingBlock | null;
}

const PLACEHOLDERS: Readonly<Record<OmnibarSource, string>> = {
  url: "Search or type a URL",
  command: "Run a command",
  search: "Search the web",
  bookmark: "Search or type a URL",
};

const KEY_LEGEND = "↑↓ move · ⏎ open · ⇧⏎ new tab · esc close";

interface Session {
  readonly source: OmnibarSource;
  readonly view: OmnibarView;
  readonly mode: OmnibarMode;
  rows: readonly Completion[];
  selected: number;
  /** Suggestions for `suggestionQuery`; dropped as soon as the query moves on. */
  suggestions: readonly string[];
  suggestionQuery: string;
  suggestionEngine: string;
}

export const createOmnibar = (app: AppContext): OmnibarLiteApi => {
  const history: HistoryIndexApi = createHistoryIndex(app);
  const suggester: Suggester = createSuggester(app.gm);

  let session: Session | null = null;
  let stylesInstalled = false;

  /** Parsed engines, memoised on the raw config string. */
  let engineSource: string | null = null;
  let engineCache: { engines: readonly SearchEngine[]; badLines: number } = {
    engines: [],
    badLines: 0,
  };

  const engines = (): {
    engines: readonly SearchEngine[];
    badLines: number;
  } => {
    const source = app.settings().searchEngines;
    if (source !== engineSource) {
      engineSource = source;
      const parsed = parseSearchEngines(source);
      engineCache = {
        engines: parsed.engines,
        badLines: parsed.diagnostics.length,
      };
    }
    return engineCache;
  };

  const ensureStyles = (): void => {
    if (stylesInstalled) return;
    stylesInstalled = true;
    // CSSOM only. A `<style>` element here would be subject to the page's
    // `style-src` and silently blocked on any CSP-hardened site.
    app.ui.addStyle(OMNIBAR_CSS);
  };

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  const commandList = (): readonly CommandDef[] => app.commands.all();

  /**
   * Only honour suggestions that belong to the query on screen; a late response
   * for a query the user has already moved past is worse than none.
   */
  const visibleSuggestions = (
    current: Session,
    query: string,
  ): readonly string[] =>
    current.suggestionQuery === query.trim() ? current.suggestions : [];

  const render = (current: Session, kickSuggestions: boolean): void => {
    const settings = app.settings();
    const { engines: parsed, badLines } = engines();
    const query = current.view.value;

    const state = completionsFor({
      source: current.source,
      query,
      commands: commandList(),
      engines: parsed,
      searchUrl: settings.searchUrl,
      visits: history.visits(),
      knownTabs: liveTabs(app.groups.session.current().knownTabs, Date.now()),
      suggestions: visibleSuggestions(current, query),
      suggestionEngine: current.suggestionEngine,
      now: Date.now(),
    });

    current.rows = state.rows;
    current.selected = Math.min(
      Math.max(current.selected, 0),
      Math.max(0, state.rows.length - 1),
    );

    current.view.setPrefix(state.commandMode ? ":" : "›");
    current.view.setFooter(
      badLines === 0
        ? KEY_LEGEND
        : `${KEY_LEGEND} · ${badLines} malformed searchEngines line${
          badLines === 1 ? "" : "s"
        }`,
    );
    current.view.render(current.rows, current.selected);

    if (kickSuggestions && !state.commandMode) {
      requestSuggestions(current, state.effectiveQuery);
    }
  };

  // -------------------------------------------------------------------------
  // Suggestions
  // -------------------------------------------------------------------------

  const requestSuggestions = (current: Session, query: string): void => {
    if (!suggester.isAvailable()) return;

    const settings = app.settings();
    const { engines: parsed } = engines();

    // A keyword prefix redirects suggestions to that engine, which is what the
    // user has asked for by typing it.
    const split = parsed.length === 0 ? null : findKeyword(parsed, query);
    const template = split?.engine.url ?? settings.searchUrl;
    const text = split?.rest ?? query;
    current.suggestionEngine = split?.engine.description ?? "Suggested";

    // Keyed on the *whole* input, not on the text sent to the engine, so that
    // `visibleSuggestions` can compare against what is actually on screen.
    const forQuery = query.trim();

    suggester.request(template, text, (_answered, suggestions) => {
      if (session !== current) return;
      current.suggestions = suggestions;
      current.suggestionQuery = forQuery;
      // Re-render only; kicking again here would loop.
      render(current, false);
    });
  };

  const findKeyword = (
    parsed: readonly SearchEngine[],
    query: string,
  ): { engine: SearchEngine; rest: string } | null => {
    const boundary = query.indexOf(" ");
    if (boundary === -1) return null;
    const head = query.slice(0, boundary);
    const engine = parsed.find((candidate) => candidate.keyword === head);
    if (engine === undefined) return null;
    return { engine, rest: query.slice(boundary + 1).trim() };
  };

  // -------------------------------------------------------------------------
  // Activation
  // -------------------------------------------------------------------------

  const registerOpenedTab = (url: string, title: string): void => {
    const now = Date.now();
    void app.groups.session.update((current): SessionState => ({
      ...current,
      // Pruned on every write: a list of tabs that are no longer alive is both
      // misleading in the completion list and unbounded growth in storage.
      knownTabs: [
        { url, title, heartbeat: now },
        ...liveTabs(current.knownTabs, now).filter((tab) => tab.url !== url),
      ],
    }));
  };

  const openInNewTab = (url: string): void => {
    void openTab(app.gm, url, { active: true }).match(
      (outcome) => registerOpenedTab(outcome.url, ""),
      (error) => {
        app.hud.error(
          error.nativeAlternative === undefined
            ? error.message
            : `${error.message} (${error.nativeAlternative})`,
        );
      },
    );
  };

  const activate = (index: number, newTab: boolean): void => {
    const current = session;
    if (current === null) return;
    const row = current.rows[index];
    if (row === undefined) return;

    switch (row.action.type) {
      case "fill": {
        // Adopting an engine keyword is a refinement, not a destination; the
        // omnibar stays open with the cursor after the keyword.
        current.view.setValue(row.action.text);
        current.selected = 0;
        render(current, true);
        return;
      }
      case "none": {
        close();
        return;
      }
      case "command": {
        const name = row.action.name;
        close();
        // Tier C commands are run rather than blocked: the registry's own stub
        // owns the refusal message, and duplicating it here would let the two
        // drift apart.
        app.commands.run(name, { count: 1, options: {}, event: null, app });
        return;
      }
      case "navigate": {
        const url = row.action.url;
        close();
        if (newTab) openInNewTab(url);
        else {
          const result = navigate(url);
          if (result.isErr()) app.hud.error(result.error.message);
        }
        return;
      }
    }
  };

  // -------------------------------------------------------------------------
  // Key actions
  // -------------------------------------------------------------------------

  const move = (current: Session, delta: number): void => {
    const count = current.rows.length;
    if (count === 0) return;
    // Wraps, because a list this short is faster to cycle than to reverse.
    current.selected = (((current.selected + delta) % count) + count) % count;
    current.view.render(current.rows, current.selected);
  };

  const onAction = (action: OmnibarKeyAction): void => {
    const current = session;
    if (current === null) return;
    switch (action) {
      case "previous":
        move(current, -1);
        return;
      case "next":
        move(current, 1);
        return;
      case "accept":
        activate(current.selected, false);
        return;
      case "accept-new-tab":
        activate(current.selected, true);
        return;
      case "cancel":
        close();
        return;
    }
  };

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  const close = (): void => {
    const current = session;
    session = null;
    if (current === null) return;
    suggester.cancel();
    current.view.dispose();
    current.mode.exit("explicit");
  };

  const open = (source: OmnibarSource, initialQuery?: string): void => {
    ensureStyles();
    close();

    const view = new OmnibarView({
      app,
      placeholder: PLACEHOLDERS[source],
      onInput: () => {
        const live = session;
        if (live === null) return;
        // Any edit invalidates the selection: the row under the cursor is
        // almost never the row the user now means.
        live.selected = 0;
        render(live, true);
      },
      onActivate: activate,
      onDismiss: close,
    });

    const mode = new OmnibarMode({
      app,
      // `app.ui.owns` as well as the view's own check: the overlay lives in a
      // *closed* shadow root, so an event seen from a `window`-level listener
      // has already been retargeted to the host and will never equal the input.
      ownsFocus: (target) => view.ownsFocus(target) || app.ui.owns(target),
      onAction,
    });

    const current: Session = {
      source,
      view,
      mode,
      rows: [],
      selected: 0,
      suggestions: [],
      suggestionQuery: "",
      suggestionEngine: "Suggested",
    };
    session = current;

    mode.enter();
    // Anything that evicts us (another singleton, a navigation) must take the
    // overlay with it, or the user is left with an unreachable input.
    mode.onExit(() => {
      if (session === current) close();
    });

    // The optional initial query is what "open link with omnibar" hands us.
    view.setValue(initialQuery ?? "");
    view.focus();
    render(current, true);
  };

  // -------------------------------------------------------------------------
  // Page-load bookkeeping
  // -------------------------------------------------------------------------

  /**
   * Refresh the heartbeat for this tab — but only if it is already a tab we
   * opened. Adding an entry here would quietly turn a liveness list into a
   * second history index, which is exactly the thing §6.7 requires to be
   * opt-in.
   */
  const heartbeat = (): void => {
    const url = location.href;
    const known = app.groups.session.current().knownTabs;
    if (!known.some((tab) => tab.url === url)) return;

    const now = Date.now();
    const title = document.title;
    void app.groups.session.update((current): SessionState => ({
      ...current,
      knownTabs: liveTabs(current.knownTabs, now).map((tab) =>
        tab.url === url ? { url, title, heartbeat: now } : tab
      ),
    }));
  };

  return {
    open,
    close,

    noteVisit: (): void => {
      history.record();
      heartbeat();
    },

    clearHistory: (): Promise<void> => history.clear(),

    historyRecordingBlockedBy: (): RecordingBlock | null => history.blockedBy(),
  };
};
