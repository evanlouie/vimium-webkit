/**
 * Search-engine configuration (IMPLEMENTATION_PLAN.md §6.7).
 *
 * The format is upstream Vimium's, deliberately: users arrive with a
 * `searchEngines` block already written and re-typing it is a tax on switching.
 * One engine per line:
 *
 * ```
 * # a comment
 * w: https://www.wikipedia.org/w/index.php?search=%s Wikipedia
 * ```
 *
 * Everything here is pure. The config is user text that lives in storage and is
 * editable from the manager's own UI, so it is untrusted input: a typo on line
 * four must cost the user line four and nothing else, which is why parsing
 * returns diagnostics instead of throwing.
 */

export interface SearchEngine {
  /** The token typed before the query, e.g. `w`. Case-sensitive, as upstream. */
  readonly keyword: string;
  /** The raw template with `%s` still in place. */
  readonly url: string;
  /** Falls back to the keyword when the line omits a description. */
  readonly description: string;
}

export interface EngineDiagnostic {
  /** 1-based, so it lines up with what the settings editor shows. */
  readonly line: number;
  /** The offending line, trimmed, for display next to the message. */
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
 * The keyword may not contain whitespace or a colon, so that the split point is
 * unambiguous no matter what the URL looks like. The URL is the next
 * whitespace-delimited run; everything after it is prose.
 */
const ENGINE_LINE = /^([^\s:]+)\s*:\s*(\S+)(?:\s+(.*))?$/u;

const COMMENT = /^\s*#/u;

export const parseSearchEngines = (source: string): ParsedSearchEngines => {
  const engines: SearchEngine[] = [];
  const diagnostics: EngineDiagnostic[] = [];
  /** Keyword -> index in `engines`, so a redefinition replaces rather than shadows. */
  const seen = new Map<string, number>();

  // `\r` is stripped rather than treated as a line terminator: config pasted
  // from a Windows editor is common and must not fail every line.
  const lines = source.replace(/\r/gu, "").split("\n");

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (raw === undefined) continue;

    const text = raw.trim();
    const line = index + 1;
    if (text.length === 0 || COMMENT.test(text)) continue;

    const match = ENGINE_LINE.exec(text);
    if (match === null) {
      diagnostics.push({
        line,
        text,
        message: "expected `keyword: url-with-%s Description`",
      });
      continue;
    }

    const keyword = match[1] ?? "";
    const url = match[2] ?? "";
    const description = (match[3] ?? "").trim();

    if (!url.includes("%s")) {
      // Rejected rather than accepted-and-ignored: an engine without a
      // placeholder silently discards whatever the user typed, which is worse
      // than telling them the line is wrong.
      diagnostics.push({
        line,
        text,
        message: "the URL must contain %s, which is replaced by the query",
      });
      continue;
    }

    const engine: SearchEngine = {
      keyword,
      url,
      description: description.length === 0 ? keyword : description,
    };

    const previous = seen.get(keyword);
    if (previous === undefined) {
      seen.set(keyword, engines.length);
      engines.push(engine);
    } else {
      diagnostics.push({
        line,
        text,
        message: `duplicate keyword "${keyword}"; this line wins`,
      });
      engines[previous] = engine;
    }
  }

  return { engines, diagnostics };
};

/**
 * Substitute the query into a `%s` template.
 *
 * The replacement is passed as a function so that a query containing `$&` or
 * `$1` cannot be re-interpreted as a replacement pattern. `encodeURIComponent`
 * happens not to emit `$` today, but relying on that is the kind of assumption
 * that becomes a bug three years later.
 */
export const buildSearchUrl = (template: string, query: string): string => {
  const encoded = encodeURIComponent(query);
  return template.replaceAll("%s", () => encoded);
};

export interface KeywordSplit {
  readonly engine: SearchEngine;
  /** The rest of the query. Empty when the user has typed only the keyword. */
  readonly rest: string;
}

