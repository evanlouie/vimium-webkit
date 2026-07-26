/**
 * Completion sources (IMPLEMENTATION_PLAN.md §6.7).
 *
 * There is no `chrome.history` and no `chrome.bookmarks` in a userscript, so
 * this is not a `⌘L` clone and does not pretend to be. What it is:
 *
 * | Source     | Completeness                                                  |
 * | ---------- | ------------------------------------------------------------- |
 * | Commands   | **Total.** The registry is ours, including Tier C entries.     |
 * | Engines    | **Total.** The config is ours.                                 |
 * | History    | Only what we recorded. Opt-in, off by default.                 |
 * | Recent     | Only tabs *we* opened and that are still heartbeating.         |
 * | Suggestion | Whatever the engine returns, when `@connect` exists.           |
 *
 * The "Recent" label is deliberate and load-bearing: calling it "Tabs" would
 * imply we can enumerate the window, which we cannot, and a completion list
 * that silently omits most of what it claims to cover is worse than one that
 * names its scope honestly.
 *
 * Everything in this module is pure — the whole list is recomputed from a
 * snapshot on every keystroke.
 */

import type { CommandDef, OmnibarSource } from "~/core/context.ts";
import type { SessionState, Visit } from "~/settings/schema.ts";
import {
  buildSearchUrl,
  classifyQuery,
  enginesMatchingPrefix,
  type SearchEngine,
  splitKeyword,
  toNavigableUrl,
} from "./engines.ts";
import {
  historyScore,
  scoreCandidate,
  scoreText,
  tokenize,
} from "./scoring.ts";

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
  /** Rewrite the input rather than acting; used to adopt an engine keyword. */
  | { readonly type: "fill"; readonly text: string }
  | { readonly type: "none" };

export interface Completion {
  readonly kind: CompletionKind;
  /** Short source label shown on the row. */
  readonly badge: string;
  readonly title: string;
  readonly detail: string;
  readonly action: CompletionAction;
  readonly score: number;
  /**
   * Rendered greyed out. Tier C commands and the no-bookmarks notice; per §4.3
   * showing them at all is the point — a visible refusal with the native
   * shortcut alongside turns a missing capability into a discoverability win.
   */
  readonly muted: boolean;
  /** e.g. `"⌘⇧T"`. Shown next to a muted row. */
  readonly nativeAlternative: string | null;
}

/** Rows beyond this are noise; the list is meant to be read, not scrolled. */
export const MAX_RESULTS = 10;

const COMMAND_LIMIT = 8;
const HISTORY_LIMIT = 6;
const RECENT_LIMIT = 4;
const ENGINE_LIMIT = 5;

/**
 * How long after its last heartbeat a tab we opened is presumed gone.
 *
 * Generous, because the heartbeat only fires when that tab's document runs, and
 * WebKit freezes timers in background tabs.
 */
export const TAB_LIVENESS_MS = 5 * 60 * 1000;

/** The prefix that forces command mode, mirroring Vimium's `:`. */
export const COMMAND_PREFIX = ":";

const byScore = (a: Completion, b: Completion): number => b.score - a.score;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Tier C rows are demoted, not dropped.
 *
 * A working command should never lose a tie to one that is going to explain
 * itself and stop, but the explanation is exactly what a user hunting for
 * "restore tab" needs to see.
 */
const TIER_C_PENALTY = 0.5;

export const completeCommands = (
  commands: readonly CommandDef[],
  query: string,
  limit = COMMAND_LIMIT,
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

  // With no query at all, alphabetical beats an arbitrary registry order.
  if (tokens.length === 0) {
    return [...matched]
      .sort((a, b) => a.title.localeCompare(b.title))
      .slice(0, limit);
  }
  return [...matched].sort(byScore).slice(0, limit);
};

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
  nativeAlternative: command.nativeAlternative ?? null,
});

// ---------------------------------------------------------------------------
// Search engines
// ---------------------------------------------------------------------------

/**
 * Offer engine keywords while the user is still typing one.
 *
 * The action is `fill`, not `navigate`: selecting `w` should put the user in
 * Wikipedia mode with the cursor ready, not search Wikipedia for nothing.
 */
export const completeEngines = (
  engines: readonly SearchEngine[],
  query: string,
  limit = ENGINE_LIMIT,
): readonly Completion[] => {
  const trimmed = query.trim();
  // Once there is a space the keyword is settled; the navigate row takes over.
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
        ? 12
        : engine.keyword.startsWith(trimmed)
        ? 9
        : scoreText(tokens, `${engine.keyword} ${engine.description}`),
      muted: false,
      nativeAlternative: null,
    }))
    .filter((row) => row.score > 0)
    .sort(byScore)
    .slice(0, limit);
};

// ---------------------------------------------------------------------------
// Our own frecency index
// ---------------------------------------------------------------------------

export const completeHistory = (
  visits: readonly Visit[],
  query: string,
  now: number,
  limit = HISTORY_LIMIT,
): readonly Completion[] => {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    // No query: the most frecent pages, which is the only ordering that means
    // anything before the user has said what they want.
    return [...visits]
      .sort((a, b) => historyScore(1, b, now) - historyScore(1, a, now))
      .slice(0, limit)
      .map((visit) =>
        toHistoryCompletion(visit, historyScore(0.1, visit, now))
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
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => toHistoryCompletion(entry.visit, entry.score));
};

const toHistoryCompletion = (visit: Visit, score: number): Completion => ({
  kind: "history",
  badge: "Visited",
  title: visit.title.length > 0 ? visit.title : visit.url,
  detail: truncate(visit.url, 120),
  action: { type: "navigate", url: visit.url },
  score,
  muted: false,
  nativeAlternative: null,
});

