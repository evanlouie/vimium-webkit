/**
 * The completion sources of the omnibar.
 *
 * There is no `chrome.history` and no `chrome.bookmarks` in a userscript, so
 * this is not a copy of the address bar, and it does not pretend to be. What it
 * is:
 *
 * | Source     | How complete                                              |
 * | ---------- | --------------------------------------------------------- |
 * | Commands   | **Complete.** The catalogue is ours, tier C included.      |
 * | Engines    | **Complete.** The configuration is ours.                   |
 * | History    | Only what we recorded. Opt-in, and off by default.         |
 * | Recent     | Only tabs that *we* opened and that still send a signal.   |
 * | Suggestion | What the engine answers, when the manager can ask it.      |
 *
 * The label "Recent" is deliberate. "Tabs" would say that we can list the
 * window, which we cannot, and a list that quietly leaves out most of what it
 * claims to cover is worse than a list that names its limit.
 *
 * Everything in this file is pure. The whole list is calculated again from a
 * snapshot on every keystroke.
 */

import { Option } from "effect";
import type { CommandDef } from "~/domain/Command.ts";
import type { SessionState, Visit } from "~/domain/Persisted.ts";
import {
  buildSearchUrl,
  classifyQuery,
  enginesMatchingPrefix,
  type SearchEngine,
  splitKeyword,
  toNavigableUrl,
} from "~/domain/SearchEngine.ts";
import {
  historyScore,
  scoreCandidate,
  scoreText,
  tokenize,
} from "~/domain/Score.ts";

/** Which command opened the omnibar. It decides which sources are offered. */
export type OmnibarSource = "url" | "command" | "search" | "bookmark";

export type KnownTab = SessionState["knownTabs"][number];

export type CompletionKind =
  | "navigate"
  | "command"
  | "engine"
  | "history"
  | "recent"
  | "suggestion"
  | "notice";

export type CompletionAction =
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "command"; readonly name: string }
  /** Rewrite the input instead of acting. It adopts an engine keyword. */
  | { readonly type: "fill"; readonly text: string }
  | { readonly type: "none" };

export interface Completion {
  readonly kind: CompletionKind;
  /** The short source label on the row. */
  readonly badge: string;
  readonly title: string;
  readonly detail: string;
  readonly action: CompletionAction;
  readonly score: number;
  /**
   * Drawn grey. A tier C command, and the notice about bookmarks. To show
   * them is the point: a refusal that the user can see, with the shortcut of
   * the browser beside it, turns an absent capability into something that the
   * user can find.
   */
  readonly muted: boolean;
  /** For example `"⌘⇧T"`. Shown beside a grey row. */
  readonly nativeAlternative: Option.Option<string>;
}

/** More rows than this are noise. The list is to be read, and not scrolled. */
export const MAX_RESULTS = 10;

const COMMAND_LIMIT = 8;
const HISTORY_LIMIT = 6;
const RECENT_LIMIT = 4;
const ENGINE_LIMIT = 5;

/** The engine limit once the user has typed something. */
const ENGINE_LIMIT_WHILE_TYPING = 3;

/**
 * How long after its last signal a tab that we opened counts as gone.
 *
 * Generous, because the signal comes only when the document of that tab runs,
 * and WebKit stops the timers of a background tab.
 */
export const TAB_LIVENESS_MS = 5 * 60 * 1000;

/** The prefix that forces command mode, as `:` does in Vimium. */
export const COMMAND_PREFIX = ":";

/** The longest URL that a row shows. */
const DETAIL_LIMIT = 120;

const byScore = (left: Completion, right: Completion): number =>
  right.score - left.score;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * A tier C row goes down the list. It is not dropped.
 *
 * A command that works must never lose a tie against a command that only
 * explains itself and stops. The explanation is what a user who looks for
 * "restore tab" needs to read.
 */
const TIER_C_PENALTY = 0.5;

const toCommandCompletion = (
  command: CommandDef,
  muted: boolean,
  relevancy: number,
): Completion => ({
  kind: "command",
  badge: muted ? "Unavailable" : "Command",
  title: command.name,
  detail: muted
    ? command.unavailableReason ?? command.description
    : command.description,
  action: { type: "command", name: command.name },
  score: relevancy * (muted ? TIER_C_PENALTY : 1),
  muted,
  nativeAlternative: Option.fromNullishOr(command.nativeAlternative ?? null),
});

