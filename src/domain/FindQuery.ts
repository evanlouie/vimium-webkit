/**
 * The parsing of a find query.
 *
 * Ported in spirit from the Vimium `content_scripts/mode_find.js`
 * (`FindMode.updateQuery`) and `lib/utils.js` (`Utils.hasUpperCase`), MIT.
 *
 * Everything here is a pure function of `(rawQuery, options)`. That is the
 * intention. Smartcase and the choice of regex mode are the two parts of find
 * that a user sees when they are wrong, and they are the only parts that a
 * test can check without a DOM. The engine takes the `RegExp` that this module
 * makes, and knows nothing about how it was made.
 *
 * Nothing here throws. A pattern that does not compile comes back with an
 * `error`, and the HUD shows it while the user still types.
 */

import { Option } from "effect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FindQueryKind = "literal" | "regex";

export interface FindQueryOptions {
  /** `Settings.regexFindMode`: read a plain query as a regular expression. */
  readonly regexFindMode: boolean;
}

export interface ParsedFindQuery {
  /** Exactly what the user typed, for the history and for the `n` and `N` repeat. */
  readonly raw: string;
  /** The query without the delimiters and without the escape directives. */
  readonly pattern: string;
  readonly kind: FindQueryKind;
  readonly ignoreCase: boolean;
  /** True when smartcase gave `ignoreCase`, and the user did not state it. */
  readonly smartcase: boolean;
  readonly isEmpty: boolean;
  /** The `RegExp` source of this query. It is `""` when the query is empty or bad. */
  readonly source: string;
  readonly flags: string;
  /** A `Some` when the pattern is not a regular expression that compiles. */
  readonly error: Option.Option<string>;
}

// ---------------------------------------------------------------------------
// Case analysis
// ---------------------------------------------------------------------------

/**
 * Does `text` hold a character in upper case that has a different lower case?
 *
 * Upstream tests `/[A-Z]/`, which turns smartcase off for every script that is
 * not Latin, and says nothing. The general form costs one pass, and it is
 * correct for Greek, for Cyrillic and for the Latin supplement.
 */
