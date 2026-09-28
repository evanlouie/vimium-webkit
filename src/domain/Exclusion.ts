/**
 * The exclusion rules for one URL.
 *
 * Ported from the upstream Vimium `background_scripts/exclusions.js` (MIT),
 * with one difference in structure. Vimium reads the rules in the background
 * against `sender.tab.url`, which is the URL of the *top* frame. We have no
 * background. A child frame must therefore ask the top frame for the effective
 * rule, and must not read its own URL. An error here leaves Vimium-WebKit
 * active inside an advertisement iframe on a page that the user excluded.
 *
 * The rule set is a record of pure functions, and not a class.
 */

import {
  Array,
  Boolean,
  Data,
  Match,
  Option,
  Predicate,
  Result,
  Schema,
  String as Str,
  flow,
  pipe,
} from "effect";
import { constFalse } from "effect/Function";
import { exclusionRuleSchema } from "~/domain/Persisted.ts";
import type { ExclusionRule } from "~/domain/Persisted.ts";
import { regexSafetyError } from "~/domain/RegexSafety.ts";

/**
 * The rule as it is stored, given again here.
 *
 * `Persisted.ts` owns the schema, because storage owns the shape of the data.
 * A caller of this module then needs only one import.
 */
export { exclusionRuleSchema };
export type { ExclusionRule };

/**
 * The verdict of the exclusion rules for one page.
 *
 * `Disabled` keeps us off the page entirely. `Enabled` keeps us on, and gives
 * the page the keys in `passKeys`.
 *
 * It is a schema, because the verdict travels between frames.
 * `domain/FrameMessage.ts` keeps the two fields of the wire, and decodes them
 * into this union.
 */
export const EffectiveRule = Schema.TaggedUnion({
  Disabled: {},
  Enabled: {
    /** The keys that go directly to the page. Empty when we are fully enabled. */
    passKeys: Schema.String,
  },
});

export type EffectiveRule = typeof EffectiveRule.Type;

export const FULLY_ENABLED: EffectiveRule = EffectiveRule.cases.Enabled.make({ passKeys: "" });

/** The verdict of a rule with no pass keys: we stay off the page entirely. */
const FULLY_DISABLED: EffectiveRule = EffectiveRule.cases.Disabled.make({});

const escapeRegExp = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The longest URL that we test a glob against.
 *
 * The page controls its URLs, and a URL can be some megabytes long. Examples
 * are a `data:` URL in an anchor, and a router that keeps its state in the
 * fragment. Nothing correct comes near this limit, and the glob matcher is
 * linear in the length of the input.
 */
const MAX_URL_LENGTH = 4096;

/**
 * The longest URL that we test a raw regular expression against.
 *
 * This is the second check, and it is the one that holds. The static check in
 * `~/domain/RegexSafety.ts` refuses the shapes that it can prove ambiguous,
 * but it does not promise a linear match. `[a-z]*x` is linear at one start
 * position, and a search over all positions is quadratic.
 *
 * The cap turns that class into a fixed cost. The slowest expression that the
 * check accepts is a quadratic one, and 512 characters of it cost about 2 ms.
 * A rule with a raw expression does not match a URL that is longer than the
 * cap, and `~/core/Exclusions.ts` writes a warning when that happens. A page
 * that makes its own URL longer than the cap therefore escapes a raw rule.
 * Write the rule as a glob for such a page: a glob reads 4096 characters.
 */
export const MAX_REGEX_URL_LENGTH = 512;

/** The longest regular expression from the user that we compile. */
const MAX_PATTERN_LENGTH = 1024;

/**
 * A compiled URL pattern.
 *
 * This is a predicate, and not a `RegExp`. The glob form is not compiled to a
 * regular expression on purpose. `a*b*c*d*` becomes `^a.*b.*c.*d.*$`, and the
 * backtracking of that expression is polynomial in the number of wildcards
 * against a long URL that does not match. The page chooses the URL. A glob is
 * matched greedily instead. That is linear, and it is equivalent, because `*`
 * is the only wildcard.
 */
export type UrlMatcher = (url: string) => boolean;

/** A matcher that refuses a URL longer than `limit`, and never reads it. */
const capped =
  (limit: number) =>
  (matches: UrlMatcher): UrlMatcher =>
  (url) =>
    url.length <= limit && matches(url);

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

/**
 * A glob, read once into the parts that the matcher checks.
 *
 * A glob with no `*` matches one URL. Any other glob keeps the text before the
 * first `*` as a prefix, the text after the last `*` as a suffix, and the
 * segments between them. An empty segment, which `**` makes, matches where the
 * last segment ended.
 */
