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
 * The rule set is a frozen object of pure functions, and not a class. The
 * memoisation lives inside one set, so two sets cannot share a result.
 */

import { Option } from "effect";
import { exclusionRuleSchema } from "~/domain/Persisted.ts";
import type { ExclusionRule } from "~/domain/Persisted.ts";
import { isLinearRegex, regexSafetyError } from "~/domain/RegexSafety.ts";

/**
 * The rule as it is stored, given again here.
 *
 * `Persisted.ts` owns the schema, because storage owns the shape of the data.
 * A caller of this module then needs only one import.
 */
export { exclusionRuleSchema };
export type { ExclusionRule };

export interface EffectiveRule {
  readonly enabled: boolean;
  /** The keys that go directly to the page. Empty when we are fully enabled. */
  readonly passKeys: string;
}

export const FULLY_ENABLED: EffectiveRule = { enabled: true, passKeys: "" };

const escapeRegExp = (input: string): string =>
  input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/**
 * Match the literal segments of `pattern` in order, anchored at both ends.
 *
 * The first segment must be a prefix, and the last segment must be a suffix.
 * `https://example.com/*` can therefore not match `https://evil.example.com.x/`.
 */
const globMatcher = (pattern: string): UrlMatcher => {
  const segments = pattern.split("*");
  const first = segments[0] ?? "";
  const last = segments[segments.length - 1] ?? "";
  const middle = segments.slice(1, -1);

  return (url: string): boolean => {
    if (segments.length === 1) return url === first;
    if (!url.startsWith(first)) return false;
    if (url.length < first.length + last.length) return false;
    if (!url.endsWith(last)) return false;

    let cursor = first.length;
    const limit = url.length - last.length;
    for (const segment of middle) {
      if (segment.length === 0) continue;
      const found = url.indexOf(segment, cursor);
      if (found === -1 || found + segment.length > limit) return false;
      cursor = found + segment.length;
    }
    return true;
  };
};

/** Is this pattern a raw regular expression, and not a glob? */
export const isRawPattern = (pattern: string): boolean => {
  const trimmed = pattern.trim();
  return trimmed.length > 1 && trimmed.startsWith("/") &&
    trimmed.endsWith("/");
};

/** What one pattern gave: a matcher, or the reason that we dropped it. */
type Compiled =
  | { readonly ok: true; readonly matches: UrlMatcher }
  | { readonly ok: false; readonly reason: string };

/**
 * Compile a Vimium URL pattern.
 *
 * `*` is the only wildcard. A pattern between two `/` characters is a raw
 * regular expression, which is the escape of upstream. A bad rule costs the
 * user that rule, and no other rule, so every failure comes back as a reason
 * and never as an exception.
 */
const compile = (pattern: string): Compiled => {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return { ok: false, reason: "the rule is empty" };
  if (trimmed.length > MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      reason: `the pattern is longer than ${MAX_PATTERN_LENGTH} characters`,
    };
  }

  if (isRawPattern(trimmed)) {
    const source = `^${trimmed.slice(1, -1)}$`;
    let regexp: RegExp;
    try {
      regexp = new RegExp(source);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return {
        ok: false,
        reason: `the expression does not compile: ${detail}`,
      };
    }
    // The page chooses the URL, and the rules run on every navigation. An
    // expression that backtracks turns one crafted URL into a tab that does
    // not answer: `(a+)+$` against forty characters already takes minutes.
    // The check refuses the shapes that it can prove ambiguous, and the cap
    // below bounds the work of every shape that it accepts.
    const problem = regexSafetyError(source, "");
    if (Option.isSome(problem)) return { ok: false, reason: problem.value };
    return {
      ok: true,
      matches: (url: string): boolean =>
        url.length <= MAX_REGEX_URL_LENGTH && regexp.test(url),
    };
  }

  const match = globMatcher(trimmed);
  return {
    ok: true,
    matches: (url: string): boolean =>
      url.length <= MAX_URL_LENGTH && match(url),
  };
};

/**
 * The matcher for one pattern, or `Option.none()` when we drop the rule.
 *
 * Use `patternProblem` when the caller must tell the user why.
 */
export const compilePattern = (pattern: string): Option.Option<UrlMatcher> => {
  const outcome = compile(pattern);
  return outcome.ok ? Option.some(outcome.matches) : Option.none();
};

/**
 * Why did this pattern give no matcher?
 *
 * A `None` means that the pattern compiled. A `Some` carries a reason that a
 * user can read, so that a dropped rule is never silent.
 */
export const patternProblem = (pattern: string): Option.Option<string> => {
  const outcome = compile(pattern);
  return outcome.ok ? Option.none() : Option.some(outcome.reason);
};

