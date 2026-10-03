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
 * Nothing here throws. A pattern that does not compile comes back `Invalid`,
 * with the reason, and the HUD shows it while the user still types.
 */

import {
  Array,
  Boolean,
  Data,
  flow,
  Match,
  Option,
  pipe,
  Predicate,
  Result,
  String as Str,
} from "effect";
import { regexSafetyError } from "~/domain/RegexSafety.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FindQueryKind = "literal" | "regex";

export interface FindQueryOptions {
  /** `Settings.regexFindMode`: read a plain query as a regular expression. */
  readonly regexFindMode: boolean;
}

/**
 * A find query, read once.
 *
 * Every state keeps `raw`, exactly what the user typed, for the history and
 * for the messages of the `n` and `N` repeat. The repeat runs the parsed query
 * again, and never a new parse of `raw`, so a `wordQuery` keeps its word
 * boundaries.
 */
export type ParsedFindQuery = Data.TaggedEnum<{
  /** Nothing is left to search for once the delimiters and the directives are gone. */
  Empty: { readonly raw: string };
  /** The pattern is not a regular expression that compiles and is safe to run. */
  Invalid: { readonly raw: string; readonly error: string };
  /** A pattern that the engine can run. */
  Ready: {
    readonly raw: string;
    /** The query without the delimiters and without the escape directives. */
    readonly pattern: string;
    readonly kind: FindQueryKind;
    readonly ignoreCase: boolean;
    /** True when smartcase gave `ignoreCase`, and the user did not state it. */
    readonly smartcase: boolean;
    /** The `RegExp` source of this query. */
    readonly source: string;
    readonly flags: string;
  };
}>;

export const ParsedFindQuery = Data.taggedEnum<ParsedFindQuery>();

export type ReadyFindQuery = Data.TaggedEnum.Value<ParsedFindQuery, "Ready">;

// ---------------------------------------------------------------------------
// Case analysis
// ---------------------------------------------------------------------------

/** The characters of `text`, one code point each. */
const charactersOf = (text: string): ReadonlyArray<string> => Array.fromIterable(text);

/**
 * Does `text` hold a character in upper case that has a different lower case?
 *
 * Upstream tests `/[A-Z]/`, which turns smartcase off for every script that is
 * not Latin, and says nothing. The general form costs one pass, and it is
 * correct for Greek, for Cyrillic and for the Latin supplement.
 */
export const hasUpperCase: (text: string) => boolean = flow(
  charactersOf,
  Array.some((char) => char !== char.toLowerCase() && char === char.toUpperCase()),
);

/** The flag letter that case-insensitive matching adds. */
const caseFlag: (ignoreCase: boolean) => string = Boolean.match({
  onFalse: () => "",
  onTrue: () => "i",
});

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** The characters that mean something in a regular expression. */
const METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * Escape `text` for literal use inside a regular expression.
 *
 * `-` is not escaped, on purpose. `\-` is a syntax error under the `u` flag,
 * and this module never sets `u`, so that a pattern with a single escape such
 * as `\d` behaves as a user of Vim expects.
 */
export const escapeRegExp: (text: string) => string = Str.replace(METACHARACTERS, "\\$&");

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
export const literalSource: (pattern: string) => string = flow(
  Str.split(WHITESPACE_RUN),
  Array.map(escapeRegExp),
  Array.join(" +"),
);

// ---------------------------------------------------------------------------
// `/regex/` literals
// ---------------------------------------------------------------------------

/** The flags that a user may add to a `/…/` literal. The engine adds `g`. */
const ALLOWED_LITERAL_FLAGS = "ims";

export interface RegexLiteral {
  readonly body: string;
  readonly flags: string;
}

/** Does an odd number of backslashes come before the character at `index`? */
const isEscaped = (text: string, index: number): boolean =>
  pipe(
    text.slice(0, index),
    charactersOf,
    Array.reverse,
    Array.takeWhile((char) => char === "\\"),
    Array.length,
    (slashes) => slashes % 2 === 1,
  );

/** The last `/` of `text` that is not escaped, after the first character. */
const closingDelimiter = (text: string): Option.Option<number> =>
  pipe(
    Array.range(1, text.length - 1),
    Array.findLast((index) => text.charAt(index) === "/" && !isEscaped(text, index)),
  );

/** Allowed flag letters, each at most once. `new RegExp` would throw on a repeated flag. */
const areLiteralFlags = (flags: string): boolean =>
  pipe(
    flags,
    charactersOf,
    (letters) =>
      pipe(
        letters,
        Array.every((flag) => ALLOWED_LITERAL_FLAGS.includes(flag)),
      ) && pipe(letters, Array.dedupe, Array.length) === flags.length,
  );

