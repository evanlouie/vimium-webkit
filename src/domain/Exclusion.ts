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
import { isLinearRegex } from "~/domain/RegexSafety.ts";

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
 * The longest URL that we test a pattern against.
 *
 * The page controls its URLs, and a URL can be some megabytes long. Examples
 * are a `data:` URL in an anchor, and a router that keeps its state in the
 * fragment. Nothing correct comes near this limit, and each matcher below is
 * linear in the length of the input. This is the second lock on the same door.
 */
const MAX_URL_LENGTH = 4096;

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

/**
 * Compile a Vimium URL pattern.
 *
 * `*` is the only wildcard. A pattern between two `/` characters is a raw
 * regular expression, which is the escape of upstream. The result is
 * `Option.none()` for an empty, a bad or an unsafe pattern. A bad rule must
 * cost the user that rule, and no other rule.
 */
export const compilePattern = (pattern: string): Option.Option<UrlMatcher> => {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return Option.none();
  if (trimmed.length > MAX_PATTERN_LENGTH) return Option.none();

  if (trimmed.length > 1 && trimmed.startsWith("/") && trimmed.endsWith("/")) {
    const source = `^${trimmed.slice(1, -1)}$`;
    let regexp: RegExp;
    try {
      regexp = new RegExp(source);
    } catch {
      // A bad regular expression must not disable every other rule.
      return Option.none();
    }
    // The page chooses the URL, and the rules run on every navigation. An
    // expression that backtracks turns one crafted URL into a frozen tab, and
    // a limit on the length of the input does not stop it: `(a+)+$` against
    // forty characters already takes minutes. Only the shapes that match in
    // linear time are allowed. A glob has no such limit, and it stays the
    // format that we ask users for.
    if (!isLinearRegex(source, "")) return Option.none();
    return Option.some((url: string): boolean =>
      url.length <= MAX_URL_LENGTH && regexp.test(url)
    );
  }

  const match = globMatcher(trimmed);
  return Option.some((url: string): boolean =>
    url.length <= MAX_URL_LENGTH && match(url)
  );
};

/**
 * The regular expression that a glob is *equivalent* to.
 *
 * Kept for the tests, and for a view that shows the user what a pattern means.
 * It is not used to match. See `UrlMatcher`. It refuses the same patterns as
 * `compilePattern`, so the two functions cannot disagree.
 */
export const patternToRegExp = (pattern: string): Option.Option<RegExp> => {
  const trimmed = pattern.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PATTERN_LENGTH) {
    return Option.none();
  }

  const body =
    trimmed.length > 1 && trimmed.startsWith("/") && trimmed.endsWith("/")
      ? trimmed.slice(1, -1)
      : trimmed.split("*").map(escapeRegExp).join(".*");
  const source = `^${body}$`;

  if (!isLinearRegex(source, "")) return Option.none();

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

/** A compiled set of exclusion rules. Every method is pure. */
export interface ExclusionSet {
  /** How many rules compiled. A bad pattern is not counted. */
  readonly size: number;
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
  for (const rule of rules) {
    const matches = compilePattern(rule.pattern);
    if (Option.isSome(matches)) {
      compiled.push({ matches: matches.value, passKeys: rule.passKeys });
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

  return Object.freeze({ size: compiled.length, match });
};

/**
 * Does this key go directly to the page?
 *
 * Only a key of one character can be a pass key. A `passKeys` string is a set
 * of characters, so `<c-a>` can never be in one. Upstream has the same limit.
 */
export const isPassKey = (rule: EffectiveRule, notation: string): boolean =>
  notation.length === 1 && rule.passKeys.includes(notation);
