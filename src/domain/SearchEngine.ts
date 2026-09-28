/**
 * The configuration of the search engines.
 *
 * The format is the format of upstream Vimium, on purpose. A user arrives with
 * a `searchEngines` block that is already written, and to type it again is a
 * cost of the change. There is one engine on each line:
 *
 * ```
 * # a comment
 * w: https://www.wikipedia.org/w/index.php?search=%s Wikipedia
 * ```
 *
 * Everything here is pure. The configuration is text from the user. It lives
 * in storage, and the user can edit it in the interface of the manager, so it
 * is untrusted input. An error on line four must cost the user line four and
 * no other line, which is why the parser gives diagnostics and does not fail.
 */

import { Array, Data, Match, Option, pipe, Predicate, Result, String } from "effect";
import { flow } from "effect/Function";

export interface SearchEngine {
  /** The token before the query, for example `w`. Case matters, as upstream. */
  readonly keyword: string;
  /** The raw template, with `%s` still in it. */
  readonly url: string;
  /** The keyword is used when the line gives no description. */
  readonly description: string;
}

export interface EngineDiagnostic {
  /** 1-based, so it agrees with the settings editor. */
  readonly line: number;
  /** The bad line, trimmed, to show next to the message. */
  readonly text: string;
  readonly message: string;
}

export interface ParsedSearchEngines {
  readonly engines: readonly SearchEngine[];
  readonly diagnostics: readonly EngineDiagnostic[];
}

/**
 * `keyword: url [description]`.
 *
 * The keyword may hold no whitespace and no colon, so the split point is clear
 * whatever the URL looks like. The URL is the next run without whitespace.
 * Everything after it is text for the user.
 */
const ENGINE_LINE = /^([^\s:]+)\s*:\s*(\S+)(?:\s+(.*))?$/u;

const COMMENT = /^\s*#/u;

const matches =
  (pattern: RegExp) =>
  (text: string): boolean =>
    pattern.test(text);

/** A line of the configuration that holds something. */
interface SourceLine {
  readonly line: number;
  readonly text: string;
}

/** The trimmed lines, numbered from 1, without the blank lines and the comments. */
const sourceLines = flow(
  // `\r` is removed, and is not an end of line. A configuration that comes
  // from an editor on Windows is usual, and it must not make every line fail.
  String.replace(/\r/gu, ""),
  String.split("\n"),
  Array.map((raw, index): SourceLine => ({ line: index + 1, text: raw.trim() })),
  Array.filter(({ text }) => text.length > 0 && !COMMENT.test(text)),
);

/** One line as an engine, or the message that says why it is not one. */
const readEngine = flow(
  String.match(ENGINE_LINE),
  Result.fromOption(() => "expected `keyword: url-with-%s Description`"),
  Result.map(([, keyword = "", url = "", description = ""]): SearchEngine => ({
    keyword,
    url,
    description: pipe(
      description.trim(),
      Option.liftPredicate(String.isNonEmpty),
      Option.getOrElse(() => keyword),
    ),
  })),
  // The line is refused, and not accepted and ignored. An engine without the
  // placeholder throws away everything that the user typed. A message is
  // better.
  Result.filterOrFail(
    ({ url }) => url.includes("%s"),
    () => "the URL must contain %s, which is replaced by the query",
  ),
  // A `javascript:` template is a correct engine line, and then every search
  // through that keyword runs text from an attacker, or from a typing error,
  // in the current origin. The check belongs here, and not in
  // `buildSearchUrl`. The user is told at the place where they can correct
  // it.
  Result.filterOrFail(
    ({ url }) => isSafeTemplate(url),
    () => "the URL must be http:// or https://",
  ),
);

/** The engines with `engine` in the place of an earlier line for its keyword. */
const redefined = (
  engines: readonly SearchEngine[],
  engine: SearchEngine,
): Option.Option<readonly SearchEngine[]> =>
  pipe(
    engines,
    Array.findFirstIndex((known) => known.keyword === engine.keyword),
    Option.flatMap((index) => pipe(engines, Array.replace(index, engine))),
  );

/** Add an engine. A second definition of a keyword replaces the first, and says so. */
const define = (
  parsed: ParsedSearchEngines,
  { line, text }: SourceLine,
  engine: SearchEngine,
): ParsedSearchEngines =>
  pipe(
    redefined(parsed.engines, engine),
    Option.match({
      onNone: () => ({
        engines: pipe(parsed.engines, Array.append(engine)),
        diagnostics: parsed.diagnostics,
      }),
      onSome: (engines) => ({
        engines,
        diagnostics: pipe(
          parsed.diagnostics,
          Array.append({
            line,
            text,
            message: `duplicate keyword "${engine.keyword}"; this line wins`,
          }),
        ),
      }),
    }),
  );