export const completeCommands = (
  commands: readonly CommandDef[],
  query: string,
  limit: number = COMMAND_LIMIT,
): readonly Completion[] => {
  const tokens = tokenize(query);

  const rows = commands.map((command) => {
    const muted = command.tier === "C";
    const relevancy = tokens.length === 0
      ? 1
      : scoreText(tokens, `${command.name} ${command.description}`);
    return toCommandCompletion(command, muted, relevancy);
  });

  const matched = tokens.length === 0
    ? rows
    : rows.filter((row) => row.score > 0);

  // With no query at all, alphabetical order beats the order of the catalogue.
  if (tokens.length === 0) {
    return [...matched]
      .sort((left, right) => left.title.localeCompare(right.title))
      .slice(0, limit);
  }
  return [...matched].sort(byScore).slice(0, limit);
};

// ---------------------------------------------------------------------------
// Search engines
// ---------------------------------------------------------------------------

/** The scores of the keyword ladder, from an exact hit down to a text hit. */
const KEYWORD_EXACT = 12;
const KEYWORD_PREFIX = 9;

/**
 * Offer the engine keywords while the user still types one.
 *
 * The action is `fill`, and not `navigate`. To choose `w` must put the user in
 * Wikipedia mode with the cursor ready, and must not search Wikipedia for
 * nothing.
 */
export const completeEngines = (
  engines: readonly SearchEngine[],
  query: string,
  limit: number = ENGINE_LIMIT,
): readonly Completion[] => {
  const trimmed = query.trim();
  // After a space the keyword is settled, and the navigate row takes over.
  if (/\s/u.test(trimmed)) return [];

  const tokens = tokenize(trimmed);
  const byPrefix = enginesMatchingPrefix(engines, trimmed);
  const pool = byPrefix.length > 0 ? byPrefix : engines;

  return pool
    .map((engine): Completion => ({
      kind: "engine",
      badge: "Search",
      title: `${engine.keyword}: ${engine.description}`,
      detail: engine.url,
      action: { type: "fill", text: `${engine.keyword} ` },
      score: trimmed.length === 0
        ? 1
        : engine.keyword === trimmed
        ? KEYWORD_EXACT
        : engine.keyword.startsWith(trimmed)
        ? KEYWORD_PREFIX
        : scoreText(tokens, `${engine.keyword} ${engine.description}`),
      muted: false,
      nativeAlternative: Option.none(),
    }))
    .filter((row) => row.score > 0)
    .sort(byScore)
    .slice(0, limit);
};

// ---------------------------------------------------------------------------
// Our own index
// ---------------------------------------------------------------------------

/** The weight of a visit in the list that an empty query gives. */
const EMPTY_QUERY_RELEVANCY = 0.1;

const toHistoryCompletion = (visit: Visit, score: number): Completion => ({
  kind: "history",
  badge: "Visited",
  title: visit.title.length > 0 ? visit.title : visit.url,
  detail: truncate(visit.url, DETAIL_LIMIT),
  action: { type: "navigate", url: visit.url },
  score,
  muted: false,
  nativeAlternative: Option.none(),
});