/**
 * Split `/pattern/flags`.
 *
 * The result is `Option.none()` when `text` is not such a literal. The closing
 * delimiter is the last `/` that is not escaped, and everything after it must
 * be an allowed flag letter. A plain search for `and/or` is therefore still a
 * literal search, and not an empty regular expression with a false flag.
 */
export const splitRegexLiteral = (text: string): Option.Option<RegexLiteral> =>
  pipe(
    text,
    Option.liftPredicate((candidate) => candidate.length >= 2 && candidate.startsWith("/")),
    Option.flatMap(closingDelimiter),
    Option.map((closing) => ({ body: text.slice(1, closing), flags: text.slice(closing + 1) })),
    Option.filter(({ flags }) => areLiteralFlags(flags)),
  );

// ---------------------------------------------------------------------------
// The inline directives of Vimium
// ---------------------------------------------------------------------------

export interface Directives {
  readonly text: string;
  readonly isRegex: Option.Option<boolean>;
  readonly ignoreCase: Option.Option<boolean>;
}

/** `\r`, `\R`, `\i` and `\I`, and the same four with a doubled backslash. */
const DIRECTIVE = /(\\{1,2})([rRiI])/g;

/** The text of one group of a match, or `""` when it matched nothing. */
const groupText = (match: RegExpMatchArray, group: number): string =>
  pipe(
    match,
    Array.get(group),
    Option.flatMap(Option.fromNullishOr),
    Option.getOrElse(() => ""),
  );

/** What the last of the letters `on` and `off` sets, when one of them is there. */
const lastSetting = (
  letters: ReadonlyArray<string>,
  on: string,
  off: string,
): Option.Option<boolean> =>
  pipe(
    letters,
    Array.findLast((letter) => letter === on || letter === off),
    Option.map((letter) => letter === on),
  );

/**
 * Remove the `\r`, `\R`, `\i` and `\I` directives of Vimium.
 *
 * `\r` selects regex mode, `\R` selects literal mode, `\i` selects
 * case-insensitive and `\I` selects case-sensitive. They are kept, so the
 * habits of an upstream user still work. When one query holds two directives
 * of one kind, the last one wins.
 *
 * One difference on purpose: upstream keeps a doubled `\\r` in the query as it
 * is, so a literal search for `\r` is not possible. Here `\\r` becomes `\r`,
 * which is the meaning of "escape the escape character".
 */
export const stripDirectives = (text: string): Directives => {
  const letters = pipe(
    text.matchAll(DIRECTIVE),
    Array.fromIterable,
    Array.filter((match) => groupText(match, 1).length === 1),
    Array.map((match) => groupText(match, 2)),
  );
  return {
    text: text.replace(DIRECTIVE, (_match: string, slashes: string, letter: string) =>
      pipe(slashes.length === 2, Boolean.match({ onFalse: () => "", onTrue: () => `\\${letter}` })),
    ),
    isRegex: lastSetting(letters, "r", "R"),
    ignoreCase: lastSetting(letters, "i", "I"),
  };
};

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

const BASE_FLAGS = "g";

/** The `RegExp` source that a pattern of this kind gives. */
const sourceOf = (kind: FindQueryKind, pattern: string): string =>
  pipe(
    Match.value(kind),
    Match.when("regex", () => pattern),
    Match.when("literal", () => literalSource(pattern)),
    Match.exhaustive,
  );

/** The message of what `new RegExp` threw. */
const failureMessage = (cause: unknown): string =>
  pipe(
    cause,
    Option.liftPredicate(Predicate.hasProperty("message")),
    Option.map(({ message }) => message),
    Option.filter(Predicate.isString),
    Option.getOrElse(() => String(cause)),
  );

/** A new `RegExp`, or the message of the syntax error. */
const compile = (source: string, flags: string): Result.Result<RegExp, string> =>
  Result.try({ try: () => new RegExp(source, flags), catch: failureMessage });

/** A `None` when `source` and `flags` compile *and* are safe to run. */
const compileError = (source: string, flags: string): Option.Option<string> =>
  pipe(
    compile(source, flags),
    Result.getFailure,
    // The safety check reads the text of the pattern, and never runs it. A
    // measurement cannot protect the page here, because the measurement cannot
    // end before the match ends: `(a|a|a|a)*$` takes minutes against twenty
    // characters, and nothing in JavaScript can stop an `exec` that is already
    // inside such a pattern. Find mode owns the keyboard, so the tab stops
    // answering.
    //
    // The check refuses only the shapes that it can prove ambiguous. It does
    // not promise a linear match, so `~/features/find/Engine.ts` reads the page
    // text in measured windows and stops at a deadline. That budget is the
    // second limit on the same pattern.
    Option.orElse(() =>
      pipe(
        regexSafetyError(source, flags),
        Option.map((reason) => `${reason}; try a simpler one`),
      ),
    ),
  );

