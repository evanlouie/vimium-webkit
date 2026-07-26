/**
 * Omnibar relevancy scoring.
 *
 * The ladder is pinned numerically rather than only by ordering, because the
 * exact values (8/6/4/2/1) are the part that gets "simplified" during a
 * refactor and the part whose loss is invisible until the list is subtly wrong.
 * The other load-bearing behaviour is the zeroing: a query token that matches
 * nothing must eliminate the whole candidate, not merely cost it points.
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  frecencyScore,
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
} from "~/features/omnibar/scoring.ts";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** The raw ladder value, with the title-length normalisation divided back out. */
const ladder = (query: string, title: string): number =>
  scoreText(tokenize(query), title) * Math.log(1 + title.length);

Deno.test("tokenize lowercases and splits on every non-alphanumeric", () => {
  assertEquals(tokenize("GitHub · Build software"), [
    "github",
    "build",
    "software",
  ]);
  assertEquals(tokenize("https://github.com/foo/bar?x=1"), [
    "https",
    "github",
    "com",
    "foo",
    "bar",
    "x",
    "1",
  ]);
  assertEquals(tokenize(""), []);
  assertEquals(tokenize("   -- "), []);
});

Deno.test("tokenize keeps non-ASCII words whole", () => {
  assertEquals(tokenize("Übersicht の設定"), ["übersicht", "の設定"]);
});

Deno.test("scoring ladder: whole word on the first token scores 8", () => {
  assertAlmostEquals(ladder("alpha", "alpha"), WHOLE_WORD_ON_FIRST_TOKEN);
});

Deno.test("scoring ladder: prefix on the first token scores 6", () => {
  assertAlmostEquals(ladder("alp", "alpha"), PREFIX_ON_FIRST_TOKEN);
});

Deno.test("scoring ladder: a whole word later in the title scores 4", () => {
  assertAlmostEquals(ladder("beta", "alpha beta"), WHOLE_WORD);
});

Deno.test("scoring ladder: a prefix later in the title scores 2", () => {
  assertAlmostEquals(ladder("bet", "alpha beta"), PREFIX);
});

Deno.test("scoring ladder: a bare substring scores 1", () => {
  assertAlmostEquals(ladder("eta", "alpha beta"), SUBSTRING);
});

Deno.test("scoring ladder: a first-token prefix outranks a later whole word", () => {
  // 6 > 4 is the whole reason the ladder is not two levels.
  assert(PREFIX_ON_FIRST_TOKEN > WHOLE_WORD);
  assert(ladder("alp", "alpha beta") > ladder("beta", "alpha beta"));
});

Deno.test("scoring ladder: each query token contributes its own best hit", () => {
  assertAlmostEquals(
    ladder("alpha beta", "alpha beta"),
    WHOLE_WORD_ON_FIRST_TOKEN + WHOLE_WORD,
  );
});

Deno.test("a query token that matches nothing zeroes the whole candidate", () => {
  assertEquals(scoreText(tokenize("alpha zulu"), "alpha beta"), 0);
  // Even though `alpha` on its own would have scored the maximum.
  assert(scoreText(tokenize("alpha"), "alpha beta") > 0);
});

Deno.test("an empty query or an empty candidate scores zero", () => {
  assertEquals(scoreText([], "alpha"), 0);
  assertEquals(scoreText(tokenize("alpha"), ""), 0);
  assertEquals(scoreCandidate([], { title: "a", url: "b" }), 0);
});

Deno.test("shorter titles win on an equal ladder score", () => {
  const short = scoreText(tokenize("release"), "Release notes");
  const long = scoreText(
    tokenize("release"),
    "Release notes for every version we have ever published, in full",
  );
  assert(short > long, `short ${short} should beat long ${long}`);
});

Deno.test("the title-length divisor is ln(1 + length)", () => {
  const title = "Release notes";
  assertAlmostEquals(
    scoreText(tokenize("release"), title),
    WHOLE_WORD_ON_FIRST_TOKEN / Math.log(1 + title.length),
    1e-12,
  );
});

Deno.test("a candidate with no title is normalised as if it were long", () => {
  const score = scoreCandidate(tokenize("github"), {
    title: "",
    url: "https://github.com/",
  });
  // `https` is the URL's first token, so `github` is a later whole word: 4.
  assertAlmostEquals(
    score,
    WHOLE_WORD / Math.log(1 + MISSING_TITLE_LENGTH),
    1e-12,
  );
});

Deno.test("a query token may be satisfied by the title or by the URL", () => {
  const score = scoreCandidate(tokenize("github issues"), {
    title: "Issues",
    url: "https://github.com/vimium/vimium/issues",
  });
  assert(score > 0, "a split match across title and URL must not zero out");
});

Deno.test("the URL gets its own first token rather than sharing the title's", () => {
  const withUrlHit = scoreCandidate(tokenize("https"), {
    title: "Anything",
    url: "https://example.com/",
  });
  assertAlmostEquals(
    withUrlHit,
    WHOLE_WORD_ON_FIRST_TOKEN / Math.log(1 + "Anything".length),
    1e-12,
  );
});

Deno.test("recencyScore falls cubically to zero over a month", () => {
  assertAlmostEquals(recencyScore(NOW, NOW), 1);
  assertEquals(recencyScore(NOW - 60 * DAY, NOW), 0);
  const yesterday = recencyScore(NOW - DAY, NOW);
  const lastWeek = recencyScore(NOW - 7 * DAY, NOW);
  assert(yesterday > lastWeek, "yesterday should beat last week");
  assert(lastWeek > 0);
});

Deno.test("recencyScore treats a future timestamp as now", () => {
  // Clock skew across devices is routine and must not produce a negative age.
  assertAlmostEquals(recencyScore(NOW + DAY, NOW), 1);
});

Deno.test("frecencyScore stays within [0, 1] and rewards both axes", () => {
  const cold = frecencyScore({ visitCount: 1, lastVisit: NOW - 25 * DAY }, NOW);
  const hot = frecencyScore({ visitCount: 40, lastVisit: NOW }, NOW);
  assert(cold >= 0 && cold <= 1, `cold ${cold} out of range`);
  assert(hot > cold);
  assertAlmostEquals(hot, 1);
});

Deno.test("historyScore multiplies relevancy rather than replacing it", () => {
  const relevant = historyScore(8, { visitCount: 1, lastVisit: 0 }, NOW);
  const frecentButIrrelevant = historyScore(
    0,
    { visitCount: 100, lastVisit: NOW },
    NOW,
  );
  assertEquals(frecentButIrrelevant, 0);
  assert(relevant > 0);
});

Deno.test("historyScore lets frecency break a tie between equal texts", () => {
  const fresh = historyScore(4, { visitCount: 10, lastVisit: NOW }, NOW);
  const stale = historyScore(
    4,
    { visitCount: 1, lastVisit: NOW - 29 * DAY },
    NOW,
  );
  assert(fresh > stale);
});
