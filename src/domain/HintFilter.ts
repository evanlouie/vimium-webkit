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

import { Array, Boolean, flow, Option, Order, pipe, String } from "effect";
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
export const linkWords: (text: string) => readonly string[] = flow(
  String.toLowerCase,
  String.trim,
  String.split(/\s+/u),
  Array.filter(String.isNonEmpty),
);

/**
 * The word relevancy of Vimium.
 *
 * Every query word must hit *some* word of the link, or the candidate gets
 * zero. A hit on a prefix is worth two times a hit inside a word. The total is
 * divided by the joined word count, so a link of two words that matches two
 * query words wins against a paragraph of twenty words that contains them.
 *
 * Loops, and not an `Array` and `Option` pipeline: this runs for every word
 * of every candidate on each keystroke. In Node 26, 8000 candidates took
 * 0.7 ms to 1.2 ms with the loops and 6 ms to 11 ms with the pipeline.
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

/** One candidate with the score that the text query gave it. */
interface Scored {
  readonly candidate: FilterCandidate;
  readonly score: number;
}

const byScoreDescending: Order.Order<Scored> = Order.mapInput(
  Order.flip(Order.Number),
  ({ score }: Scored) => score,
);

/** A candidate that no query word ranks. It keeps its document order. */
const unscored = (candidate: FilterCandidate): Scored => ({ candidate, score: 0 });

/** The candidates that score above zero for the query words, best first. */
const rankedBy =
  (candidates: readonly FilterCandidate[]) =>
  (searchWords: readonly string[]): readonly Scored[] =>
    pipe(
      candidates,
      Array.map((candidate) => ({
        candidate,
        score: scoreLinkText(searchWords, linkWords(candidate.linkText)),
      })),
      Array.filter(({ score }) => score > 0),
      // `Array.sort` is stable, so equal scores keep the document order.
      Array.sort(byScoreDescending),
    );

/** Number a ranked candidate by its position, from 1. */
const numbered =
  (numberCharacters: string) =>
  ({ candidate, score }: Scored, position: number): FilterMatch => ({
    index: candidate.index,
    hintString: numberToHintString(position + 1, numberCharacters),
    score,
  });

/**
 * The one candidate that the digit queue names without doubt.
 *
 * With no digits, that is the only candidate that the text query left. With
 * digits, it is the candidate whose hint string is the digits.
 */
const exactMatch = (
  candidates: readonly FilterMatch[],
  digits: string,
): Option.Option<FilterMatch> =>
  pipe(
    digits,
    Option.liftPredicate(String.isNonEmpty),
    Option.match({
      onNone: () =>
        pipe(
          candidates,
          Option.liftPredicate((all) => all.length === 1),
          Option.flatMap(Array.head),
        ),
      onSome: (typed) =>
        pipe(
          candidates,
          Array.findFirst((match) => match.hintString === typed),
        ),
    }),
  );

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
  const matched = pipe(
    query.text,
    linkWords,
    Array.match({
      onEmpty: () => pipe(candidates, Array.map(unscored)),
      onNonEmpty: rankedBy(candidates),
    }),
    Array.map(numbered(query.numberCharacters)),
  );
  const narrowed = pipe(
    matched,
    Array.filter((match) => match.hintString.startsWith(query.digits)),
  );
  return { matched, candidates: narrowed, exact: exactMatch(narrowed, query.digits) };
};

/**
 * How many first characters of `hintString` the digit queue used.
 *
 * The marker shows the part that is already typed in a weaker colour.
 *
 * A count of UTF-16 units is enough here. The number is used against the same
 * string that it came from, and `startsWith` compares whole units, so the cut
 * can never fall inside a character.
 */
export const matchedPrefixLength = (hintString: string, digits: string): number =>
  pipe(
    hintString.startsWith(digits),
    Boolean.match({ onFalse: () => 0, onTrue: () => digits.length }),
  );