type GlobShape = Data.TaggedEnum<{
  Literal: { readonly text: string };
  Wildcard: {
    readonly prefix: string;
    readonly inner: ReadonlyArray<string>;
    readonly suffix: string;
  };
}>;

const GlobShape = Data.taggedEnum<GlobShape>();

type Wildcard = Data.TaggedEnum.Value<GlobShape, "Wildcard">;

const readGlob: (glob: string) => GlobShape = flow(
  Str.split("*"),
  Array.unprepend,
  ([prefix, rest]) =>
    pipe(
      rest,
      Array.matchRight({
        onEmpty: () => GlobShape.Literal({ text: prefix }),
        onNonEmpty: (inner, suffix) => GlobShape.Wildcard({ prefix, inner, suffix }),
      }),
    ),
);

/**
 * Where to look next, once `segment` is found at or after `cursor`.
 *
 * `None` when the segment does not occur before `limit`, where the suffix
 * starts.
 */
const placeSegment =
  (url: string, limit: number) =>
  (cursor: Option.Option<number>, segment: string): Option.Option<number> =>
    pipe(
      cursor,
      Option.map((from) => url.indexOf(segment, from)),
      Option.filter((found) => found !== -1 && found + segment.length <= limit),
      Option.map((found) => found + segment.length),
    );

/**
 * Match the literal segments of a glob in order, anchored at both ends.
 *
 * The prefix must start the URL, and the suffix must end it.
 * `https://example.com/*` can therefore not match `https://evil.example.com.x/`.
 */
const wildcardMatches =
  ({ prefix, inner, suffix }: Wildcard): UrlMatcher =>
  (url) =>
    url.startsWith(prefix) &&
    url.length >= prefix.length + suffix.length &&
    url.endsWith(suffix) &&
    pipe(
      inner,
      Array.reduce(Option.some(prefix.length), placeSegment(url, url.length - suffix.length)),
      Option.isSome,
    );

const globMatcher: (shape: GlobShape) => UrlMatcher = GlobShape.$match({
  Literal:
    ({ text }): UrlMatcher =>
    (url) =>
      url === text,
  Wildcard: wildcardMatches,
});

/** The regular expression source that a glob is equivalent to. */
const globSource: (glob: string) => string = flow(
  // A run of `*` means what one `*` means, and `.*.*` is a shape that the
  // safety check refuses. Collapse the run before the translation.
  Str.replace(/\*+/g, "*"),
  Str.split("*"),
  Array.map(escapeRegExp),
  Array.join(".*"),
);

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Is this pattern a raw regular expression, and not a glob? */
export const isRawPattern = (pattern: string): boolean => {
  const trimmed = pattern.trim();
  return trimmed.length > 1 && trimmed.startsWith("/") && trimmed.endsWith("/");
};

/**
 * A pattern that passed every check: a raw expression between two `/`, or a
 * glob.
 *
 * The raw expression compiled, and the safety check accepted it. A glob cannot
 * backtrack, so it needs no such check. `readPattern` is the one place that
 * makes this value, so no later step checks a pattern again.
 */
type SafePattern = Data.TaggedEnum<{
  Expression: { readonly regexp: RegExp };
  Glob: { readonly glob: string };
}>;

const SafePattern = Data.taggedEnum<SafePattern>();

/** What a thrown value says. A `RegExp` that does not compile throws a `SyntaxError`. */
const describeCause = (cause: unknown): string =>
  pipe(
    Match.value(cause),
    Match.when(Predicate.isError, (error) => error.message),
    Match.orElse((other) => String(other)),
  );

/** Compile a raw expression and check it, or say why we drop it. */
const readExpression = (body: string): Result.Result<SafePattern, string> =>
  Result.gen(function* () {
    const source = `^${body}$`;
    const regexp = yield* Result.try({
      try: () => new RegExp(source),
      catch: (cause) => `the expression does not compile: ${describeCause(cause)}`,
    });
    // The page chooses the URL, and the rules run on every navigation. An
    // expression that backtracks turns one crafted URL into a tab that does
    // not answer: `(a+)+$` against forty characters already takes minutes.
    // The check refuses the shapes that it can prove ambiguous, and the cap
    // of the matcher bounds the work of every shape that it accepts.
    yield* pipe(
      regexSafetyError(source, ""),
      Option.match({ onNone: () => Result.void, onSome: Result.fail }),
    );
    return SafePattern.Expression({ regexp });
  });