const reject = (
  parsed: ParsedSearchEngines,
  diagnostic: EngineDiagnostic,
): ParsedSearchEngines => ({
  engines: parsed.engines,
  diagnostics: pipe(parsed.diagnostics, Array.append(diagnostic)),
});

const NO_ENGINES: ParsedSearchEngines = { engines: [], diagnostics: [] };

/** Fold one line into the engines and the diagnostics. */
const addLine = (parsed: ParsedSearchEngines, sourceLine: SourceLine): ParsedSearchEngines =>
  pipe(
    sourceLine.text,
    readEngine,
    Result.match({
      onFailure: (message) =>
        reject(parsed, { line: sourceLine.line, text: sourceLine.text, message }),
      onSuccess: (engine) => define(parsed, sourceLine, engine),
    }),
  );

export const parseSearchEngines: (source: string) => ParsedSearchEngines = flow(
  sourceLines,
  Array.reduce(NO_ENGINES, addLine),
);

/** A scheme of `http` or `https`, in any case. */
const SAFE_SCHEME = /^https?:/iu;

/**
 * Is this a template that we agree to open?
 *
 * The scheme is checked on the *raw* template, and not on the built URL. The
 * query is percent-encoded into the template, so a scheme that is safe before
 * the substitution is safe after it.
 */
export const isSafeTemplate = (template: string): boolean => SAFE_SCHEME.test(template.trim());

/**
 * Put the query into a `%s` template.
 *
 * The replacement is a function, so a query that holds `$&` or `$1` cannot
 * become a replacement pattern. `encodeURIComponent` does not give a `$` today,
 * but to trust that is the kind of assumption that becomes a fault three years
 * later.
 */
export const buildSearchUrl = (template: string, query: string): string => {
  const encoded = encodeURIComponent(query);
  return template.replaceAll("%s", () => encoded);
};

export interface KeywordSplit {
  readonly engine: SearchEngine;
  /** The rest of the query. Empty when the user typed only the keyword. */
  readonly rest: string;
}

/** The first word after any leading whitespace, and the text after the whitespace that ends it. */
const KEYWORD_SPLIT = /^\s*(\S+)(?:\s([\s\S]*))?$/u;

/**
 * Take an engine keyword off the front of the query.
 *
 * A keyword alone, with no space after it, also matches. A user who types `w`
 * therefore sees Wikipedia at once, and does not wait for a space that they
 * did not press.
 */
export const splitKeyword = (
  query: string,
  engines: readonly SearchEngine[],
): Option.Option<KeywordSplit> =>
  pipe(
    query,
    String.match(KEYWORD_SPLIT),
    Option.flatMap(([, head = "", rest = ""]) =>
      pipe(
        engines,
        Array.findFirst((candidate) => candidate.keyword === head),
        Option.map((engine) => ({ engine, rest: rest.trim() })),
      ),
    ),
  );

/** The engines whose keyword starts with `prefix`, for the completion list. */
export const enginesMatchingPrefix = (
  engines: readonly SearchEngine[],
  prefix: string,
): readonly SearchEngine[] =>
  pipe(
    engines,
    Array.filter((engine) => engine.keyword.startsWith(prefix)),
  );

export type QueryKind = "url" | "search";

/**
 * Final labels that look like a top-level domain, but are usually a file
 * extension.
 *
 * The correct answer is the Public Suffix List, which is about 250 kB and has
 * no place in a userscript. This table turns the question around: a token with
 * a dot is a host, unless its last label is one of a few document extensions
 * that leave no doubt. `notes.txt` searches. `example.dev` navigates.
 */
const NON_TLD_EXTENSIONS: ReadonlyArray<string> = [
  "txt",
  "md",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "csv",
  "json",
  "xml",
  "yaml",
  "yml",
  "zip",
  "tar",
  "log",
  "exe",
  "dmg",
  "mp3",
  "mp4",
  "mov",
];

