import { test } from "vitest";
import { hasNodeSpecifier, stripNonCode } from "../../build/invariants.ts";
import { assert, assertEquals } from "./support/assert.ts";

test("the bundle scanner ignores module examples inside comments", () => {
  const source = `
    /** import * as assert from "node:assert" */
    const value = "browser";
    // import value from "node:comment"
  `;

  assertEquals(hasNodeSpecifier(source), false);
  assertEquals(stripNonCode(source).includes("node:assert"), false);
});

test("a regular expression cannot hide a Node module specifier", () => {
  const source = String.raw`
    const protocol = /https?:\/\//;
    const dependency = "node:fs";
  `;

  assert(hasNodeSpecifier(source));
});

test("template module specifiers are detected", () => {
  assert(hasNodeSpecifier("const dependency = `node:path`;"));
});