/** One rule of the settings text, and the line that holds it. */
export interface NumberedRule {
  /** The line number that the user sees, counted from one. */
  readonly line: number;
  readonly rule: ExclusionRule;
}

/**
 * Read the rules of the settings text: `pattern [passKeys]` on each line.
 *
 * An empty line gives no rule, and `#` starts a comment. The line number comes
 * with each rule, so that a caller can mark the line that holds a bad rule.
 */
export const parseExclusionLines = (
  text: string,
): ReadonlyArray<NumberedRule> => {
  const out: NumberedRule[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const trimmed = (lines[index] ?? "").trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const space = trimmed.search(/\s/);
    out.push({
      line: index + 1,
      rule: space === -1 ? { pattern: trimmed, passKeys: "" } : {
        pattern: trimmed.slice(0, space),
        passKeys: trimmed.slice(space + 1).trim(),
      },
    });
  }
  return out;
};

/**
 * The lines of the settings text that give no rule, and why.
 *
 * A pattern that does not compile is dropped, and the page then stops being
 * excluded. The user must see which line did that, so the settings dialog
 * shows this list. The function is pure, so a test can hold the whole table of
 * reasons.
 */
export const exclusionProblems = (text: string): ReadonlyArray<string> => {
  const problems: string[] = [];
  for (const { line, rule } of parseExclusionLines(text)) {
    const problem = patternProblem(rule.pattern);
    if (Option.isSome(problem)) {
      problems.push(`line ${line}: ${rule.pattern} - ${problem.value}`);
    }
  }
  return problems;
};

/**
 * The regular expression that a glob is *equivalent* to.
 *
 * Kept for the tests, and for a view that shows the user what a pattern means.
 * It is not used to match. See `UrlMatcher`.
 *
 * The safety check runs on a raw expression only. A glob cannot backtrack,
 * because `globMatcher` reads it greedily, and a run of `*` in a glob becomes
 * one `.*` here. The two functions therefore accept the same patterns.
 */
export const patternToRegExp = (pattern: string): Option.Option<RegExp> => {
  const trimmed = pattern.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PATTERN_LENGTH) {
    return Option.none();
  }

  const raw = isRawPattern(trimmed);
  const body = raw
    ? trimmed.slice(1, -1)
    // A run of `*` means what one `*` means, and `.*.*` is a shape that the
    // safety check refuses. Collapse the run before the translation.
    : trimmed.replace(/\*+/g, "*").split("*").map(escapeRegExp).join(".*");
  const source = `^${body}$`;

  if (raw && !isLinearRegex(source, "")) return Option.none();

  try {
    return Option.some(new RegExp(source));
  } catch {
    return Option.none();
  }
};

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

/**
 * Compile the rules once, and give a frozen set of functions.
 *
 * The cache belongs to the returned set, and the set holds no other state. Two
 * calls with the same rules give two independent sets, and each one answers
 * every URL in the same way. The result is therefore the same as a set with no
 * cache.
 */
export const makeExclusionSet = (
  rules: readonly ExclusionRule[],
): ExclusionSet => {
  const compiled: CompiledRule[] = [];
  const dropped: DroppedRule[] = [];
  for (const rule of rules) {
    const outcome = compile(rule.pattern);
    if (outcome.ok) {
      compiled.push({ matches: outcome.matches, passKeys: rule.passKeys });
    } else {
      dropped.push({ pattern: rule.pattern, reason: outcome.reason });
    }
  }

  const cache = new Map<string, EffectiveRule>();

  const resolve = (url: string): EffectiveRule => {
    const matching = compiled.filter((rule) => rule.matches(url));
    if (matching.length === 0) return FULLY_ENABLED;
    if (matching.some((rule) => rule.passKeys.length === 0)) {
      return { enabled: false, passKeys: "" };
    }
    const keys = new Set<string>();
    for (const rule of matching) {
      for (const key of rule.passKeys) keys.add(key);
    }
    return { enabled: true, passKeys: [...keys].join("") };
  };

  const match = (url: string): EffectiveRule => {
    const cached = cache.get(url);
    if (cached !== undefined) return cached;

    const result = resolve(url);
    // The cache has a limit. A single-page application can make an unlimited
    // number of different URLs, and this function runs on every navigation.
    if (cache.size > 64) cache.clear();
    cache.set(url, result);
    return result;
  };

  return Object.freeze({ size: compiled.length, dropped, match });
};

/**
 * Does this key go directly to the page?
 *
 * Only a key of one character can be a pass key. A `passKeys` string is a set
 * of characters, so `<c-a>` can never be in one. Upstream has the same limit.
 */
export const isPassKey = (rule: EffectiveRule, notation: string): boolean =>
  notation.length === 1 && rule.passKeys.includes(notation);
