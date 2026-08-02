/**
 * The scoring and the matching of filter mode.
 *
 * Ported from the Vimium `content_scripts/link_hints.js`
 * (`FilterHints.scoreLinkHint` and `filterLinkHints`, MIT).
 *
 * Pure, like `HintString.ts`. Filter mode runs this again on every keystroke,
 * so it is the hottest part of the subsystem, and the part where a small error
 * is the most difficult to see.
 */

import { Option } from "effect";
import { numberToHintString } from "~/domain/HintString.ts";

export interface FilterCandidate {
  /** A stable index into the full hint list of the session. It survives a renumber. */
  readonly index: number;
  readonly linkText: string;
  /** The "second-class citizen" flag of upstream. */
  readonly secondary: boolean;
}

export interface FilterMatch {
  readonly index: number;
  /** The new hint string. It is computed again on every keystroke. */
  readonly hintString: string;
  readonly score: number;
}

export interface FilterQuery {
  /** The queue of keystrokes for the link text. */
  readonly text: string;
  /** The queue of digit keystrokes. */
  readonly digits: string;
  /** The `linkHintNumbers` setting. */
  readonly numberCharacters: string;
}

export interface FilterOutcome {
  /** Everything that the text query matched, in score order, numbered from 1. */
  readonly matched: readonly FilterMatch[];
  /** The part whose hint string starts with the digit queue. */
  readonly candidates: readonly FilterMatch[];
  /**
   * The one hint that the user named without doubt.
   *
   * A `Some` does not mean "activate now". `"1"` is a prefix of `"12"`, so the
   * caller must still wait for `Enter` or for a pause in the typing while
   * `candidates.length > 1`.
   */
  readonly exact: Option.Option<FilterMatch>;
}

/** Lowercase words that are separated by whitespace. Empty input gives no words. */
export const linkWords = (text: string): readonly string[] => {
  const trimmed = text.toLowerCase().trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/\s+/u).filter((word) => word.length > 0);
};

/**
 * The word relevancy of Vimium.
 *
 * Every query word must hit *some* word of the link, or the candidate gets
 * zero. A hit on a prefix is worth two times a hit inside a word. The total is
 * divided by the joined word count, so a link of two words that matches two
 * query words wins against a paragraph of twenty words that contains them.
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
    // One miss makes the whole candidate zero. Filter mode is a filter, and
    // not a ranking. A link without a typed word is not the target.
    if (best === 0) return 0;
    total += best;
  }

  return total / (candidateWords.length + searchWords.length);
};

/**
 * Score, filter, sort and number again, in one pass.
 *
 * The new numbers on every keystroke are what make filter mode usable. The
 * digit next to a link is always the digit that selects it at this moment.
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
    // `Array#sort` is stable, so equal scores keep the document order.
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
    ? (candidateMatches.length === 1
      ? Option.fromNullishOr(candidateMatches[0] ?? null)
      : Option.none())
    : Option.fromNullishOr(
      candidateMatches.find((match) => match.hintString === query.digits) ??
        null,
    );

  return { matched, candidates: candidateMatches, exact };
};

/**
 * How many first characters of `hintString` the digit queue used.
 *
 * The marker shows the part that is already typed in a weaker colour.
 */
export const matchedPrefixLength = (
  hintString: string,
  digits: string,
): number => (hintString.startsWith(digits) ? digits.length : 0);
