import { test } from "vitest";
import { stripNonCode } from "../../build/invariants.ts";
import { assert, assertEquals } from "./support/assert.ts";

test("the bundle scanner can preserve strings while removing comments", () => {
  const source = `
    /** import * as assert from "node:assert" */
    const value = "node:real";
    // import value from "node:comment"
  `;

  const withoutComments = stripNonCode(source, false);
  assert(!withoutComments.includes("node:assert"));
  assert(!withoutComments.includes("node:comment"));
  assert(withoutComments.includes('"node:real"'));

  assertEquals(stripNonCode(source).includes("node:real"), false);
});