// ---------------------------------------------------------------------------
// Tabs we opened
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
  limit = RECENT_LIMIT,
): readonly Completion[] => {
  const tokens = tokenize(query);
  const live = [...liveTabs(tabs, now)].sort((a, b) =>
    b.heartbeat - a.heartbeat
  );

  const rows = live.map((tab) => {
    const relevancy = tokens.length === 0
      ? 1
      : scoreCandidate(tokens, { title: tab.title, url: tab.url });
    return {
      tab,
      // Recency of the heartbeat breaks ties; nothing else about a tab we
      // cannot inspect is a useful ranking signal.
      score: relevancy,
    };
  });

  return rows
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry): Completion => ({
      kind: "recent",
      // "Recent", never "Tabs": we can only see tabs we opened ourselves, and a
      // label that implied otherwise would be a lie the user acts on.
      badge: "Recent",
      title: entry.tab.title.length > 0 ? entry.tab.title : entry.tab.url,
      detail: truncate(entry.tab.url, 120),
      action: { type: "navigate", url: entry.tab.url },
      score: entry.score,
      muted: false,
      nativeAlternative: null,
    }));
};

// ---------------------------------------------------------------------------
// Engine suggestions
// ---------------------------------------------------------------------------

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
    // Descending, and below the sources we can vouch for: a suggestion is the
    // engine's guess about the query, not a place the user has been.
    score: 3 - index * 0.1,
    muted: false,
    nativeAlternative: null,
  }));

// ---------------------------------------------------------------------------
// The default row
// ---------------------------------------------------------------------------

/**
 * What `Enter` does with nothing selected.
 *
 * Always present (given a non-empty query) and always first, so the omnibar has
 * the address-bar property that typing and pressing Enter does the obvious
 * thing without reading the list.
 */
export const completeNavigate = (
  query: string,
  engines: readonly SearchEngine[],
  defaultSearchUrl: string,
): readonly Completion[] => {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const split = splitKeyword(trimmed, engines);
  if (split !== null && split.rest.length > 0) {
    return [{
      kind: "navigate",
      badge: split.engine.description,
      title: split.rest,
      detail: buildSearchUrl(split.engine.url, split.rest),
      action: {
        type: "navigate",
        url: buildSearchUrl(split.engine.url, split.rest),
      },
      score: Number.POSITIVE_INFINITY,
      muted: false,
      nativeAlternative: null,
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
      nativeAlternative: null,
    }];
  }

  return [{
    kind: "navigate",
    badge: "Search",
    title: trimmed,
    detail: buildSearchUrl(defaultSearchUrl, trimmed),
    action: {
      type: "navigate",
      url: buildSearchUrl(defaultSearchUrl, trimmed),
    },
    score: Number.POSITIVE_INFINITY,
    muted: false,
    nativeAlternative: null,
  }];
};

/**
 * The honest answer to `B` (open a bookmark).
 *
 * `chrome.bookmarks` does not exist for a userscript and never will, so rather
 * than a silent no-op the omnibar shows the refusal and the native shortcut,
 * then carries on offering everything it *can* do.
 */
export const bookmarkNotice = (): Completion => ({
  kind: "notice",
  badge: "Unavailable",
  title: "Bookmarks are not reachable from a userscript",
  detail: "There is no bookmarks API outside a browser extension.",
  action: { type: "none" },
  score: Number.POSITIVE_INFINITY,
  muted: true,
  nativeAlternative: "⌥⌘B",
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
  /** Whether the query is in command mode, so the UI can show the `:` badge. */
  readonly commandMode: boolean;
  /** The query with any `:` prefix removed. */
  readonly effectiveQuery: string;
  readonly rows: readonly Completion[];
}

/** `:`-prefixed input, or the `command` source, means commands and nothing else. */
const isCommandMode = (source: OmnibarSource, query: string): boolean =>
  source === "command" || query.trimStart().startsWith(COMMAND_PREFIX);

export const stripCommandPrefix = (query: string): string => {
  const trimmed = query.trimStart();
  return trimmed.startsWith(COMMAND_PREFIX)
    ? trimmed.slice(COMMAND_PREFIX.length).trim()
    : trimmed.trim();
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
  // Engines are capped once the user is typing something: keyword discovery
  // matters, but not enough to crowd out the sources below it.
  rows.push(
    ...completeEngines(
      input.engines,
      effectiveQuery,
      effectiveQuery.trim().length === 0 ? ENGINE_LIMIT : 3,
    ),
  );
  rows.push(
    ...completeSuggestions(
      input.suggestions,
      input.searchUrl,
      input.suggestionEngine,
    ),
  );

  // Deliberately *not* globally re-sorted. Each source scores on its own scale —
  // a command's ladder score and a history entry's frecency-weighted score are
  // not comparable numbers — so the group order above is the ranking, and each
  // group is internally ordered by its own scoring.
  return {
    commandMode,
    effectiveQuery,
    rows: dedupe(rows).slice(0, MAX_RESULTS),
  };
};

/**
 * Collapse rows that would do the same thing.
 *
 * The default row and a history entry for the same URL are the common case;
 * the first occurrence wins because the list is already in priority order.
 */
const dedupe = (rows: readonly Completion[]): readonly Completion[] => {
  const seen = new Set<string>();
  const out: Completion[] = [];
  for (const row of rows) {
    const key = actionKey(row.action);
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(row);
  }
  return out;
};

const actionKey = (action: CompletionAction): string | null => {
  switch (action.type) {
    case "navigate":
      return `navigate:${action.url}`;
    case "command":
      return `command:${action.name}`;
    case "fill":
      return `fill:${action.text}`;
    case "none":
      return null;
  }
};
