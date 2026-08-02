/**
 * The relevancy score of the omnibar.
 *
 * The ladder is pinned by its numbers, and not only by its order. The exact
 * values 8, 6, 4, 2 and 1 are the part that a rewrite makes simpler, and the
 * loss is invisible until the list is subtly wrong. The other important
 * behaviour is the zero: a query word that matches nothing must remove the
 * whole candidate, and not only cost it points.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  frecencyScore,
  frequencyScore,
  historyScore,
  MISSING_TITLE_LENGTH,
  PREFIX,
  PREFIX_ON_FIRST_TOKEN,
  recencyScore,
  scoreCandidate,
  scoreText,
  SUBSTRING,
  tokenize,
  WHOLE_WORD,
  WHOLE_WORD_ON_FIRST_TOKEN,
} from "~/domain/Score.ts";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** The raw ladder value, with the title-length division taken back out. */
const ladder = (query: string, title: string): number =>
  scoreText(tokenize(query), title) * Math.log(1 + title.length);

describe("Score", () => {
  it.effect("lowercases and splits on every character that is not a word", () =>
    Effect.sync(() => {
      assert.deepEqual(tokenize("GitHub · Build software"), [
        "github",
        "build",
        "software",
      ]);
      assert.deepEqual(tokenize("https://github.com/foo/bar?x=1"), [
        "https",
        "github",
        "com",
        "foo",
        "bar",
        "x",
        "1",
      ]);
      assert.deepEqual(tokenize(""), []);
      assert.deepEqual(tokenize("   -- "), []);
    }));

  it.effect("keeps a word that is not ASCII whole", () =>
    Effect.sync(() => {
      assert.deepEqual(tokenize("Übersicht の設定"), ["übersicht", "の設定"]);
    }));

  it.effect("scores a whole word on the first token as 8", () =>
    Effect.sync(() => {
      assert.closeTo(ladder("alpha", "alpha"), WHOLE_WORD_ON_FIRST_TOKEN, 1e-9);
    }));

  it.effect("scores a prefix on the first token as 6", () =>
    Effect.sync(() => {
      assert.closeTo(ladder("alp", "alpha"), PREFIX_ON_FIRST_TOKEN, 1e-9);
    }));

  it.effect("scores a whole word later in the title as 4", () =>
    Effect.sync(() => {
      assert.closeTo(ladder("beta", "alpha beta"), WHOLE_WORD, 1e-9);
    }));

  it.effect("scores a prefix later in the title as 2", () =>
    Effect.sync(() => {
      assert.closeTo(ladder("bet", "alpha beta"), PREFIX, 1e-9);
    }));

  it.effect("scores a bare substring as 1", () =>
    Effect.sync(() => {
      assert.closeTo(ladder("eta", "alpha beta"), SUBSTRING, 1e-9);
    }));

  it.effect("puts a first-token prefix above a later whole word", () =>
    Effect.sync(() => {
      // 6 above 4 is the whole reason that the ladder has more than two steps.
      assert.isAbove(PREFIX_ON_FIRST_TOKEN, WHOLE_WORD);
      assert.isAbove(
        ladder("alp", "alpha beta"),
        ladder("beta", "alpha beta"),
      );
    }));

  it.effect("adds the best hit of each query token", () =>
    Effect.sync(() => {
      assert.closeTo(
        ladder("alpha beta", "alpha beta"),
        WHOLE_WORD_ON_FIRST_TOKEN + WHOLE_WORD,
        1e-9,
      );
    }));

  it.effect("zeroes the candidate when one query token matches nothing", () =>
    Effect.sync(() => {
      assert.strictEqual(scoreText(tokenize("alpha zulu"), "alpha beta"), 0);
      // Even though `alpha` alone would have scored the maximum.
      assert.isAbove(scoreText(tokenize("alpha"), "alpha beta"), 0);
    }));

  it.effect("scores zero for an empty query or an empty candidate", () =>
    Effect.sync(() => {
      assert.strictEqual(scoreText([], "alpha"), 0);
      assert.strictEqual(scoreText(tokenize("alpha"), ""), 0);
      assert.strictEqual(scoreCandidate([], { title: "a", url: "b" }), 0);
    }));

  it.effect("lets a shorter title win an equal ladder score", () =>
    Effect.sync(() => {
      const short = scoreText(tokenize("release"), "Release notes");
      const long = scoreText(
        tokenize("release"),
        "Release notes for every version we have ever published, in full",
      );
      assert.isAbove(short, long);
    }));

  it.effect("divides by the natural log of one plus the title length", () =>
    Effect.sync(() => {
      const title = "Release notes";
      assert.closeTo(
        scoreText(tokenize("release"), title),
        WHOLE_WORD_ON_FIRST_TOKEN / Math.log(1 + title.length),
        1e-12,
      );
    }));

  it.effect("normalises a candidate with no title as if it were long", () =>
    Effect.sync(() => {
      const score = scoreCandidate(tokenize("github"), {
        title: "",
        url: "https://github.com/",
      });
      // `https` is the first token of the URL, so `github` is a later whole
      // word, which is 4.
      assert.closeTo(
        score,
        WHOLE_WORD / Math.log(1 + MISSING_TITLE_LENGTH),
        1e-12,
      );
    }));

  it.effect("lets the title or the URL satisfy a query token", () =>
    Effect.sync(() => {
      const score = scoreCandidate(tokenize("github issues"), {
        title: "Issues",
        url: "https://github.com/vimium/vimium/issues",
      });
      assert.isAbove(score, 0);
    }));

  it.effect("gives the URL its own first token", () =>
    Effect.sync(() => {
      const score = scoreCandidate(tokenize("https"), {
        title: "Anything",
        url: "https://example.com/",
      });
      assert.closeTo(
        score,
        WHOLE_WORD_ON_FIRST_TOKEN / Math.log(1 + "Anything".length),
        1e-12,
      );
    }));

  it.effect("falls cubically to zero over one month", () =>
    Effect.sync(() => {
      assert.closeTo(recencyScore(NOW, NOW), 1, 1e-9);
      assert.strictEqual(recencyScore(NOW - 60 * DAY, NOW), 0);
      const yesterday = recencyScore(NOW - DAY, NOW);
      const lastWeek = recencyScore(NOW - 7 * DAY, NOW);
      assert.isAbove(yesterday, lastWeek);
      assert.isAbove(lastWeek, 0);
    }));

  it.effect("treats a timestamp in the future as now", () =>
    Effect.sync(() => {
      // A clock difference between devices is usual, and it must not give a
      // negative age.
      assert.closeTo(recencyScore(NOW + DAY, NOW), 1, 1e-9);
    }));

  it.effect("keeps the frequency score inside zero and one", () =>
    Effect.sync(() => {
      assert.strictEqual(frequencyScore(0), 0);
      assert.strictEqual(frequencyScore(-5), 0);
      assert.closeTo(frequencyScore(1000), 1, 1e-9);
    }));

  it.effect("rewards both axes of frecency", () =>
    Effect.sync(() => {
      const cold = frecencyScore(
        { visitCount: 1, lastVisit: NOW - 25 * DAY },
        NOW,
      );
      const hot = frecencyScore({ visitCount: 40, lastVisit: NOW }, NOW);
      assert.isAtLeast(cold, 0);
      assert.isAtMost(cold, 1);
      assert.isAbove(hot, cold);
      assert.closeTo(hot, 1, 1e-9);
    }));

  it.effect("multiplies the relevancy instead of replacing it", () =>
    Effect.sync(() => {
      const relevant = historyScore(8, { visitCount: 1, lastVisit: 0 }, NOW);
      const frecentButIrrelevant = historyScore(
        0,
        { visitCount: 100, lastVisit: NOW },
        NOW,
      );
      assert.strictEqual(frecentButIrrelevant, 0);
      assert.isAbove(relevant, 0);
    }));

  it.effect("lets frecency break a tie between equal texts", () =>
    Effect.sync(() => {
      const fresh = historyScore(4, { visitCount: 10, lastVisit: NOW }, NOW);
      const stale = historyScore(
        4,
        { visitCount: 1, lastVisit: NOW - 29 * DAY },
        NOW,
      );
      assert.isAbove(fresh, stale);
    }));
});
