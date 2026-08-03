/**
 * The marks that the settings dialog puts under the exclusion rules.
 *
 * A rule that gives no matcher is dropped, and the page then stops being
 * excluded. Before this test the drop was silent, and a user saw an active
 * script on a site that they had turned off. The dialog is where the rule is
 * written, so the dialog is where the mark belongs.
 *
 * The function under test is pure, so the whole table lives in one place.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { exclusionProblems } from "~/ui/Dialog.ts";

describe("the exclusion marks of the settings dialog", () => {
  it.effect("marks the line of every rule that is dropped", () =>
    Effect.sync(() => {
      const text = [
        "# a comment",
        "https://example.com/*",
        "/(a+)+$/ jk",
        "",
        "/[unclosed/",
      ].join("\n");

      const problems = exclusionProblems(text);
      assert.strictEqual(problems.length, 2);
      assert.include(problems[0] ?? "", "line 3");
      assert.include(problems[0] ?? "", "/(a+)+$/");
      assert.include(problems[0] ?? "", "can hang the page");
      assert.include(problems[1] ?? "", "line 5");
    }));

  it.effect("says nothing about the rules that a user writes", () =>
    Effect.sync(() => {
      const text = [
        "https://example.com/*",
        "https://*.example.com/*  jk",
        "/^https?://([a-z0-9-]+\\.)*example\\.com/.*$/",
        "**",
      ].join("\n");

      assert.deepEqual(exclusionProblems(text), []);
    }));
});
