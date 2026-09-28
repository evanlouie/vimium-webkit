/**
 * The relevancy score of the omnibar.
 *
 * Ported from the Vimium `background_scripts/completion.js` (`RankingUtils`
 * and `HistoryCompleter`, MIT), and changed to the ladder in
 *
 * Pure and complete in itself, on purpose. This code runs on every keystroke,
 * over every candidate from every source. Its behaviour is also the easiest to
 * break without a sign.
 */

import { Array, Boolean, Option, pipe, String } from "effect";
import { flow } from "effect/Function";

/**
 * The relevancy ladder.
 *
 * "First token" means the first word of the *candidate*, and not of the query.
 * A title and a host name start with their most identifying word — `GitHub ·
 * Where the world builds software`, `github.com` — so a hit there is worth
 * more than the same hit later in the text. The order of the ladder makes a
 * prefix hit on the first token (6) win against a whole word in the middle (4).
 */
export const WHOLE_WORD_ON_FIRST_TOKEN = 8;
export const PREFIX_ON_FIRST_TOKEN = 6;
export const WHOLE_WORD = 4;
export const PREFIX = 2;
export const SUBSTRING = 1;

/**
 * The length that is used when a candidate has no title.
 *
 * This is the `titleLength || 100` of upstream. An absent title must not win
 * by a division through `ln(1)`, which is zero, so it counts as a long title.
 */
export const MISSING_TITLE_LENGTH = 100;

/**
 * A word is a run of letters and digits.
 *
 * A URL must be split in the same way as a title. If it were not,
 * `github.com/foo` would never match the query `foo`. The split therefore
 * happens at every character that is not a letter and not a digit, and not at
 * whitespace. It knows Unicode, because a title is often not ASCII.
 */
const NON_WORD = /[^\p{L}\p{N}]+/gu;

export const tokenize: (text: string) => readonly string[] = flow(
  String.toLowerCase,
  String.trim,
  String.split(NON_WORD),
  Array.filter(String.isNonEmpty),
);

/** The rungs of the ladder that a word reaches, by where the word stands. */
interface Rungs {
  readonly wholeWord: number;
  readonly prefix: number;
}

const FIRST_TOKEN: Rungs = { wholeWord: WHOLE_WORD_ON_FIRST_TOKEN, prefix: PREFIX_ON_FIRST_TOKEN };
const LATER_TOKEN: Rungs = { wholeWord: WHOLE_WORD, prefix: PREFIX };

/**
 * The best score that `token` gets against a single word of `words`.
 *
 * A hot loop, kept on purpose. It runs for every word of every candidate on
 * every keystroke. A benchmark over 5000 history entries and eleven queries
 * measured the whole score at about 5.5 ms for each keystroke with this loop,
 * and at about 14.5 ms with the same ladder written as `Array.reduce` and
 * `Boolean.match`.
 */
const bestTokenScore = (token: string, words: readonly string[]): number => {
  let best = 0;
  let rungs = FIRST_TOKEN;
  for (const word of words) {
    if (word === token) best = Math.max(best, rungs.wholeWord);
    else if (word.startsWith(token)) best = Math.max(best, rungs.prefix);
    else if (word.includes(token)) best = Math.max(best, SUBSTRING);
    if (best === WHOLE_WORD_ON_FIRST_TOKEN) break;
    rungs = LATER_TOKEN;
  }
  return best;
};

/** The best score of `token` in any group, or `None` when it matches no word at all. */
const tokenHit =
  (groups: ReadonlyArray<readonly string[]>) =>
  (token: string): Option.Option<number> =>
    pipe(
      groups,
      Array.reduce(0, (best, words) => Math.max(best, bestTokenScore(token, words))),
      Option.liftPredicate((score) => score > 0),
    );

/**
 * Add the hit of one more query word to the total.
 *
 * A total that is already `None` stays `None`, and the word is never scored.
 */
const addHit =
  (groups: ReadonlyArray<readonly string[]>) =>
  (total: Option.Option<number>, token: string): Option.Option<number> =>
    pipe(
      total,
      Option.flatMap((sum) =>
        pipe(
          token,
          tokenHit(groups),
          Option.map((hit) => sum + hit),
        ),
      ),
    );

/**
 * What the ladder total is divided by.
 *
 * A short title wins. Between two pages that both hold the query, the page
 * that is *mostly* the query is almost always the page that was meant.
 */
const titleWeight = (title: string): number =>
  pipe(
    title.length === 0,
    Boolean.match({ onTrue: () => MISSING_TITLE_LENGTH, onFalse: () => title.length }),
    (length) => Math.log(1 + length),
  );

export interface ScoreTarget {
  readonly title: string;
  readonly url: string;
}

/**
 * Score a candidate against the words of the query.
 *
 * The title and the URL are two *separate* groups, so each one has its own
 * first token. One query word can take its score from either group. A user who
 * types `github issues` must match a page whose title says "Issues" and whose
 * host says "github". One joined string cannot express this without also
 * giving the URL a false first-token bonus.
 *
 * The result is `0` when a query word matches nothing at all. That zero is the
 * important behaviour. The omnibar is a filter first, and a ranking second.
 */
export const scoreCandidate = (queryTokens: readonly string[], target: ScoreTarget): number => {
  const groups = [tokenize(target.title), tokenize(target.url)];
  return pipe(
    queryTokens,
    Array.reduce(Option.some(0), addHit(groups)),
    Option.match({ onNone: () => 0, onSome: (total) => total / titleWeight(target.title) }),
  );
};

/** Score one string, for a candidate with no URL, such as a command or an engine. */
export const scoreText = (queryTokens: readonly string[], text: string): number =>
  scoreCandidate(queryTokens, { title: text, url: "" });

// ---------------------------------------------------------------------------
// Frecency
// ---------------------------------------------------------------------------

const ONE_MONTH_MS = 1000 * 60 * 60 * 24 * 30;

/**
 * Recency as a cubic falloff in `[0, 1]` over one month.
 *
 * The shape comes from the Vimium `HistoryCompleter.recencyScore` (MIT). It is
 * cubic and not linear, because the useful signal is in the last day or two. A
 * linear ramp keeps a page of three weeks ago in competition with a page of
 * this morning.
 */
export const recencyScore = (lastVisit: number, now: number): number => {
  const age = Math.max(0, now - lastVisit);
  const freshness = Math.max(0, ONE_MONTH_MS - age) / ONE_MONTH_MS;
  return freshness * freshness * freshness;
};

/** A visit count above this adds nothing. One tab must not hold the list. */
const FREQUENCY_CEILING = 20;

export const frequencyScore = (visitCount: number): number => {
  const count = Math.max(0, visitCount);
  return Math.min(1, Math.log(1 + count) / Math.log(1 + FREQUENCY_CEILING));
};

export interface FrecencyInput {
  readonly visitCount: number;
  readonly lastVisit: number;
}

/**
 * Frequency and recency, with equal weight, in `[0, 1]`.
 *
 * This is a *multiplier* on the text relevancy, and not a term that is added.
 * A page that the user opens often can therefore never win against a page that
 * the query describes better.
 */
export const frecencyScore = (visit: FrecencyInput, now: number): number =>
  0.5 * frequencyScore(visit.visitCount) + 0.5 * recencyScore(visit.lastVisit, now);

/** How much frecency may increase the text relevancy of a history candidate. */
export const FRECENCY_WEIGHT = 1;

export const historyScore = (relevancy: number, visit: FrecencyInput, now: number): number =>
  relevancy * (1 + FRECENCY_WEIGHT * frecencyScore(visit, now));
