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

import { Array, Boolean, Data, Equal, Match, Number, Option, Order, pipe, String } from "effect";
import { CommandAvailability, type CommandDef } from "~/domain/Command.ts";
import type { SessionState, Visit } from "~/domain/Persisted.ts";
import {
  buildSearchUrl,
  Destination,
  destinationOf,
  enginesMatchingPrefix,
  type SearchEngine,
} from "~/domain/SearchEngine.ts";
import { historyScore, scoreCandidate, scoreText, tokenize } from "~/domain/Score.ts";

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

export type CompletionAction = Data.TaggedEnum<{
  Navigate: { readonly url: string };
  Command: { readonly name: string };
  /** Rewrite the input instead of acting. It adopts an engine keyword. */
  Fill: { readonly text: string };
  /** Nothing to do. To choose the row closes the omnibar. */
  Dismiss: Record<never, never>;
}>;

export const CompletionAction = Data.taggedEnum<CompletionAction>();

export interface Completion {
  readonly kind: CompletionKind;
  /** The short source label on the row. */
  readonly badge: string;
  readonly title: string;
  /** Empty for a row that has nothing to add below its title. */
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

/** Highest first. A sort is stable, so a tie keeps the order that came in. */
const descending = <A>(score: (item: A) => number): Order.Order<A> =>
  pipe(Order.Number, Order.mapInput(score), Order.flip);

const byScore: Order.Order<Completion> = descending((row) => row.score);

const byTitle: Order.Order<Completion> = (left, right) =>
  Number.sign(left.title.localeCompare(right.title));

/** A row with a score of zero matched nothing, and is not shown. */
const isMatch = (row: Completion): boolean => row.score > 0;

const shortUrl = (url: string): string =>
  pipe(
    url.length <= DETAIL_LIMIT,
    Boolean.match({
      onTrue: () => url,
      onFalse: () => `${url.slice(0, DETAIL_LIMIT - 1)}…`,
    }),
  );

/** The title of a page, or its URL when the page gave no title. */
const pageTitle = (page: { readonly title: string; readonly url: string }): string =>
  pipe(
    page.title,
    Option.liftPredicate(String.isNonEmpty),
    Option.getOrElse(() => page.url),
  );

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

/** How a command reads in the list, by whether it works. */
interface CommandPresentation {
  readonly badge: string;
  readonly detail: string;
  readonly weight: number;
  readonly muted: boolean;
  readonly nativeAlternative: Option.Option<string>;
}

const presentationOf = (command: CommandDef): CommandPresentation =>
  pipe(
    command.availability,
    CommandAvailability.$match({
      Available: (): CommandPresentation => ({
        badge: "Command",
        detail: command.description,
        weight: 1,
        muted: false,
        nativeAlternative: Option.none(),
      }),
      Unavailable: ({ reason, nativeAlternative }): CommandPresentation => ({
        badge: "Unavailable",
        detail: reason,
        weight: TIER_C_PENALTY,
        muted: true,
        nativeAlternative,
      }),
    }),
  );

const commandRow = (command: CommandDef, relevancy: number): Completion =>
  pipe(
    presentationOf(command),
    ({ badge, detail, weight, muted, nativeAlternative }): Completion => ({
      kind: "command",
      badge,
      title: command.name,
      detail,
      action: CompletionAction.Command({ name: command.name }),
      score: relevancy * weight,
      muted,
      nativeAlternative,
    }),
  );

export const completeCommands = (
  commands: readonly CommandDef[],
  query: string,
  limit: number = COMMAND_LIMIT,
): readonly Completion[] =>
  pipe(
    query,
    tokenize,
    Array.match({
      // With no query at all, alphabetical order beats the order of the
      // catalogue.
      onEmpty: () =>
        pipe(
          commands,
          Array.map((command) => commandRow(command, 1)),
          Array.sort(byTitle),
        ),
      onNonEmpty: (tokens) =>
        pipe(
          commands,
          Array.map((command) =>
            commandRow(command, scoreText(tokens, `${command.name} ${command.description}`)),
          ),
          Array.filter(isMatch),
          Array.sort(byScore),
        ),
    }),
    Array.take(limit),
  );

// ---------------------------------------------------------------------------
// Search engines
// ---------------------------------------------------------------------------

/** The scores of the keyword ladder, from an exact hit down to a text hit. */
const KEYWORD_EXACT = 12;
const KEYWORD_PREFIX = 9;

const engineRow = (engine: SearchEngine, score: number): Completion => ({
  kind: "engine",
  badge: "Search",
  title: `${engine.keyword}: ${engine.description}`,
  detail: engine.url,
  action: CompletionAction.Fill({ text: `${engine.keyword} ` }),
  score,
  muted: false,
  nativeAlternative: Option.none(),
});

/** How well an engine answers a keyword that is still being typed. */
const keywordScore = (typed: string) => {
  const tokens = tokenize(typed);
  return (engine: SearchEngine): number =>
    pipe(
      Match.value(engine.keyword),
      Match.when(
        (keyword: string) => keyword === typed,
        () => KEYWORD_EXACT,
      ),
      Match.when(String.startsWith(typed), () => KEYWORD_PREFIX),
      Match.orElse(() => scoreText(tokens, `${engine.keyword} ${engine.description}`)),
    );
};

/**
 * The rows for a keyword that is still being typed.
 *
 * The keywords with that prefix, or every engine by its text when no keyword
 * has it.
 */
const typedEngineRows = (
  engines: readonly SearchEngine[],
  typed: string,
): ReadonlyArray<Completion> => {
  const score = keywordScore(typed);
  return pipe(
    enginesMatchingPrefix(engines, typed),
    Array.match({ onEmpty: () => engines, onNonEmpty: (matching) => matching }),
    Array.map((engine) => engineRow(engine, score(engine))),
  );
};

/** The rows for the whole query, before the limit. */
const engineRows = (engines: readonly SearchEngine[], query: string): ReadonlyArray<Completion> =>
  pipe(
    Match.value(query.trim()),
    Match.withReturnType<ReadonlyArray<Completion>>(),
    // After a space the keyword is settled, and the navigate row takes over.
    Match.when(
      (typed: string) => /\s/u.test(typed),
      () => [],
    ),
    Match.when(String.isEmpty, () =>
      pipe(
        engines,
        Array.map((engine) => engineRow(engine, 1)),
      ),
    ),
    Match.orElse((typed) => typedEngineRows(engines, typed)),
  );

/**
 * Offer the engine keywords while the user still types one.
 *
 * The action is `Fill`, and not `Navigate`. To choose `w` must put the user in
 * Wikipedia mode with the cursor ready, and must not search Wikipedia for
 * nothing.
 */
export const completeEngines = (
  engines: readonly SearchEngine[],
  query: string,
  limit: number = ENGINE_LIMIT,
): readonly Completion[] =>
  pipe(engineRows(engines, query), Array.filter(isMatch), Array.sort(byScore), Array.take(limit));

// ---------------------------------------------------------------------------
// Our own index
// ---------------------------------------------------------------------------

/** The weight of a visit in the list that an empty query gives. */
const EMPTY_QUERY_RELEVANCY = 0.1;

const historyRow = (visit: Visit, score: number): Completion => ({
  kind: "history",
  badge: "Visited",
  title: pageTitle(visit),
  detail: shortUrl(visit.url),
  action: CompletionAction.Navigate({ url: visit.url }),
  score,
  muted: false,
  nativeAlternative: Option.none(),
});

/** A visit with the text relevancy of the query. */
interface MatchedVisit {
  readonly visit: Visit;
  readonly relevancy: number;
}

export const completeHistory = (
  visits: readonly Visit[],
  query: string,
  now: number,
  limit: number = HISTORY_LIMIT,
): readonly Completion[] =>
  pipe(
    query,
    tokenize,
    Array.match({
      // No query. The pages with the best frecency, which is the only order
      // that means anything before the user has said what they want.
      onEmpty: () =>
        pipe(
          visits,
          Array.sort(descending((visit: Visit) => historyScore(1, visit, now))),
          Array.take(limit),
          Array.map((visit) => historyRow(visit, historyScore(EMPTY_QUERY_RELEVANCY, visit, now))),
        ),
      onNonEmpty: (tokens) =>
        pipe(
          visits,
          Array.map((visit): MatchedVisit => ({ visit, relevancy: scoreCandidate(tokens, visit) })),
          Array.filter(({ relevancy }) => relevancy > 0),
          Array.map(({ visit, relevancy }) =>
            historyRow(visit, historyScore(relevancy, visit, now)),
          ),
          Array.sort(byScore),
          Array.take(limit),
        ),
    }),
  );

// ---------------------------------------------------------------------------
// The tabs that we opened
// ---------------------------------------------------------------------------

export const liveTabs = (tabs: readonly KnownTab[], now: number): readonly KnownTab[] =>
  pipe(
    tabs,
    Array.filter((tab) => now - tab.heartbeat < TAB_LIVENESS_MS),
  );

const recentRow = (tab: KnownTab, score: number): Completion => ({
  kind: "recent",
  // "Recent", and never "Tabs": we see only the tabs that we opened ourselves,
  // and a label that said otherwise would be a statement that the user acts
  // on.
  badge: "Recent",
  title: pageTitle(tab),
  detail: shortUrl(tab.url),
  action: CompletionAction.Navigate({ url: tab.url }),
  score,
  muted: false,
  nativeAlternative: Option.none(),
});

/**
 * How well a tab matches the query.
 *
 * With no query every tab matches equally, and the age of the signal breaks
 * the tie. Nothing else about a tab that we cannot inspect is a useful signal.
 */
const tabRelevancy =
  (tokens: readonly string[]) =>
  (tab: KnownTab): number =>
    pipe(
      tokens,
      Array.match({ onEmpty: () => 1, onNonEmpty: (words) => scoreCandidate(words, tab) }),
    );

export const completeRecent = (
  tabs: readonly KnownTab[],
  query: string,
  now: number,
  limit: number = RECENT_LIMIT,
): readonly Completion[] => {
  const relevancy = tabRelevancy(tokenize(query));
  return pipe(
    liveTabs(tabs, now),
    Array.sort(descending((tab: KnownTab) => tab.heartbeat)),
    Array.map((tab) => recentRow(tab, relevancy(tab))),
    Array.filter(isMatch),
    Array.sort(byScore),
    Array.take(limit),
  );
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
  pipe(
    suggestions,
    Array.map((suggestion, index): Completion => ({
      kind: "suggestion",
      badge: engineName,
      title: suggestion,
      detail: "",
      action: CompletionAction.Navigate({ url: buildSearchUrl(searchTemplate, suggestion) }),
      // Descending, and below the sources that we can vouch for. A
      // suggestion is the guess of the engine about the query, and not a
      // page that the user has been to.
      score: SUGGESTION_BASE_SCORE - index * SUGGESTION_STEP,
      muted: false,
      nativeAlternative: Option.none(),
    })),
  );

// ---------------------------------------------------------------------------
// The default row
// ---------------------------------------------------------------------------

interface DefaultRow {
  readonly badge: string;
  readonly title: string;
  readonly detail: string;
  readonly url: string;
}

const defaultRow = ({ badge, title, detail, url }: DefaultRow): Completion => ({
  kind: "navigate",
  badge,
  title,
  detail,
  action: CompletionAction.Navigate({ url }),
  score: Infinity,
  muted: false,
  nativeAlternative: Option.none(),
});

const destinationRow = Destination.$match({
  EngineSearch: ({ engine, query, url }) =>
    defaultRow({ badge: engine.description, title: query, detail: url, url }),
  Address: ({ url }) => defaultRow({ badge: "Open", title: url, detail: "", url }),
  DefaultSearch: ({ query, url }) =>
    defaultRow({ badge: "Search", title: query, detail: url, url }),
});

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
): readonly Completion[] =>
  pipe(
    query.trim(),
    Option.liftPredicate(String.isNonEmpty),
    Option.map((trimmed) => destinationOf(trimmed, engines, defaultSearchUrl)),
    Option.map(destinationRow),
    Option.toArray,
  );

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
  action: CompletionAction.Dismiss(),
  score: Infinity,
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

/** The list, and the query that it answers. */
export type CompletionState = Data.TaggedEnum<{
  /** Commands and nothing else. The query has the `:` prefix removed. */
  Commands: { readonly query: string; readonly rows: readonly Completion[] };
  /** The places that the query can lead to, and the searches for it. */
  Destinations: { readonly query: string; readonly rows: readonly Completion[] };
}>;

export const CompletionState = Data.taggedEnum<CompletionState>();

/** A `:` prefix, or the `command` source, means commands and nothing else. */
const isCommandMode = (source: OmnibarSource, query: string): boolean =>
  source === "command" || query.trimStart().startsWith(COMMAND_PREFIX);

export const stripCommandPrefix = (query: string): string =>
  pipe(
    query.trimStart(),
    Option.liftPredicate(String.startsWith(COMMAND_PREFIX)),
    Option.map(String.slice(COMMAND_PREFIX.length)),
    Option.getOrElse(() => query),
    String.trim,
  );

/** The rows that a source puts before everything else. */
const noticesFor = (source: OmnibarSource): ReadonlyArray<Completion> =>
  pipe(
    Match.value(source),
    Match.withReturnType<ReadonlyArray<Completion>>(),
    Match.when("bookmark", () => [bookmarkNotice()]),
    Match.whenOr("url", "command", "search", () => []),
    Match.exhaustive,
  );

/** The pages that we know of. A search session offers searches and nothing else. */
const knownPages = (input: CompletionInput): ReadonlyArray<Completion> =>
  pipe(
    Match.value(input.source),
    Match.withReturnType<ReadonlyArray<Completion>>(),
    Match.when("search", () => []),
    Match.whenOr("url", "command", "bookmark", () =>
      pipe(
        completeHistory(input.visits, input.query, input.now),
        Array.appendAll(completeRecent(input.knownTabs, input.query, input.now)),
      ),
    ),
    Match.exhaustive,
  );

/**
 * The engines are limited once the user types. To find a keyword matters, but
 * not enough to push the sources below it off the screen.
 */
const engineLimit = (query: string): number =>
  pipe(
    query.trim(),
    String.isEmpty,
    Boolean.match({ onTrue: () => ENGINE_LIMIT, onFalse: () => ENGINE_LIMIT_WHILE_TYPING }),
  );

/**
 * Two rows that would do the same thing.
 *
 * The default row and a history entry for the same URL are the usual case. A
 * row that does nothing is never a copy of another row.
 */
const sameAction = (row: Completion, kept: Completion): boolean =>
  !CompletionAction.$is("Dismiss")(row.action) && Equal.equals(row.action, kept.action);

const commandCompletions = (input: CompletionInput): CompletionState => {
  const query = stripCommandPrefix(input.query);
  return CompletionState.Commands({
    query,
    rows: completeCommands(input.commands, query, MAX_RESULTS),
  });
};

/**
 * The list outside command mode.
 *
 * The list is deliberately *not* sorted again as a whole. Each source scores
 * on its own scale — the ladder score of a command and the frecency score of a
 * visit are not comparable numbers — so the order of the groups is the
 * ranking, and each group is in the order of its own scoring. Of two rows that
 * do the same thing, the first one wins, because the list is already in the
 * order of priority.
 */
const destinationCompletions = (input: CompletionInput): CompletionState =>
  CompletionState.Destinations({
    query: input.query,
    rows: pipe(
      noticesFor(input.source),
      Array.appendAll(completeNavigate(input.query, input.engines, input.searchUrl)),
      Array.appendAll(knownPages(input)),
      Array.appendAll(completeEngines(input.engines, input.query, engineLimit(input.query))),
      Array.appendAll(
        completeSuggestions(input.suggestions, input.searchUrl, input.suggestionEngine),
      ),
      Array.dedupeWith(sameAction),
      Array.take(MAX_RESULTS),
    ),
  });

export const completionsFor = (input: CompletionInput): CompletionState =>
  pipe(
    isCommandMode(input.source, input.query),
    Boolean.match({
      onTrue: () => commandCompletions(input),
      onFalse: () => destinationCompletions(input),
    }),
  );