export const completeHistory = (
  visits: readonly Visit[],
  query: string,
  now: number,
  limit: number = HISTORY_LIMIT,
): readonly Completion[] => {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    // No query. The pages with the best frecency, which is the only order that
    // means anything before the user has said what they want.
    return [...visits]
      .sort((left, right) =>
        historyScore(1, right, now) - historyScore(1, left, now)
      )
      .slice(0, limit)
      .map((visit) =>
        toHistoryCompletion(
          visit,
          historyScore(EMPTY_QUERY_RELEVANCY, visit, now),
        )
      );
  }

  return visits
    .map((visit) => {
      const relevancy = scoreCandidate(tokens, {
        title: visit.title,
        url: visit.url,
      });
      return {
        visit,
        score: relevancy === 0 ? 0 : historyScore(relevancy, visit, now),
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => toHistoryCompletion(entry.visit, entry.score));
};

// ---------------------------------------------------------------------------
// The tabs that we opened
// ---------------------------------------------------------------------------

export const liveTabs = (
  tabs: readonly KnownTab[],
  now: number,
): readonly KnownTab[] =>
  tabs.filter((tab) => now - tab.heartbeat < TAB_LIVENESS_MS);

export const completeRecent = (
  tabs: readonly KnownTab[],
  query: string,
  now: number,
  limit: number = RECENT_LIMIT,
): readonly Completion[] => {
  const tokens = tokenize(query);
  const live = [...liveTabs(tabs, now)].sort((left, right) =>
    right.heartbeat - left.heartbeat
  );

  return live
    .map((tab) => ({
      tab,
      // The age of the signal breaks a tie. Nothing else about a tab that we
      // cannot inspect is a useful signal.
      score: tokens.length === 0
        ? 1
        : scoreCandidate(tokens, { title: tab.title, url: tab.url }),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry): Completion => ({
      kind: "recent",
      // "Recent", and never "Tabs": we see only the tabs that we opened
      // ourselves, and a label that said otherwise would be a statement that
      // the user acts on.
      badge: "Recent",
      title: entry.tab.title.length > 0 ? entry.tab.title : entry.tab.url,
      detail: truncate(entry.tab.url, DETAIL_LIMIT),
      action: { type: "navigate", url: entry.tab.url },
      score: entry.score,
      muted: false,
      nativeAlternative: Option.none(),
    }));
};

// ---------------------------------------------------------------------------
// The suggestions of the engine
// ---------------------------------------------------------------------------

/** The first suggestion sits below every source that we can vouch for. */
const SUGGESTION_BASE_SCORE = 3;
const SUGGESTION_STEP = 0.1;

export const completeSuggestions = (
  suggestions: readonly string[],
  searchTemplate: string,
  engineName: string,
): readonly Completion[] =>
  suggestions.map((suggestion, index): Completion => ({
    kind: "suggestion",
    badge: engineName,
    title: suggestion,
    detail: "",
    action: {
      type: "navigate",
      url: buildSearchUrl(searchTemplate, suggestion),
    },
    // Descending, and below the sources that we can vouch for. A suggestion is
    // the guess of the engine about the query, and not a page that the user
    // has been to.
    score: SUGGESTION_BASE_SCORE - index * SUGGESTION_STEP,
    muted: false,
    nativeAlternative: Option.none(),
  }));

// ---------------------------------------------------------------------------
// The default row
// ---------------------------------------------------------------------------

/**
 * What Enter does while no row is chosen.
 *
 * It is always there for a query that is not empty, and it is always first, so
 * that the omnibar keeps the property of an address bar: to type and to press
 * Enter does the obvious thing, and the user does not have to read the list.
 */
export const completeNavigate = (
  query: string,
  engines: readonly SearchEngine[],
  defaultSearchUrl: string,
): readonly Completion[] => {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const split = splitKeyword(trimmed, engines);
  if (Option.isSome(split) && split.value.rest.length > 0) {
    const url = buildSearchUrl(split.value.engine.url, split.value.rest);
    return [{
      kind: "navigate",
      badge: split.value.engine.description,
      title: split.value.rest,
      detail: url,
      action: { type: "navigate", url },
      score: Number.POSITIVE_INFINITY,
      muted: false,
      nativeAlternative: Option.none(),
    }];
  }

  if (classifyQuery(trimmed) === "url") {
    const url = toNavigableUrl(trimmed);
    return [{
      kind: "navigate",
      badge: "Open",
      title: url,
      detail: "",
      action: { type: "navigate", url },
      score: Number.POSITIVE_INFINITY,
      muted: false,
      nativeAlternative: Option.none(),
    }];
  }

  const url = buildSearchUrl(defaultSearchUrl, trimmed);
  return [{
    kind: "navigate",
    badge: "Search",
    title: trimmed,
    detail: url,
    action: { type: "navigate", url },
    score: Number.POSITIVE_INFINITY,
    muted: false,
    nativeAlternative: Option.none(),
  }];
};

/**
 * The honest answer to `b`, which opens a bookmark.
 *
 * `chrome.bookmarks` does not exist for a userscript, and it never will. The
 * omnibar therefore shows the refusal and the shortcut of the browser, instead
 * of doing nothing, and then goes on to offer everything that it *can* do.
 */
export const bookmarkNotice = (): Completion => ({
  kind: "notice",
  badge: "Unavailable",
  title: "Bookmarks are not reachable from a userscript",
  detail: "There is no bookmarks API outside a browser extension.",
  action: { type: "none" },
  score: Number.POSITIVE_INFINITY,
  muted: true,
  nativeAlternative: Option.some("⌥⌘B"),
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface CompletionInput {
  readonly source: OmnibarSource;
  readonly query: string;
  readonly commands: readonly CommandDef[];
  readonly engines: readonly SearchEngine[];
  readonly searchUrl: string;
  readonly visits: readonly Visit[];
  readonly knownTabs: readonly KnownTab[];
  readonly suggestions: readonly string[];
  readonly suggestionEngine: string;
  readonly now: number;
}

export interface CompletionState {
  /** True in command mode, so that the view can show the `:` prefix. */
  readonly commandMode: boolean;
  /** The query with the `:` prefix removed. */
  readonly effectiveQuery: string;
  readonly rows: readonly Completion[];
}

/** A `:` prefix, or the `command` source, means commands and nothing else. */
const isCommandMode = (source: OmnibarSource, query: string): boolean =>
  source === "command" || query.trimStart().startsWith(COMMAND_PREFIX);

export const stripCommandPrefix = (query: string): string => {
  const trimmed = query.trimStart();
  return trimmed.startsWith(COMMAND_PREFIX)
    ? trimmed.slice(COMMAND_PREFIX.length).trim()
    : trimmed.trim();
};

const actionKey = (action: CompletionAction): Option.Option<string> => {
  switch (action.type) {
    case "navigate":
      return Option.some(`navigate:${action.url}`);
    case "command":
      return Option.some(`command:${action.name}`);
    case "fill":
      return Option.some(`fill:${action.text}`);
    case "none":
      return Option.none();
  }
};

/**
 * Join the rows that would do the same thing.
 *
 * The default row and a history entry for the same URL are the usual case. The
 * first one wins, because the list is already in the order of priority.
 */
const dedupe = (rows: readonly Completion[]): readonly Completion[] => {
  const seen = new Set<string>();
  const out: Completion[] = [];
  for (const row of rows) {
    const key = actionKey(row.action);
    if (Option.isSome(key)) {
      if (seen.has(key.value)) continue;
      seen.add(key.value);
    }
    out.push(row);
  }
  return out;
};

export const completionsFor = (input: CompletionInput): CompletionState => {
  const commandMode = isCommandMode(input.source, input.query);
  const effectiveQuery = commandMode
    ? stripCommandPrefix(input.query)
    : input.query;

  if (commandMode) {
    return {
      commandMode,
      effectiveQuery,
      rows: completeCommands(input.commands, effectiveQuery, MAX_RESULTS),
    };
  }

  const rows: Completion[] = [];
  if (input.source === "bookmark") rows.push(bookmarkNotice());
  rows.push(
    ...completeNavigate(effectiveQuery, input.engines, input.searchUrl),
  );

  if (input.source !== "search") {
    rows.push(...completeHistory(input.visits, effectiveQuery, input.now));
    rows.push(...completeRecent(input.knownTabs, effectiveQuery, input.now));
  }
  // The engines are limited once the user types. To find a keyword matters,
  // but not enough to push the sources below it off the screen.
  rows.push(
    ...completeEngines(
      input.engines,
      effectiveQuery,
      effectiveQuery.trim().length === 0
        ? ENGINE_LIMIT
        : ENGINE_LIMIT_WHILE_TYPING,
    ),
  );
  rows.push(
    ...completeSuggestions(
      input.suggestions,
      input.searchUrl,
      input.suggestionEngine,
    ),
  );

  // The list is deliberately *not* sorted again as a whole. Each source scores
  // on its own scale — the ladder score of a command and the frecency score of
  // a visit are not comparable numbers — so the order of the groups above is
  // the ranking, and each group is in the order of its own scoring.
  return {
    commandMode,
    effectiveQuery,
    rows: dedupe(rows).slice(0, MAX_RESULTS),
  };
};