/**
 * Read a pattern that the user wrote, and check it, or say why it gives no
 * rule.
 *
 * `*` is the only wildcard. A pattern between two `/` characters is a raw
 * regular expression, which is the escape of upstream. A bad rule costs the
 * user that rule, and no other rule, so every failure comes back as a reason
 * and never as an exception.
 */
const readPattern: (pattern: string) => Result.Result<SafePattern, string> = flow(
  Str.trim,
  Result.liftPredicate(Str.isNonEmpty, () => "the rule is empty"),
  Result.filterOrFail(
    (trimmed) => trimmed.length <= MAX_PATTERN_LENGTH,
    () => `the pattern is longer than ${MAX_PATTERN_LENGTH} characters`,
  ),
  Result.flatMap((trimmed) =>
    pipe(
      isRawPattern(trimmed),
      Boolean.match({
        onTrue: () => readExpression(trimmed.slice(1, -1)),
        onFalse: () => Result.succeed(SafePattern.Glob({ glob: trimmed })),
      }),
    ),
  ),
);

/** The matcher of a checked pattern. Each form reads a capped length of URL. */
const matcherOf: (pattern: SafePattern) => UrlMatcher = SafePattern.$match({
  Expression: ({ regexp }) => pipe((url: string) => regexp.test(url), capped(MAX_REGEX_URL_LENGTH)),
  Glob: ({ glob }) => pipe(glob, readGlob, globMatcher, capped(MAX_URL_LENGTH)),
});

/** Compile a Vimium URL pattern, or say why we drop it. */
const compile: (pattern: string) => Result.Result<UrlMatcher, string> = flow(
  readPattern,
  Result.map(matcherOf),
);

/**
 * The matcher for one pattern, or `Option.none()` when we drop the rule.
 *
 * Use `patternProblem` when the caller must tell the user why.
 */
export const compilePattern: (pattern: string) => Option.Option<UrlMatcher> = flow(
  compile,
  Result.getSuccess,
);

/**
 * Why did this pattern give no matcher?
 *
 * A `None` means that the pattern compiled. A `Some` carries a reason that a
 * user can read, so that a dropped rule is never silent.
 */
export const patternProblem: (pattern: string) => Option.Option<string> = flow(
  compile,
  Result.getFailure,
);

// ---------------------------------------------------------------------------
// The settings text
// ---------------------------------------------------------------------------

/** One rule of the settings text, and the line that holds it. */
export interface NumberedRule {
  /** The line number that the user sees, counted from one. */
  readonly line: number;
  readonly rule: ExclusionRule;
}

/** The rule on one trimmed line: the pattern, and the pass keys after the first space. */
const readRule = (line: string): ExclusionRule =>
  pipe(
    line,
    Str.search(/\s/),
    Option.match({
      onNone: () => ({ pattern: line, passKeys: "" }),
      onSome: (space) => ({
        pattern: line.slice(0, space),
        passKeys: line.slice(space + 1).trim(),
      }),
    }),
  );

/**
 * Read the rules of the settings text: `pattern [passKeys]` on each line.
 *
 * An empty line gives no rule, and `#` starts a comment. The line number comes
 * with each rule, so that a caller can mark the line that holds a bad rule.
 */
export const parseExclusionLines = (text: string): ReadonlyArray<NumberedRule> =>
  pipe(
    text,
    Str.split(/\r?\n/),
    Array.map((line, index) => ({ line: index + 1, text: line.trim() })),
    Array.filter(({ text }) => Str.isNonEmpty(text) && !text.startsWith("#")),
    Array.map(({ line, text }) => ({ line, rule: readRule(text) })),
  );

/**
 * The lines of the settings text that give no rule, and why.
 *
 * A pattern that does not compile is dropped, and the page then stops being
 * excluded. The user must see which line did that, so the settings dialog
 * shows this list. The function is pure, so a test can hold the whole table of
 * reasons.
 */
export const exclusionProblems: (text: string) => ReadonlyArray<string> = flow(
  parseExclusionLines,
  Array.map(({ line, rule }) =>
    pipe(
      patternProblem(rule.pattern),
      Option.map((problem) => `line ${line}: ${rule.pattern} - ${problem}`),
    ),
  ),
  Array.getSomes,
);

/** The regular expression of a glob. `globSource` escapes every character but `*`. */
const globRegExp = Option.liftThrowable((glob: string) => new RegExp(`^${globSource(glob)}$`));

