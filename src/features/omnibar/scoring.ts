/**
 * Omnibar relevancy scoring.
 *
 * Ported from Vimium's `background_scripts/completion.js` (`RankingUtils`,
 * `HistoryCompleter`, MIT) and reshaped to the ladder in
 * IMPLEMENTATION_PLAN.md §6.7.
 *
 * Pure and self-contained on purpose: this runs on every keystroke over every
 * candidate from every source, and it is the part of the omnibar whose
 * behaviour is easiest to break without noticing.
 */

/**
 * The relevancy ladder.
 *
 * "First token" means the *candidate's* first word, not the query's. Titles and
 * hostnames lead with their most identifying word — `GitHub · Where the world
 * builds software`, `github.com` — so a hit there is worth strictly more than
 * the same hit in the tail, and the ladder is ordered so that a first-token
 * prefix (6) still beats a mid-string whole word (4).
 */
export const WHOLE_WORD_ON_FIRST_TOKEN = 8;
export const PREFIX_ON_FIRST_TOKEN = 6;
export const WHOLE_WORD = 4;
export const PREFIX = 2;
export const SUBSTRING = 1;

/**
 * Length used when a candidate has no title.
 *
 * Upstream's `titleLength || 100` idiom: a missing title must not win by
 * dividing by `ln(1)` — which is zero — so it is treated as a long one.
 */
export const MISSING_TITLE_LENGTH = 100;

/**
 * Words are runs of letters and digits.
 *
 * URLs have to tokenise the same way as titles or `github.com/foo` would never
 * match the query `foo`, hence splitting on every non-alphanumeric rather than
 * on whitespace. Unicode-aware because titles routinely are not ASCII.
 */
const NON_WORD = /[^\p{L}\p{N}]+/gu;

export const tokenize = (text: string): readonly string[] => {
  const lowered = text.toLowerCase().trim();
  if (lowered.length === 0) return [];
  return lowered.split(NON_WORD).filter((word) => word.length > 0);
};

/** The best score `token` achieves against any single word of `words`. */
const bestTokenScore = (
  token: string,
  words: readonly string[],
): number => {
  let best = 0;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === undefined) continue;
    const first = index === 0;

    let score = 0;
    if (word === token) score = first ? WHOLE_WORD_ON_FIRST_TOKEN : WHOLE_WORD;
    else if (word.startsWith(token)) {
      score = first ? PREFIX_ON_FIRST_TOKEN : PREFIX;
    } else if (word.includes(token)) score = SUBSTRING;

    if (score > best) best = score;
    if (best === WHOLE_WORD_ON_FIRST_TOKEN) break;
  }
  return best;
};

export interface ScoreTarget {
  readonly title: string;
  readonly url: string;
}

/**
 * Score a candidate against the tokenised query.
 *
 * The title and the URL are scored as *separate* groups so that each has its
 * own "first token", but a query token may satisfy itself from either — typing
 * `github issues` should match a page whose title says "Issues" and whose host
 * says "github", which scoring one concatenated string could not express
 * without also handing the URL a bogus first-token bonus.
 *
 * @returns `0` when any query token matches nothing at all. That zeroing is the
 * load-bearing behaviour: the omnibar is a filter first and a ranking second.
 */
export const scoreCandidate = (
  queryTokens: readonly string[],
  target: ScoreTarget,
): number => {
  if (queryTokens.length === 0) return 0;

  const groups = [tokenize(target.title), tokenize(target.url)];
  if (groups.every((words) => words.length === 0)) return 0;

  let total = 0;
  for (const token of queryTokens) {
    let best = 0;
    for (const words of groups) {
      const score = bestTokenScore(token, words);
      if (score > best) best = score;
    }
    if (best === 0) return 0;
    total += best;
  }

  // Shorter titles win: between two pages that both contain the query, the one
  // that is *mostly* the query is nearly always the one meant.
  return total / Math.log(1 + (target.title.length || MISSING_TITLE_LENGTH));
};

/** Score a single string, for candidates that have no URL (commands, engines). */
export const scoreText = (
  queryTokens: readonly string[],
  text: string,
): number => scoreCandidate(queryTokens, { title: text, url: "" });

// ---------------------------------------------------------------------------
// Frecency
// ---------------------------------------------------------------------------

const ONE_MONTH_MS = 1000 * 60 * 60 * 24 * 30;

/**
 * Recency as a `[0, 1]` cubic falloff over one month.
 *
 * Ported verbatim in shape from Vimium's `HistoryCompleter.recencyScore` (MIT).
 * Cubed rather than linear because the useful signal is concentrated in the
 * last day or two; a linear ramp leaves three-week-old pages competitive with
 * this morning's.
 */
export const recencyScore = (lastVisit: number, now: number): number => {
  const age = Math.max(0, now - lastVisit);
  const freshness = Math.max(0, ONE_MONTH_MS - age) / ONE_MONTH_MS;
  return freshness * freshness * freshness;
};

/** Visit counts above this add nothing; keeps a single obsessive tab from pinning the list. */
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
 * Frequency and recency, evenly weighted, in `[0, 1]`.
 *
 * Used as a *multiplier* on the text relevancy rather than as an additive term,
 * so that a frequently-visited page can never outrank a page the query actually
 * describes better.
 */
export const frecencyScore = (visit: FrecencyInput, now: number): number =>
  0.5 * frequencyScore(visit.visitCount) +
  0.5 * recencyScore(visit.lastVisit, now);

/** How much frecency may amplify a history candidate's text relevancy. */
export const FRECENCY_WEIGHT = 1;

export const historyScore = (
  relevancy: number,
  visit: FrecencyInput,
  now: number,
): number => relevancy * (1 + FRECENCY_WEIGHT * frecencyScore(visit, now));
