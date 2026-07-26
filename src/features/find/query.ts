/**
 * Find-query parsing.
 *
 * Ported in spirit from Vimium's `content_scripts/mode_find.js`
 * (`FindMode.updateQuery`) and `lib/utils.js` (`Utils.hasUpperCase`), MIT.
 *
 * Everything here is a pure function of `(rawQuery, options)`. That is
 * deliberate: smartcase and regex-mode selection are the two parts of find that
 * users notice being wrong, and they are the only parts that can be tested
 * without a DOM. The engine consumes the `RegExp` this module produces and
 * knows nothing about how it was derived.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FindQueryKind = "literal" | "regex";

export interface FindQueryOptions {
  /** `Settings.regexFindMode`: treat a bare query as a regular expression. */
  readonly regexFindMode: boolean;
}

export interface ParsedFindQuery {
  /** Exactly what the user typed, for history and for the `n`/`N` repeat. */
  readonly raw: string;
  /** The query with delimiters and escape directives removed. */
  readonly pattern: string;
  readonly kind: FindQueryKind;
  readonly ignoreCase: boolean;
  /** True when `ignoreCase` was inferred by smartcase, not stated explicitly. */
  readonly smartcase: boolean;
  readonly isEmpty: boolean;
  /** The `RegExp` source this query compiles to; `""` when empty or invalid. */
  readonly source: string;
  readonly flags: string;
  /** Non-`null` when the pattern is not a compilable regular expression. */
  readonly error: string | null;
}

// ---------------------------------------------------------------------------
// Case analysis
// ---------------------------------------------------------------------------

/**
 * Does `text` contain a character with a distinct upper case form, in upper case?
 *
 * Upstream tests `/[A-Z]/`, which silently disables smartcase for every
 * non-Latin script. The general form costs one pass and is correct for Greek,
 * Cyrillic and the Latin supplement.
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
 * Intentionally does not escape `-`: `\-` is a syntax error under the `u` flag,
 * and this module never sets `u` precisely so that a hand-written pattern
 * containing a lone `\d`-style escape behaves the way users expect from Vim.
 */
export const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whitespace in the haystack is normalised to U+0020 by the engine. */
const WHITESPACE_RUN = /\s+/;

/**
 * A literal pattern, made whitespace-tolerant.
 *
 * Text nodes carry the source's line breaks and indentation, so a user typing
 * `sign in` must still match `sign\n      in`. The engine normalises every
 * whitespace character to a single space *without changing the string's
 * length* (offsets have to keep mapping back to DOM positions), which leaves
 * runs of spaces — hence ` +` rather than a single space.
 */
export const literalSource = (pattern: string): string =>
  pattern
    .split(WHITESPACE_RUN)
    .map(escapeRegExp)
    .join(" +");

// ---------------------------------------------------------------------------
// `/regex/` literals
// ---------------------------------------------------------------------------

/** Flags a user may append to a `/…/` literal. `g` is added by the engine. */
const ALLOWED_LITERAL_FLAGS = "ims";

interface RegexLiteral {
  readonly body: string;
  readonly flags: string;
}

/**
 * Split `/pattern/flags`, or return `null` if `text` is not such a literal.
 *
 * The closing delimiter is the last unescaped `/`; everything after it must be
 * an allowed flag letter, so a plain search for `and/or` is still a literal
 * search rather than an empty regex with a nonsense flag.
 */
export const splitRegexLiteral = (text: string): RegexLiteral | null => {
  if (text.length < 2 || !text.startsWith("/")) return null;

  let closing = -1;
  for (let index = text.length - 1; index >= 1; index--) {
    if (text[index] !== "/") continue;
    if (isEscaped(text, index)) continue;
    closing = index;
    break;
  }
  if (closing <= 0) return null;

  const flags = text.slice(closing + 1);
  for (const flag of flags) {
    if (!ALLOWED_LITERAL_FLAGS.includes(flag)) return null;
  }
  // Reject duplicates up front; `new RegExp` would throw on them anyway.
  if (new Set(flags).size !== flags.length) return null;

  return { body: text.slice(1, closing), flags };
};

/** Is the character at `index` preceded by an odd number of backslashes? */
const isEscaped = (text: string, index: number): boolean => {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
};

// ---------------------------------------------------------------------------
// Vimium's inline directives
// ---------------------------------------------------------------------------

interface Directives {
  readonly text: string;
  readonly isRegex: boolean | null;
  readonly ignoreCase: boolean | null;
}

/**
 * Strip Vimium's `\r` / `\R` / `\i` / `\I` directives.
 *
 * `\r` forces regex mode, `\R` forces literal, `\i` forces case-insensitive,
 * `\I` forces case-sensitive. Kept for muscle-memory compatibility with
 * upstream (goal G5).
 *
 * One deliberate deviation: upstream leaves a doubled `\\r` in the query
 * verbatim, so a literal search for `\r` is impossible. Here `\\r` unescapes to
 * `\r`, which is what "escape the escape character" is supposed to mean.
 */