/**
 * The regular expression that a glob is *equivalent* to.
 *
 * Kept for the tests, and for a view that shows the user what a pattern means.
 * It is not used to match. See `UrlMatcher`.
 *
 * It reads the pattern as `compilePattern` does, so the two functions accept
 * the same patterns. A raw expression gives the expression that passed the
 * safety check. A glob cannot backtrack, because the glob matcher reads it
 * greedily, and a run of `*` in a glob becomes one `.*` here.
 */
export const patternToRegExp: (pattern: string) => Option.Option<RegExp> = flow(
  readPattern,
  Result.getSuccess,
  Option.flatMap(
    SafePattern.$match({
      Expression: ({ regexp }) => Option.some(regexp),
      Glob: ({ glob }) => globRegExp(glob),
    }),
  ),
);

// ---------------------------------------------------------------------------
// The rule set
// ---------------------------------------------------------------------------

interface CompiledRule {
  readonly matches: UrlMatcher;
  readonly passKeys: string;
}

/** A rule that did not compile, with the reason that the user must read. */
export interface DroppedRule {
  readonly pattern: string;
  readonly reason: string;
}

/** A compiled set of exclusion rules. Every method is pure. */
export interface ExclusionSet {
  /** How many rules compiled. A bad pattern is not counted. */
  readonly size: number;
  /**
   * The rules that did not compile, in the order that the user wrote them.
   *
   * A dropped rule stops protecting the page, so the caller must tell the
   * user. `~/core/Exclusions.ts` writes one warning for each entry, and the
   * settings dialog marks the line.
   */
  readonly dropped: ReadonlyArray<DroppedRule>;
  /**
   * Resolve the rule for a URL.
   *
   * An empty `passKeys` on *any* rule that matches is the strongest result,
   * and it disables us completely. In every other case the pass keys of all
   * rules that match are joined. This order is the order of upstream. It makes
   * "add an exclusion for this site" behave as users expect when two rules
   * cover the same URL.
   */
  readonly match: (url: string) => EffectiveRule;
}

const compileRule = ({
  pattern,
  passKeys,
}: ExclusionRule): Result.Result<CompiledRule, DroppedRule> =>
  pipe(
    pattern,
    compile,
    Result.mapBoth({
      onSuccess: (matches) => ({ matches, passKeys }),
      onFailure: (reason) => ({ pattern, reason }),
    }),
  );

/** The keys that one matching rule gives to the page. `None` when it gives none. */
const passedKeys = ({ passKeys }: CompiledRule): Option.Option<string> =>
  pipe(passKeys, Option.liftPredicate(Str.isNonEmpty));

/**
 * The verdict of rules that each give the page some keys.
 *
 * Each key appears once, in the order that the rules first name it.
 */
const passing = (keys: ReadonlyArray<string>): EffectiveRule =>
  EffectiveRule.cases.Enabled.make({
    passKeys: pipe(keys, Array.flatMap(Array.fromIterable), Array.dedupe, Array.join("")),
  });

/**
 * The verdict of the rules that match one URL.
 *
 * A rule that gives the page no key turns us off, and it wins over every other
 * rule. The keys therefore join only when every rule gives some.
 */
const verdictFor =
  (rules: ReadonlyArray<CompiledRule>) =>
  (url: string): EffectiveRule =>
    pipe(
      rules,
      Array.filter((rule) => rule.matches(url)),
      Array.match({
        onEmpty: () => FULLY_ENABLED,
        onNonEmpty: flow(
          Array.map(passedKeys),
          Option.all,
          Option.match({ onNone: () => FULLY_DISABLED, onSome: passing }),
        ),
      }),
    );

/**
 * Compile the rules once, and give a set of functions.
 *
 * The set holds no state. Two calls with the same rules give two sets that
 * answer every URL in the same way.
 */
export const makeExclusionSet = (rules: ReadonlyArray<ExclusionRule>): ExclusionSet => {
  const [dropped, compiled] = pipe(rules, Array.map(compileRule), Array.separate);
  return { size: compiled.length, dropped, match: verdictFor(compiled) };
};

/**
 * Does this key go directly to the page?
 *
 * Only a key of one character can be a pass key. A `passKeys` string is a set
 * of characters, so `<c-a>` can never be in one. Upstream has the same limit.
 */
export const isPassKey = (rule: EffectiveRule, notation: string): boolean =>
  notation.length === 1 &&
  pipe(
    rule,
    EffectiveRule.match({
      Disabled: constFalse,
      Enabled: ({ passKeys }) => passKeys.includes(notation),
    }),
  );