/** `query`, or `Invalid` when its pattern does not compile or is not safe to run. */
const validated = (query: ReadyFindQuery): ParsedFindQuery =>
  pipe(
    compileError(query.source, query.flags),
    Option.match({
      onNone: (): ParsedFindQuery => query,
      onSome: (error) => ParsedFindQuery.Invalid({ raw: query.raw, error }),
    }),
  );

/**
 * Parse a raw find query into everything that the engine needs.
 *
 * This function never fails. A pattern that does not compile comes back
 * `Invalid`, with the reason. A query with nothing to search for, such as one
 * of directives alone, comes back `Empty`, and not `Invalid`.
 */
export const parseFindQuery = (raw: string, options: FindQueryOptions): ParsedFindQuery => {
  const literal = splitRegexLiteral(raw);
  const directives = pipe(
    literal,
    Option.match({
      onNone: () => stripDirectives(raw),
      onSome: ({ body }): Directives => ({
        text: body,
        isRegex: Option.some(true),
        ignoreCase: Option.none(),
      }),
    }),
  );
  const pattern = directives.text;
  const kind = pipe(
    directives.isRegex,
    Option.getOrElse(() => options.regexFindMode),
    Boolean.match({
      onFalse: (): FindQueryKind => "literal",
      onTrue: (): FindQueryKind => "regex",
    }),
  );
  const explicitIgnoreCase = pipe(
    directives.ignoreCase,
    Option.orElse(() =>
      pipe(
        literal,
        Option.filter(({ flags }) => flags.includes("i")),
        Option.as(true),
      ),
    ),
  );
  const ignoreCase = pipe(
    explicitIgnoreCase,
    Option.getOrElse(() => !hasUpperCase(pattern)),
  );
  const extraFlags = pipe(
    literal,
    Option.map(({ flags }) => flags.replace("i", "")),
    Option.getOrElse(() => ""),
  );
  const flags = `${BASE_FLAGS}${caseFlag(ignoreCase)}${extraFlags}`;

  return pipe(
    pattern,
    Option.liftPredicate(Str.isNonEmpty),
    Option.map((text) =>
      ParsedFindQuery.Ready({
        raw,
        pattern: text,
        kind,
        ignoreCase,
        smartcase: Option.isNone(explicitIgnoreCase),
        source: sourceOf(kind, text),
        flags,
      }),
    ),
    Option.map(validated),
    Option.getOrElse(() => ParsedFindQuery.Empty({ raw })),
  );
};

/**
 * Compile a parsed query.
 *
 * The result is `Option.none()` when the query is empty or bad. Each call
 * makes a new `RegExp`, and never a cached one. `lastIndex` on a `g`
 * expression is state that changes, and two searches that share it lose
 * matches. Such a fault is almost impossible to reproduce.
 */
export const toRegExp: (query: ParsedFindQuery) => Option.Option<RegExp> = ParsedFindQuery.$match({
  Empty: () => Option.none(),
  Invalid: () => Option.none(),
  Ready: ({ source, flags }) => pipe(compile(source, flags), Result.getSuccess),
});

/** `\b` when `edge` finds a word character at that end of `text`. */
const boundary = (edge: RegExp, text: string): string =>
  pipe(edge.test(text), Boolean.match({ onFalse: () => "", onTrue: () => "\\b" }));

/**
 * A query that matches `text` literally, for `*` and `#`.
 *
 * A `\b` word boundary is added where the word starts or ends with a word
 * character, as the `*` of Vim does. The case still goes through smartcase, so
 * `*` on `Foo` finds `Foo` and not `foo`. Upstream does the same. An empty word
 * gives an `Empty` query. A word query is never `Invalid`. Its text is
 * escaped, so it always compiles, and the pattern limits do not apply to it.
 */
export const wordQuery = (word: string): ParsedFindQuery => {
  const trimmed = word.trim();
  const ignoreCase = !hasUpperCase(trimmed);

  return pipe(
    trimmed,
    Option.liftPredicate(Str.isNonEmpty),
    Option.map((text): ParsedFindQuery =>
      ParsedFindQuery.Ready({
        raw: text,
        pattern: text,
        kind: "literal",
        ignoreCase,
        smartcase: true,
        source: `${boundary(/^\w/, text)}${literalSource(text)}${boundary(/\w$/, text)}`,
        flags: `g${caseFlag(ignoreCase)}`,
      }),
    ),
    Option.getOrElse(() => ParsedFindQuery.Empty({ raw: trimmed })),
  );
};
