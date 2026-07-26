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
 * Compile a Vimium URL pattern.
 *
 * `*` is the only wildcard, and a pattern delimited by `/` is taken as a raw
 * regular expression (upstream's escape hatch). Patterns are anchored at both
 * ends so `https://example.com/*` does not match `https://evil.example.com.x/`.
 */
export const patternToRegExp = (pattern: string): RegExp | null => {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.length > 1 && trimmed.startsWith("/") && trimmed.endsWith("/")) {
    try {
      return new RegExp(`^${trimmed.slice(1, -1)}$`);
    } catch {
      // A malformed regular expression must not disable every other rule.
      return null;
    }
  }

  const body = trimmed.split("*").map(escapeRegExp).join(".*");
  try {
    return new RegExp(`^${body}$`);
  } catch {
    return null;
  }
};

interface CompiledRule {
  readonly regexp: RegExp;
  readonly passKeys: string;
}

export class ExclusionSet {
  readonly #rules: readonly CompiledRule[];
  readonly #cache = new Map<string, EffectiveRule>();

  constructor(rules: readonly ExclusionRule[]) {
    const compiled: CompiledRule[] = [];
    for (const rule of rules) {
      const regexp = patternToRegExp(rule.pattern);
      if (regexp) compiled.push({ regexp, passKeys: rule.passKeys });
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

    const matching = this.#rules.filter((rule) => rule.regexp.test(url));
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
