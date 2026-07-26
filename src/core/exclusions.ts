/**
 * Per-URL exclusion rules.
 *
 * Ported from upstream Vimium's `background_scripts/exclusions.js` (MIT), with
 * one structural difference: Vimium evaluates rules in the background against
 * `sender.tab.url` (i.e. the *top* frame's URL), and we have no background. A
 * child frame must therefore ask the top frame for the effective rule rather
 * than evaluating against its own URL — see `FrameLinkApi.effectiveExclusion`.
 * Getting this wrong would leave Vimium-WebKit live inside an ad iframe on a
 * page the user had excluded.
 */

import type { ExclusionRule } from "~/settings/schema.ts";

export interface EffectiveRule {
  readonly enabled: boolean;
  /** Keys handed straight to the page. Empty when fully enabled. */
  readonly passKeys: string;
}

export const FULLY_ENABLED: EffectiveRule = { enabled: true, passKeys: "" };

const escapeRegExp = (input: string): string =>
  input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Longest URL we will test a pattern against.
 *
 * URLs are page-controlled and can be megabytes long (`data:` in an anchor, a
 * router that stashes state in the fragment). Nothing legitimate here is
 * anywhere near this, and every matcher below is at worst linear in the input
 * anyway — this is the second lock on the same door.
 */
const MAX_URL_LENGTH = 4096;

/** Longest user-supplied regular expression we will compile. */
const MAX_PATTERN_LENGTH = 1024;

/**
 * A compiled URL pattern.
 *
 * A predicate rather than a `RegExp` because the glob form is deliberately
 * *not* compiled to one: `a*b*c*d*` becomes `^a.*b.*c.*d.*$`, whose backtracking
 * is polynomial in the number of wildcards against a long non-matching URL —
 * and the URL is chosen by the page. Globs are matched greedily instead, which
 * is linear and, because `*` is the only wildcard, exactly equivalent.
 */
export type UrlMatcher = (url: string) => boolean;

/**
 * Match `pattern`'s literal segments in order, anchored at both ends.
 *
 * The first segment must be a prefix and the last a suffix, so
 * `https://example.com/*` cannot match `https://evil.example.com.x/`.
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
 * `*` is the only wildcard, and a pattern delimited by `/` is taken as a raw
 * regular expression (upstream's escape hatch). Returns `null` for anything
 * empty or malformed — a bad rule must cost the user that rule and nothing
 * else.
 */
export const compilePattern = (pattern: string): UrlMatcher | null => {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_PATTERN_LENGTH) return null;

  if (trimmed.length > 1 && trimmed.startsWith("/") && trimmed.endsWith("/")) {
    let regexp: RegExp;
    try {
      regexp = new RegExp(`^${trimmed.slice(1, -1)}$`);
    } catch {
      // A malformed regular expression must not disable every other rule.
      return null;
    }
    // The user wrote this one themselves, so there is no glob rewrite to make
    // it linear; bounding the input is the honest mitigation.
    return (url: string): boolean =>
      url.length <= MAX_URL_LENGTH && regexp.test(url);
  }

  const match = globMatcher(trimmed);
  return (url: string): boolean => url.length <= MAX_URL_LENGTH && match(url);
};

/**
 * The regular expression a glob is *equivalent* to.
 *
 * Kept for tests and for anything that needs to show the user what a pattern
 * means. Not used for matching — see `UrlMatcher`.
 */
export const patternToRegExp = (pattern: string): RegExp | null => {
  const trimmed = pattern.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PATTERN_LENGTH) return null;

  const source = trimmed.length > 1 && trimmed.startsWith("/") &&
      trimmed.endsWith("/")
    ? trimmed.slice(1, -1)
    : trimmed.split("*").map(escapeRegExp).join(".*");

  try {
    return new RegExp(`^${source}$`);
  } catch {
    return null;
  }
};

interface CompiledRule {
  readonly matches: UrlMatcher;
  readonly passKeys: string;
}

export class ExclusionSet {
  readonly #rules: readonly CompiledRule[];
  readonly #cache = new Map<string, EffectiveRule>();

  constructor(rules: readonly ExclusionRule[]) {
    const compiled: CompiledRule[] = [];
    for (const rule of rules) {
      const matches = compilePattern(rule.pattern);
      if (matches) compiled.push({ matches, passKeys: rule.passKeys });
    }
    this.#rules = compiled;
  }

  get size(): number {
    return this.#rules.length;
  }

  /**
   * Resolve the rule for a URL.
   *
   * An empty `passKeys` on *any* matching rule is the strongest outcome and
   * disables us entirely; otherwise the pass-key sets of all matching rules are
   * unioned. This ordering is upstream's and is what makes "add an exclusion
   * for this site" behave the way users expect when rules overlap.
   */
  match(url: string): EffectiveRule {
    const cached = this.#cache.get(url);
    if (cached) return cached;

    const matching = this.#rules.filter((rule) => rule.matches(url));
    let result: EffectiveRule;

    if (matching.length === 0) {
      result = FULLY_ENABLED;
    } else if (matching.some((rule) => rule.passKeys.length === 0)) {
      result = { enabled: false, passKeys: "" };
    } else {
      const keys = new Set<string>();
      for (const rule of matching) {
        for (const key of rule.passKeys) keys.add(key);
      }
      result = { enabled: true, passKeys: [...keys].join("") };
    }

    // Bounded: an SPA can generate unbounded distinct URLs, and this is
    // consulted on every navigation.
    if (this.#cache.size > 64) this.#cache.clear();
    this.#cache.set(url, result);
    return result;
  }
}

/**
 * Is this key passed straight through to the page?
 *
 * Only single-character keys can be pass keys — a `passKeys` string is a set of
 * characters, so `<c-a>` can never appear in one. Upstream has the same limit.
 */
export const isPassKey = (rule: EffectiveRule, notation: string): boolean =>
  notation.length === 1 && rule.passKeys.includes(notation);
