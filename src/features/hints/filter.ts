/**
 * Filter-mode scoring and matching.
 *
 * Ported from Vimium's `content_scripts/link_hints.js` (`FilterHints.scoreLinkHint`,
 * `filterLinkHints`, MIT).
 *
 * Pure, like `hint-strings.ts`: filter mode re-runs this on every keystroke, so
 * it is both the hottest and the easiest-to-get-subtly-wrong part of the
 * subsystem.
 */

import { numberToHintString } from "./hint-strings.ts";

export interface FilterCandidate {
  /** Stable index into the session's full hint list. Survives renumbering. */
  readonly index: number;
  readonly linkText: string;
  /** Upstream's "second-class citizen" flag. */
  readonly secondary: boolean;
}

export interface FilterMatch {
  readonly index: number;
  /** The renumbered hint string, recomputed on every keystroke. */
  readonly hintString: string;
  readonly score: number;
}

export interface FilterQuery {
  /** The link-text keystroke queue. */
  readonly text: string;
  /** The digit keystroke queue. */
  readonly digits: string;
  /** `linkHintNumbers`. */
  readonly numberCharacters: string;
}

export interface FilterOutcome {
  /** Everything the link-text query matched, in score order, renumbered from 1. */
  readonly matched: readonly FilterMatch[];
  /** The subset whose hint string starts with the digit queue. */
  readonly candidates: readonly FilterMatch[];
  /**
   * The single hint the user has unambiguously named, if any.
   *
   * Non-`null` does not mean "activate now": `"1"` is a prefix of `"12"`, so
   * the caller still has to wait for `Enter` or a typing pause whenever
   * `candidates.length > 1`.
   */
  readonly exact: FilterMatch | null;
}

/** Whitespace-separated, lowercased words. Empty input yields no words. */
export const linkWords = (text: string): readonly string[] => {
  const trimmed = text.toLowerCase().trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/\s+/u).filter((word) => word.length > 0);
};

/**
 * Vimium's word relevancy.
 *
 * Every query word must hit *some* link word or the candidate scores zero
 * outright; a prefix hit is worth twice a substring hit; and the total is
 * normalised by the combined word count so that a two-word link matching two
 * query words beats a twenty-word paragraph that happens to contain them.
 */
export const scoreLinkText = (
  searchWords: readonly string[],
  candidateWords: readonly string[],
): number => {
  if (searchWords.length === 0) return 0;
  if (candidateWords.length === 0) return 0;

  let total = 0;
  for (const searchWord of searchWords) {
    let best = 0;
    for (const candidateWord of candidateWords) {
      let score = 0;
      if (candidateWord.startsWith(searchWord)) {
        score = searchWord.length / candidateWord.length;
      } else if (candidateWord.includes(searchWord)) {
        score = searchWord.length / candidateWord.length / 2;
      }
      if (score > best) best = score;
    }
    // One miss zeroes the whole candidate: filter mode is a filter, not a
    // ranking, and a link that lacks a typed word is simply not the target.
    if (best === 0) return 0;
    total += best;
  }

  return total / (candidateWords.length + searchWords.length);
};

/**
 * Score, filter, sort and renumber in one pass.
 *
 * Renumbering on every keystroke is what makes filter mode usable: the digit
 * you can see next to a link is always the digit that selects it *right now*.
 */
export const filterHints = (
  candidates: readonly FilterCandidate[],
  query: FilterQuery,
): FilterOutcome => {
  const searchWords = linkWords(query.text);

  let ordered: Array<
    { readonly candidate: FilterCandidate; readonly score: number }
  >;
  if (searchWords.length === 0) {
    ordered = candidates.map((candidate) => ({ candidate, score: 0 }));
  } else {
    ordered = candidates
      .map((candidate) => ({
        candidate,
        score: scoreLinkText(searchWords, linkWords(candidate.linkText)),
      }))
      .filter((entry) => entry.score > 0);
    // `Array#sort` is stable per spec, so equal scores keep document order.
    ordered.sort((a, b) => b.score - a.score);
  }

  const matched: FilterMatch[] = ordered.map((entry, position) => ({
    index: entry.candidate.index,
    hintString: numberToHintString(position + 1, query.numberCharacters),
    score: entry.score,
  }));

  const candidateMatches = query.digits.length === 0
    ? matched
    : matched.filter((match) => match.hintString.startsWith(query.digits));

  const exact = query.digits.length === 0
    ? (candidateMatches.length === 1 ? candidateMatches[0] ?? null : null)
    : candidateMatches.find((match) => match.hintString === query.digits) ??
      null;

  return { matched, candidates: candidateMatches, exact };
};

/**
 * How many leading characters of `hintString` the digit queue has consumed.
 * Used to dim the already-typed part of a marker.
 */
export const matchedPrefixLength = (
  hintString: string,
  digits: string,
): number => (hintString.startsWith(digits) ? digits.length : 0);