export const stripDirectives = (text: string): Directives => {
  let isRegex: boolean | null = null;
  let ignoreCase: boolean | null = null;

  const stripped = text.replace(
    /(\\{1,2})([rRiI])/g,
    (_match, slashes: string, flag: string) => {
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

  return { text: stripped, isRegex, ignoreCase };
};

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

const EMPTY_FLAGS = "g";

/**
 * Parse a raw find query into everything the engine needs.
 *
 * Never throws: an uncompilable pattern comes back with `error` set so the HUD
 * can say so while the user is still typing it.
 */
export const parseFindQuery = (
  raw: string,
  options: FindQueryOptions,
): ParsedFindQuery => {
  const literal = splitRegexLiteral(raw);

  const directives = literal === null
    ? stripDirectives(raw)
    : { text: literal.body, isRegex: true, ignoreCase: null };

  const pattern = directives.text;
  const kind: FindQueryKind = (directives.isRegex ?? options.regexFindMode)
    ? "regex"
    : "literal";

  const explicitIgnoreCase = directives.ignoreCase ??
    (literal !== null && literal.flags.includes("i") ? true : null);
  const smartcase = explicitIgnoreCase === null;
  const ignoreCase = explicitIgnoreCase ?? !hasUpperCase(pattern);

  const extraFlags = literal === null ? "" : literal.flags.replace("i", "");
  const flags = `${EMPTY_FLAGS}${ignoreCase ? "i" : ""}${extraFlags}`;

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
      error: null,
    };
  }

  const source = kind === "regex" ? pattern : literalSource(pattern);
  const error = compileError(source, flags);

  return {
    raw,
    pattern,
    kind,
    ignoreCase,
    smartcase,
    isEmpty: false,
    source,
    flags,
    error,
  };
};

/**
 * Nested quantifiers, the shape that backtracks catastrophically.
 *
 * `(a+)+`, `(a*)*` and friends: a group that is itself quantified and whose
 * body is quantified. A user regex in `regexFindMode` is re-run against the
 * whole page on *every* keystroke, and once `exec` is inside such a pattern
 * nothing in JavaScript can interrupt it — find mode owns the keyboard, so the
 * tab is simply gone.
 *
 * A cheap syntactic pre-filter, not a decision procedure; `probeBacktracking`
 * below is what catches the shapes this misses.
 */
const NESTED_QUANTIFIER = /\((?![?]:)[^)]*[+*][^)]*\)\s*[+*{]/u;

/** Longest user pattern we will compile. */
const MAX_PATTERN_LENGTH = 512;

/**
 * Inputs that make a backtracking pattern show itself.
 *
 * Short on purpose, and each one ends in a character that forces the match to
 * *fail*: catastrophic backtracking only happens on a failing match. Twenty
 * characters is where a pathological pattern costs tens of milliseconds —
 * measurable — while a safe one costs hundredths, and where the probe itself
 * cannot become the hang it is looking for.
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
 * Milliseconds the whole probe may take before the pattern is refused.
 *
 * Measured separation at `PROBE_LENGTH`: safe patterns 0.02–0.05 ms,
 * pathological ones 14–150 ms. Eight is two orders of magnitude above the
 * former, so a GC pause cannot turn a safe pattern into a refused one.
 */
const PROBE_BUDGET_MS = 8;

/**
 * Does this pattern backtrack badly enough to be dangerous?
 *
 * Empirical rather than analytical, because the analytical question is not
 * decidable from the source and every syntactic rule either refuses patterns
 * users legitimately want (`(?:foo|bar)+`) or misses ones that hang
 * (`(ab|a)*c`). Running it is the only test that tells the truth.
 */
const probeBacktracking = (regex: RegExp): boolean => {
  const started = typeof performance !== "undefined"
    ? performance.now()
    : Date.now();
  for (const input of PROBE_INPUTS) {
    try {
      regex.lastIndex = 0;
      regex.test(input);
    } catch {
      return false;
    }
    const elapsed =
      (typeof performance !== "undefined" ? performance.now() : Date.now()) -
      started;
    if (elapsed > PROBE_BUDGET_MS) return true;
  }
  return false;
};

/** `null` when `source`/`flags` compile *and* are safe to run repeatedly. */
const compileError = (source: string, flags: string): string | null => {
  if (source.length > MAX_PATTERN_LENGTH) {
    return `pattern is longer than ${MAX_PATTERN_LENGTH} characters`;
  }

  let regex: RegExp;
  try {
    regex = new RegExp(source, flags);
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }

  if (NESTED_QUANTIFIER.test(source) || probeBacktracking(regex)) {
    return "this pattern backtracks badly enough to hang the page; " +
      "try a simpler one";
  }
  return null;
};

/**
 * Compile a parsed query, or `null` if it is empty or malformed.
 *
 * A fresh `RegExp` every call, never a cached one: `lastIndex` on a `g` regex
 * is mutable state and sharing it across two searches produces missed matches
 * that are almost impossible to reproduce.
 */
export const toRegExp = (query: ParsedFindQuery): RegExp | null => {
  if (query.isEmpty || query.error !== null) return null;
  try {
    return new RegExp(query.source, query.flags);
  } catch {
    return null;
  }
};

/**
 * A query that matches `text` literally, for `*` / `#`.
 *
 * `\b` word boundaries where the word starts and ends with a word character,
 * matching Vim's `*`. Case-sensitivity still goes through smartcase, so `*` on
 * `Foo` finds `Foo` but not `foo` — which is what upstream does too.
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
    error: null,
  };
};
