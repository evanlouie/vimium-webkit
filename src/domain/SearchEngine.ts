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

import { Option } from "effect";

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

export const parseSearchEngines = (source: string): ParsedSearchEngines => {
  const engines: SearchEngine[] = [];
  const diagnostics: EngineDiagnostic[] = [];
  /** Keyword to index in `engines`, so a second definition replaces the first. */
  const seen = new Map<string, number>();

  // `\r` is removed, and is not an end of line. A configuration that comes
  // from an editor on Windows is usual, and it must not make every line fail.
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
      // The line is refused, and not accepted and ignored. An engine without
      // the placeholder throws away everything that the user typed. A message
      // is better.
      diagnostics.push({
        line,
        text,
        message: "the URL must contain %s, which is replaced by the query",
      });
      continue;
    }

    if (!isSafeTemplate(url)) {
      // A `javascript:` template is a correct engine line, and then every
      // search through that keyword runs text from an attacker, or from a
      // typing error, in the current origin. The check belongs here, and not
      // in `buildSearchUrl`. The user is told at the place where they can
      // correct it.
      diagnostics.push({
        line,
        text,
        message: "the URL must be http:// or https://",
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
 * Is this a template that we agree to open?
 *
 * The scheme is checked on the *raw* template, and not on the built URL. The
 * query is percent-encoded into the template, so a scheme that is safe before
 * the substitution is safe after it.
 */
export const isSafeTemplate = (template: string): boolean => {
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(template.trim());
  if (scheme === null) return false;
  const protocol = (scheme[1] ?? "").toLowerCase();
  return protocol === "http" || protocol === "https";
};

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
): Option.Option<KeywordSplit> => {
  const trimmed = query.replace(/^\s+/u, "");
  const boundary = trimmed.search(/\s/u);
  const head = boundary === -1 ? trimmed : trimmed.slice(0, boundary);
  if (head.length === 0) return Option.none();

  const engine = engines.find((candidate) => candidate.keyword === head);
  if (engine === undefined) return Option.none();

  return Option.some({
    engine,
    rest: boundary === -1 ? "" : trimmed.slice(boundary + 1).trim(),
  });
};

/** The engines whose keyword starts with `prefix`, for the completion list. */
export const enginesMatchingPrefix = (
  engines: readonly SearchEngine[],
  prefix: string,
): readonly SearchEngine[] => {
  if (prefix.length === 0) return engines;
  return engines.filter((engine) => engine.keyword.startsWith(prefix));
};

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

/** One or more labels, a possible top-level domain, then a port and a path. */
const HOST_LIKE =
  /^([^\s/?#@]+)\.([a-z]{2,63})\.?(?::\d+)?(?:[/?#][\s\S]*)?$/iu;

/** `[::1]`, `[::1]:8080` and `[fe80::1%25en0]/path`. */
const IPV6_LIKE = /^\[[0-9a-f:.]+(?:%25[^\]]+)?\](?::\d+)?(?:[/?#][\s\S]*)?$/iu;

const IPV4_LIKE =
  /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d+)?(?:[/?#][\s\S]*)?$/u;

const isIpv4 = (trimmed: string): boolean => {
  const match = IPV4_LIKE.exec(trimmed);
  if (match === null) return false;
  // `\d{1,3}` alone accepts `999.999.999.999`, which is not an address. Such a
  // text must be searched for, and not opened.
  return match.slice(1, 5).every((octet) => Number(octet) <= 255);
};

/**
 * Decide whether the user typed a destination or a question.
 *
 * These are the tests that every address bar arrives at, and the order is
 * important. Whitespace wins over everything (`foo.com bar` is a search). An
 * explicit scheme wins over the rest. A plain host with a dot is a URL only
 * when the last label looks like a top-level domain, and not like a file
 * extension.
 */
export const classifyQuery = (query: string): QueryKind => {
  const trimmed = query.trim();
  if (trimmed.length === 0) return "search";
  if (/\s/u.test(trimmed)) return "search";

  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return "url";
  if (/^(?:about|view-source|file|data|javascript):/iu.test(trimmed)) {
    // This is still a URL, so that the tabs service gets the chance to refuse
    // `javascript:` and `data:` itself. We must not search for the payload
    // without a message.
    return "url";
  }

  // An `@` before the first `/` is user information. A search for it would
  // send the password to the search engine. That is the one result here that
  // cannot be undone.
  const firstSlash = trimmed.indexOf("/");
  const at = trimmed.indexOf("@");
  if (at !== -1 && (firstSlash === -1 || at < firstSlash)) return "url";

  if (IPV6_LIKE.test(trimmed)) return "url";
  if (/^localhost(?::\d+)?(?:[/?#][\s\S]*)?$/iu.test(trimmed)) return "url";
  if (isIpv4(trimmed)) return "url";

  const match = HOST_LIKE.exec(trimmed);
  if (match === null) return "search";
  return NON_TLD_EXTENSIONS.has((match[2] ?? "").toLowerCase())
    ? "search"
    : "url";
};

/** Add the scheme that a plain host does not have. It never guesses `http:`. */
export const toNavigableUrl = (query: string): string => {
  const trimmed = query.trim();
  return /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
};

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
): ResolvedQuery => {
  const split = splitKeyword(query, engines);
  if (Option.isSome(split) && split.value.rest.length > 0) {
    return {
      url: buildSearchUrl(split.value.engine.url, split.value.rest),
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