/** One or more labels, a possible top-level domain, then a port and a path. */
const HOST_LIKE = /^([^\s/?#@]+)\.([a-z]{2,63})\.?(?::\d+)?(?:[/?#][\s\S]*)?$/iu;

/** `[::1]`, `[::1]:8080` and `[fe80::1%25en0]/path`. */
const IPV6_LIKE = /^\[[0-9a-f:.]+(?:%25[^\]]+)?\](?::\d+)?(?:[/?#][\s\S]*)?$/iu;

const IPV4_LIKE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d+)?(?:[/?#][\s\S]*)?$/u;

const LOCALHOST = /^localhost(?::\d+)?(?:[/?#][\s\S]*)?$/iu;

const WITH_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//iu;

const WITHOUT_AUTHORITY = /^(?:about|view-source|file|data|javascript):/iu;

/** An `@` before the first `/`. */
const USER_INFO = /^[^/]*@/u;

const isIpv4 = flow(
  String.match(IPV4_LIKE),
  // `\d{1,3}` alone accepts `999.999.999.999`, which is not an address. Such a
  // text must be searched for, and not opened.
  Option.exists(
    flow(
      Array.drop(1),
      Array.every((octet) => Number(octet) <= 255),
    ),
  ),
);

const isFileExtension = (label: string): boolean => pipe(NON_TLD_EXTENSIONS, Array.contains(label));

/**
 * A plain host with a dot is a URL only when the last label looks like a
 * top-level domain, and not like a file extension.
 */
const hostKind = flow(
  String.match(HOST_LIKE),
  Option.flatMap(Array.get(2)),
  Option.map(String.toLowerCase),
  Option.filter(Predicate.not(isFileExtension)),
  Option.match({ onNone: (): QueryKind => "search", onSome: (): QueryKind => "url" }),
);

/**
 * Decide whether the user typed a destination or a question.
 *
 * These are the tests that every address bar arrives at, and the order is
 * important. Whitespace wins over everything (`foo.com bar` is a search). An
 * explicit scheme wins over the rest. A plain host with a dot is a URL only
 * when the last label looks like a top-level domain, and not like a file
 * extension.
 */
export const classifyQuery = (query: string): QueryKind =>
  pipe(
    Match.value(query.trim()),
    Match.withReturnType<QueryKind>(),
    Match.when(String.isEmpty, () => "search"),
    Match.when(matches(/\s/u), () => "search"),
    Match.when(matches(WITH_AUTHORITY), () => "url"),
    // This is still a URL, so that the tabs service gets the chance to refuse
    // `javascript:` and `data:` itself. We must not search for the payload
    // without a message.
    Match.when(matches(WITHOUT_AUTHORITY), () => "url"),
    // An `@` before the first `/` is user information. A search for it would
    // send the password to the search engine. That is the one result here that
    // cannot be undone.
    Match.when(matches(USER_INFO), () => "url"),
    Match.when(matches(IPV6_LIKE), () => "url"),
    Match.when(matches(LOCALHOST), () => "url"),
    Match.when(isIpv4, () => "url"),
    Match.orElse(hostKind),
  );

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;

/** Add the scheme that a plain host does not have. It never guesses `http:`. */
export const toNavigableUrl = (query: string): string =>
  pipe(
    Match.value(query.trim()),
    Match.when(matches(HAS_SCHEME), (url) => url),
    Match.orElse((host) => `https://${host}`),
  );

/** Where Enter takes the user. */
export type Destination = Data.TaggedEnum<{
  /** A keyword in front, and a query for that engine. */
  EngineSearch: {
    readonly engine: SearchEngine;
    readonly query: string;
    readonly url: string;
  };
  /** A URL, with the scheme that it may have needed. */
  Address: { readonly url: string };
  /** A search with the default engine. */
  DefaultSearch: { readonly query: string; readonly url: string };
}>;

export const Destination = Data.taggedEnum<Destination>();

/** A query with no keyword, or a keyword with nothing after it. */
const plainDestination = (query: string, defaultSearchUrl: string): Destination =>
  pipe(
    Match.value(classifyQuery(query)),
    Match.when("url", () => Destination.Address({ url: toNavigableUrl(query) })),
    Match.when("search", () =>
      Destination.DefaultSearch({ query, url: buildSearchUrl(defaultSearchUrl, query) }),
    ),
    Match.exhaustive,
  );

/**
 * Decide where a raw omnibar query goes.
 *
 * `defaultSearchUrl` is `settings.searchUrl`. A keyword at the front replaces
 * it, but only when something follows the keyword.
 */
export const destinationOf = (
  query: string,
  engines: readonly SearchEngine[],
  defaultSearchUrl: string,
): Destination =>
  pipe(
    splitKeyword(query, engines),
    Option.filter(({ rest }) => rest.length > 0),
    Option.match({
      onNone: () => plainDestination(query.trim(), defaultSearchUrl),
      onSome: ({ engine, rest }) =>
        Destination.EngineSearch({ engine, query: rest, url: buildSearchUrl(engine.url, rest) }),
    }),
  );

export interface ResolvedQuery {
  readonly url: string;
  readonly kind: QueryKind;
}

/**
 * Turn a raw omnibar query into the URL that Enter must open.
 *
 * `defaultSearchUrl` is `settings.searchUrl`. A keyword at the front replaces
 * it.
 */
export const resolveQuery = (
  query: string,
  engines: readonly SearchEngine[],
  defaultSearchUrl: string,
): ResolvedQuery =>
  pipe(
    destinationOf(query, engines, defaultSearchUrl),
    Destination.$match({
      EngineSearch: ({ url }): ResolvedQuery => ({ url, kind: "search" }),
      Address: ({ url }): ResolvedQuery => ({ url, kind: "url" }),
      DefaultSearch: ({ url }): ResolvedQuery => ({ url, kind: "search" }),
    }),
  );