/**
 * Peel a leading engine keyword off the query.
 *
 * A bare keyword with no trailing space still matches, so that typing `w`
 * immediately offers Wikipedia rather than waiting for a space the user has not
 * pressed yet.
 */
export const splitKeyword = (
  query: string,
  engines: readonly SearchEngine[],
): KeywordSplit | null => {
  const trimmed = query.replace(/^\s+/u, "");
  const boundary = trimmed.search(/\s/u);
  const head = boundary === -1 ? trimmed : trimmed.slice(0, boundary);
  if (head.length === 0) return null;

  const engine = engines.find((candidate) => candidate.keyword === head);
  if (engine === undefined) return null;

  return {
    engine,
    rest: boundary === -1 ? "" : trimmed.slice(boundary + 1).trim(),
  };
};

/** Engines whose keyword starts with `prefix`, for the completion list. */
export const enginesMatchingPrefix = (
  engines: readonly SearchEngine[],
  prefix: string,
): readonly SearchEngine[] => {
  if (prefix.length === 0) return engines;
  return engines.filter((engine) => engine.keyword.startsWith(prefix));
};

export type QueryKind = "url" | "search";

/**
 * Trailing labels that look like a TLD but are almost always a file extension.
 *
 * The correct answer is the Public Suffix List, which is ~250 kB and has no
 * place in a userscript, so this inverts the problem: assume a dotted token is
 * a host unless its last label is one of a handful of unambiguous document
 * extensions. `notes.txt` searches; `example.dev` navigates.
 */
const NON_TLD_EXTENSIONS: ReadonlySet<string> = new Set([
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
]);

/** One or more labels, then a plausible TLD, then an optional port and path. */
const HOST_LIKE = /^([^\s/?#@]+)\.([a-z]{2,63})(?::\d+)?(?:[/?#][\s\S]*)?$/iu;

/**
 * Decide whether the user typed a destination or a question.
 *
 * The heuristics are the ones every address bar converges on, and the ordering
 * matters: whitespace beats everything (`foo.com bar` is a search), an explicit
 * scheme beats everything else, and a bare dotted host is a URL only when the
 * last label looks like a TLD rather than a file extension.
 */
export const classifyQuery = (query: string): QueryKind => {
  const trimmed = query.trim();
  if (trimmed.length === 0) return "search";
  if (/\s/u.test(trimmed)) return "search";

  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return "url";
  if (/^(?:about|view-source|file|data|javascript):/iu.test(trimmed)) {
    // Still classified as a URL so that `tabs.ts` gets the chance to refuse
    // `javascript:` and `data:` explicitly, rather than us quietly searching
    // for the payload.
    return "url";
  }
  if (/^localhost(?::\d+)?(?:[/?#][\s\S]*)?$/iu.test(trimmed)) return "url";
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#][\s\S]*)?$/u.test(trimmed)) {
    return "url";
  }

  const match = HOST_LIKE.exec(trimmed);
  if (match === null) return "search";
  return NON_TLD_EXTENSIONS.has((match[2] ?? "").toLowerCase())
    ? "search"
    : "url";
};

/** Add the scheme a bare host omits. Never guesses `http:`. */
export const toNavigableUrl = (query: string): string => {
  const trimmed = query.trim();
  return /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
};

/**
 * Turn a raw omnibar query into the URL Enter should open.
 *
 * `defaultSearchUrl` is `settings().searchUrl`; a keyword prefix overrides it.
 */
export const resolveQuery = (
  query: string,
  engines: readonly SearchEngine[],
  defaultSearchUrl: string,
): { readonly url: string; readonly kind: QueryKind } => {
  const split = splitKeyword(query, engines);
  if (split !== null && split.rest.length > 0) {
    return {
      url: buildSearchUrl(split.engine.url, split.rest),
      kind: "search",
    };
  }
  if (classifyQuery(query) === "url") {
    return { url: toNavigableUrl(query), kind: "url" };
  }
  return {
    url: buildSearchUrl(defaultSearchUrl, query.trim()),
    kind: "search",
  };
};