export const hasUpperCase = (text: string): boolean => {
  for (const char of text) {
    if (char !== char.toLowerCase() && char === char.toUpperCase()) return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * Escape `text` for literal use inside a regular expression.
 *
 * `-` is not escaped, on purpose. `\-` is a syntax error under the `u` flag,
 * and this module never sets `u`, so that a pattern with a single escape such
 * as `\d` behaves as a user of Vim expects.
 */
export const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The engine changes each whitespace character in the page to U+0020. */
const WHITESPACE_RUN = /\s+/;

/**
 * A literal pattern that accepts any whitespace.
 *
 * A text node carries the line breaks and the indentation of the source, so a
 * user who types `sign in` must still match `sign\n      in`. The engine
 * changes every whitespace character to one space *and keeps the length of the
 * string*, because an offset must still point at a position in the DOM. Runs of
 * spaces stay, which is why the pattern uses ` +` and not one space.
 */
export const literalSource = (pattern: string): string =>
  pattern
    .split(WHITESPACE_RUN)
    .map(escapeRegExp)
    .join(" +");

// ---------------------------------------------------------------------------
// `/regex/` literals
// ---------------------------------------------------------------------------

/** The flags that a user may add to a `/…/` literal. The engine adds `g`. */
const ALLOWED_LITERAL_FLAGS = "ims";

export interface RegexLiteral {
  readonly body: string;
  readonly flags: string;
}

/**
 * Split `/pattern/flags`.
 *
 * The result is `Option.none()` when `text` is not such a literal. The closing
 * delimiter is the last `/` that is not escaped, and everything after it must
 * be an allowed flag letter. A plain search for `and/or` is therefore still a
 * literal search, and not an empty regular expression with a false flag.
 */
export const splitRegexLiteral = (
  text: string,
): Option.Option<RegexLiteral> => {
  if (text.length < 2 || !text.startsWith("/")) return Option.none();

  let closing = -1;
  for (let index = text.length - 1; index >= 1; index--) {
    if (text[index] !== "/") continue;
    if (isEscaped(text, index)) continue;
    closing = index;
    break;
  }
  if (closing <= 0) return Option.none();

  const flags = text.slice(closing + 1);
  for (const flag of flags) {
    if (!ALLOWED_LITERAL_FLAGS.includes(flag)) return Option.none();
  }
  // Refuse a repeated flag here. `new RegExp` would throw on it.
  if (new Set(flags).size !== flags.length) return Option.none();

  return Option.some({ body: text.slice(1, closing), flags });
};

/** Does an odd number of backslashes come before the character at `index`? */
const isEscaped = (text: string, index: number): boolean => {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
};

// ---------------------------------------------------------------------------
// The inline directives of Vimium
// ---------------------------------------------------------------------------

export interface Directives {
  readonly text: string;
  readonly isRegex: Option.Option<boolean>;
  readonly ignoreCase: Option.Option<boolean>;
}

/**
 * Remove the `\r`, `\R`, `\i` and `\I` directives of Vimium.
 *
 * `\r` selects regex mode, `\R` selects literal mode, `\i` selects
 * case-insensitive and `\I` selects case-sensitive. They are kept, so the
 * habits of an upstream user still work.
 *
 * One difference on purpose: upstream keeps a doubled `\\r` in the query as it
 * is, so a literal search for `\r` is not possible. Here `\\r` becomes `\r`,
 * which is the meaning of "escape the escape character".
 */
export const stripDirectives = (text: string): Directives => {
  let isRegex: boolean | null = null;
  let ignoreCase: boolean | null = null;

  const stripped = text.replace(
    /(\\{1,2})([rRiI])/g,
    (_match: string, slashes: string, flag: string) => {
      if (slashes.length === 2) return `\\${flag}`;
      switch (flag) {
        case "r":
          isRegex = true;
          break;
        case "R":
          isRegex = false;
          break;
        case "i":
          ignoreCase = true;
          break;
        default:
          ignoreCase = false;
          break;
      }
      return "";
    },
  );

  return {
    text: stripped,
    isRegex: Option.fromNullishOr(isRegex),
    ignoreCase: Option.fromNullishOr(ignoreCase),
  };
};

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

const BASE_FLAGS = "g";

/**
 * Parse a raw find query into everything that the engine needs.
 *
 * This function never fails. A pattern that does not compile comes back with
 * `error` set to a `Some`.
 */
export const parseFindQuery = (
  raw: string,
  options: FindQueryOptions,
): ParsedFindQuery => {
  const literal = splitRegexLiteral(raw);

  const directives: Directives = Option.isNone(literal)
    ? stripDirectives(raw)
    : {
      text: literal.value.body,
      isRegex: Option.some(true),
      ignoreCase: Option.none(),
    };

  const pattern = directives.text;
  const kind: FindQueryKind =
    Option.getOrElse(directives.isRegex, () => options.regexFindMode)
      ? "regex"
      : "literal";

  const literalIgnoreCase = Option.isSome(literal) &&
      literal.value.flags.includes("i")
    ? Option.some(true)
    : Option.none<boolean>();
  const explicitIgnoreCase = Option.orElse(
    directives.ignoreCase,
    () => literalIgnoreCase,
  );
  const smartcase = Option.isNone(explicitIgnoreCase);
  const ignoreCase = Option.getOrElse(
    explicitIgnoreCase,
    () => !hasUpperCase(pattern),
  );

  const extraFlags = Option.isNone(literal)
    ? ""
    : literal.value.flags.replace("i", "");
  const flags = `${BASE_FLAGS}${ignoreCase ? "i" : ""}${extraFlags}`;

  if (pattern.length === 0) {
    return {
      raw,
      pattern,
      kind,
      ignoreCase,
      smartcase,
      isEmpty: true,
      source: "",
      flags,
      error: Option.none(),
    };
  }

  const source = kind === "regex" ? pattern : literalSource(pattern);

  return {
    raw,
    pattern,
    kind,
    ignoreCase,
    smartcase,
    isEmpty: false,
    source,
    flags,
    error: compileError(source, flags),
  };
};

/**
 * Nested quantifiers: the shape that backtracks without an end.
 *
 * `(a+)+`, `(a*)*` and their family. A group that has a quantifier, and whose
 * body also has a quantifier. In `regexFindMode` a pattern from the user runs
 * against the whole page on *every* keystroke, and no code in JavaScript can
 * stop an `exec` that is inside such a pattern. Find mode owns the keyboard,
 * so the tab is lost.
 *
 * This is a cheap test on the text, and not a decision procedure.
 * `probeBacktracking` below finds the shapes that this test does not find.
 */
const NESTED_QUANTIFIER = /\((?![?]:)[^)]*[+*][^)]*\)\s*[+*{]/u;

/** The longest pattern from the user that we compile. */
const MAX_PATTERN_LENGTH = 512;

/**
 * The inputs that make a backtracking pattern show itself.
 *
 * They are short on purpose, and each one ends with a character that makes the
 * match *fail*. Catastrophic backtracking happens only on a match that fails.
 * At twenty characters a bad pattern costs tens of milliseconds, which is
 * measurable, and a safe pattern costs some hundredths. The probe itself
 * therefore cannot become the hang that it looks for.
 */
const PROBE_LENGTH = 20;

const PROBE_INPUTS: readonly string[] = [
  `${"a".repeat(PROBE_LENGTH)}!`,
  `${"0".repeat(PROBE_LENGTH)}!`,
  `${"ab".repeat(PROBE_LENGTH / 2)}!`,
  `${" ".repeat(PROBE_LENGTH)}!`,
  `${"a0 ".repeat(PROBE_LENGTH / 4)}!`,
];

/**
 * The milliseconds that the whole probe may take before we refuse the pattern.
 *
 * The measured separation at `PROBE_LENGTH` is 0.02 to 0.05 ms for a safe
 * pattern, and 14 to 150 ms for a bad one. Eight is two orders of magnitude
 * above the first group, so a pause for garbage collection cannot make a safe
 * pattern refused.
 */
const PROBE_BUDGET_MS = 8;

/** The clock that the probe uses. `performance` is absent in some hosts. */
const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/**
 * Does this pattern backtrack badly enough to be dangerous?
 *
 * The test measures, and does not analyse. The analytical question cannot be
 * decided from the source, and every rule on the text either refuses patterns
 * that users want (`(?:foo|bar)+`) or accepts patterns that hang (`(ab|a)*c`).
 * A run of the pattern is the only test that gives the truth.
 */
const probeBacktracking = (regex: RegExp): boolean => {
  const started = now();
  for (const input of PROBE_INPUTS) {
    try {
      regex.lastIndex = 0;
      regex.test(input);
    } catch {
      return false;
    }
    if (now() - started > PROBE_BUDGET_MS) return true;
  }
  return false;
};

/** A `None` when `source` and `flags` compile *and* are safe to run again and again. */
const compileError = (
  source: string,
  flags: string,
): Option.Option<string> => {
  if (source.length > MAX_PATTERN_LENGTH) {
    return Option.some(
      `pattern is longer than ${MAX_PATTERN_LENGTH} characters`,
    );
  }

  let regex: RegExp;
  try {
    regex = new RegExp(source, flags);
  } catch (cause) {
    return Option.some(
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  if (NESTED_QUANTIFIER.test(source) || probeBacktracking(regex)) {
    return Option.some(
      "this pattern backtracks badly enough to hang the page; " +
        "try a simpler one",
    );
  }
  return Option.none();
};

/**
 * Compile a parsed query.
 *
 * The result is `Option.none()` when the query is empty or bad. Each call
 * makes a new `RegExp`, and never a cached one. `lastIndex` on a `g`
 * expression is state that changes, and two searches that share it lose
 * matches. Such a fault is almost impossible to reproduce.
 */
export const toRegExp = (query: ParsedFindQuery): Option.Option<RegExp> => {
  if (query.isEmpty || Option.isSome(query.error)) return Option.none();
  try {
    return Option.some(new RegExp(query.source, query.flags));
  } catch {
    return Option.none();
  }
};

/**
 * A query that matches `text` literally, for `*` and `#`.
 *
 * A `\b` word boundary is added where the word starts or ends with a word
 * character, as the `*` of Vim does. The case still goes through smartcase, so
 * `*` on `Foo` finds `Foo` and not `foo`. Upstream does the same.
 */
export const wordQuery = (word: string): ParsedFindQuery => {
  const trimmed = word.trim();
  const ignoreCase = !hasUpperCase(trimmed);
  const flags = `g${ignoreCase ? "i" : ""}`;
  const core = literalSource(trimmed);
  const leading = /^\w/.test(trimmed) ? "\\b" : "";
  const trailing = /\w$/.test(trimmed) ? "\\b" : "";
  const source = `${leading}${core}${trailing}`;

  return {
    raw: trimmed,
    pattern: trimmed,
    kind: "literal",
    ignoreCase,
    smartcase: true,
    isEmpty: trimmed.length === 0,
    source: trimmed.length === 0 ? "" : source,
    flags,
    error: Option.none(),
  };
};
