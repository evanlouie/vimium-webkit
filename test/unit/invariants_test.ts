/**
 * The build invariants.
 *
 * Each rule stands for a way that this project could stop working on WebKit
 * without a message: a `<style>` element that comes back, a `GM_*` call that
 * goes past the capability gate, a key path that suspends.
 *
 * Every rule below is driven from a string. The source rules run against a
 * small project in a temporary directory, and the artefact rules run against a
 * bundle that the test writes.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, type Scope } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BUNDLE_BUDGET_BYTES,
  checkInvariants,
  formatViolations,
  hasNodeSpecifier,
  type InvariantInput,
  stripNonCode,
  type Violation,
} from "../../build/invariants.ts";

/** A catalogue that satisfies the command-tier rule. */
const CLEAN_CATALOGUE = `
export const COMMANDS = {
  demo: {
    name: "demo",
    description: "A demonstration",
    tier: "A",
    group: "misc",
  },
  gone: {
    name: "gone",
    description: "Not possible here",
    tier: "C",
    group: "tabs",
    unavailableReason: "a userscript has no tab-management API",
  },
} as const;
`;

const METADATA = [
  "// ==UserScript==",
  "// @name Vimium-WebKit",
  "// @version 0.1.1",
  "// ==/UserScript==",
  "",
].join("\n");

const NOTICES = [
  "// Copyright (c) 2023 Effectful Technologies Inc",
  "// Copyright (c) 2010 Phil Crosby, Ilya Sukhar",
  "",
].join("\n");

const CLEAN_CODE = `const marker = "effect/Effect";\nconst value = 1;\n`;

/** A project on disk. The scope removes it. */
const project = (
  files: Readonly<Record<string, string>>,
): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const root = await mkdtemp(join(tmpdir(), "vimium-invariants-"));
      await Promise.all(
        Object.entries(files).map(async ([relative, contents]) => {
          const path = join(root, relative);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, contents, "utf8");
        }),
      );
      return root;
    }),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );

const check = (
  files: Readonly<Record<string, string>>,
  overrides: Partial<Omit<InvariantInput, "root">> = {},
): Effect.Effect<readonly Violation[], never, Scope.Scope> =>
  Effect.gen(function*() {
    const root = yield* project({
      "src/domain/Command.ts": CLEAN_CATALOGUE,
      ...files,
    });
    const code = overrides.code ?? CLEAN_CODE;
    const metadataBlock = overrides.metadataBlock ?? METADATA;
    return yield* Effect.promise(() =>
      checkInvariants({
        root,
        code,
        metadataBlock,
        bundle: overrides.bundle ?? `${metadataBlock}${NOTICES}${code}`,
        declaredVersion: overrides.declaredVersion ?? "0.1.1",
      })
    );
  });

const rulesOf = (violations: readonly Violation[]): readonly string[] =>
  violations.map((violation) => violation.rule);

describe("invariants", () => {
  it.effect("blanks a comment and a string, and keeps the offsets", () =>
    Effect.sync(() => {
      const source = [
        '/** createElement("style") in prose */',
        'const value = "node:assert";',
        '// createElement("style") in a line comment',
      ].join("\n");
      const stripped = stripNonCode(source);

      assert.notInclude(stripped, "style");
      assert.notInclude(stripped, "node:assert");
      assert.strictEqual(stripped.length, source.length);
      assert.lengthOf(stripped.split("\n"), 3);
    }));

  it.effect("does not let a stray apostrophe swallow the file", () =>
    Effect.sync(() => {
      // An unterminated quote that is not a template cannot cross a line.
      const source = "const a = 'it's prose\nconst dependency = \"kept\";";
      const stripped = stripNonCode(source);
      assert.include(stripped, "const dependency");
    }));

  it.effect("ignores a module example inside a comment", () =>
    Effect.sync(() => {
      const source = [
        '    /** import * as assert from "node:assert" */',
        '    const value = "browser";',
        '    // import value from "node:comment"',
      ].join("\n");

      assert.isFalse(hasNodeSpecifier(source));
      assert.notInclude(stripNonCode(source), "node:assert");
    }));

  it.effect("is not fooled by a regular expression", () =>
    Effect.sync(() => {
      const source = [
        "const protocol = /https?:\\/\\//;",
        'const dependency = "node:fs";',
      ].join("\n");
      assert.isTrue(hasNodeSpecifier(source));
    }));

  it.effect("finds a module specifier inside a template", () =>
    Effect.sync(() => {
      assert.isTrue(hasNodeSpecifier("const dependency = `node:path`;"));
      assert.isFalse(hasNodeSpecifier("const dependency = `browser`;"));
    }));

  it.effect("gives no violation for a clean project", () =>
    Effect.gen(function*() {
      const violations = yield* check({
        "src/ui/Ui.ts": "const sheet = new CSSStyleSheet();\n",
      });
      assert.deepEqual(
        violations,
        [],
        `unexpected violations:\n${formatViolations(violations)}`,
      );
    }));

  it.effect("refuses dynamic code evaluation", () =>
    Effect.gen(function*() {
      const violations = yield* check({
        "src/features/Bad.ts": [
          "// eval( in a comment must not fire",
          "const run = (source) => eval(source);",
        ].join("\n"),
      });
      assert.deepEqual(rulesOf(violations), ["no-dynamic-code"]);
      assert.strictEqual(violations[0]?.line, 2);
    }));

  it.effect("refuses a `<style>` element outside the documented file", () =>
    Effect.gen(function*() {
      const source = 'const node = document.createElement("style");\n';
      const banned = yield* check({ "src/features/Bad.ts": source });
      assert.deepEqual(rulesOf(banned), ["no-style-element"]);

      // The one documented place may still do it.
      const allowed = yield* check({ "src/ui/Ui.ts": source });
      assert.deepEqual(rulesOf(allowed), []);
    }));

  it.effect("sends every manager call through the capability gate", () =>
    Effect.gen(function*() {
      const source = 'const value = GM_getValue("key");\n';
      const banned = yield* check({ "src/features/Bad.ts": source });
      assert.deepEqual(rulesOf(banned), ["gm-through-shim"]);

      const allowed = yield* check({ "src/platform/Gm.ts": source });
      assert.deepEqual(rulesOf(allowed), []);
    }));

  it.effect("reads a replaceable global through one guarded probe", () =>
    Effect.gen(function*() {
      // A page or a manager can exchange `navigator` for an accessor, and an
      // accessor can throw where an absent API only gives `undefined`.
      const source = "const agent = navigator.userAgent;\n";
      const banned = yield* check({ "src/features/Bad.ts": source });
      assert.deepEqual(rulesOf(banned), ["ambient-globals"]);

      const allowed = yield* check({ "src/platform/Dom.ts": source });
      assert.deepEqual(rulesOf(allowed), []);
    }));

  it.effect("keeps the key path free of anything that suspends", () =>
    Effect.gen(function*() {
      // `preventDefault` works only during synchronous dispatch, and a fiber
      // yield becomes a macrotask on Safari.
      const source = "const wait = Effect.sleep(10);\n";
      const banned = yield* check({ "src/core/Keyboard.ts": source });
      assert.deepEqual(rulesOf(banned), ["synchronous-key-path"]);

      const allowed = yield* check({ "src/features/Slow.ts": source });
      assert.deepEqual(rulesOf(allowed), []);
    }));

  it.effect("refuses an inline event-handler attribute", () =>
    Effect.gen(function*() {
      const violations = yield* check({
        "src/ui/Bad.ts": 'node.setAttribute("onclick", "go()");\n',
      });
      assert.deepEqual(rulesOf(violations), ["no-inline-handlers"]);
    }));

  it.effect("refuses every HTML sink", () =>
    Effect.gen(function*() {
      // Link text, page titles and search suggestions all come from the page
      // and all end inside our own overlay.
      const violations = yield* check({
        "src/ui/Bad.ts": [
          "node.innerHTML = text;",
          'node.insertAdjacentHTML("beforeend", text);',
        ].join("\n"),
      });
      assert.deepEqual(rulesOf(violations), ["no-html-sinks", "no-html-sinks"]);
    }));

  it.effect("refuses a Node global in the artefact", () =>
    Effect.gen(function*() {
      const violations = yield* check({}, {
        code: `${CLEAN_CODE}const home = process.env.HOME;\n`,
      });
      assert.deepEqual(rulesOf(violations), ["no-node-globals"]);
    }));

  it.effect("refuses a `node:` module specifier in the artefact", () =>
    Effect.gen(function*() {
      const violations = yield* check({}, {
        code: `${CLEAN_CODE}const fs = "node:fs";\n`,
      });
      assert.deepEqual(rulesOf(violations), ["no-node-globals"]);
    }));

  it.effect("demands the metadata block first, with the declared version", () =>
    Effect.gen(function*() {
      const late = yield* check({}, {
        bundle: `${CLEAN_CODE}${METADATA}${NOTICES}`,
      });
      assert.include(rulesOf(late), "metadata-first");

      const mismatched = yield* check({}, { declaredVersion: "9.9.9" });
      assert.deepEqual(rulesOf(mismatched), ["version-match"]);

      const withoutVersion = yield* check({}, {
        metadataBlock: "// ==UserScript==\n// ==/UserScript==\n",
        bundle:
          `// ==UserScript==\n// ==/UserScript==\n${NOTICES}${CLEAN_CODE}`,
      });
      assert.deepEqual(rulesOf(withoutVersion), ["version-match"]);
    }));

  it.effect("demands the notice of every bundled dependency", () =>
    Effect.gen(function*() {
      const withoutNotices = yield* check({}, {
        bundle: `${METADATA}${CLEAN_CODE}`,
      });
      assert.deepEqual(rulesOf(withoutNotices), [
        "third-party-notices",
        "third-party-notices",
      ]);

      // The other half: the notice is an obligation only when the code is
      // there.
      const withoutDependency = yield* check({}, {
        code: "const value = 1;\n",
        bundle: `${METADATA}${NOTICES}const value = 1;\n`,
      });
      assert.deepEqual(rulesOf(withoutDependency), ["third-party-notices"]);
    }));

  it.effect("keeps the bundle under the budget of Greasy Fork", () =>
    Effect.gen(function*() {
      const oversized = `${METADATA}${NOTICES}${CLEAN_CODE}${
        "// pad\n".repeat(Math.ceil(BUNDLE_BUDGET_BYTES / 7) + 1)
      }`;
      const violations = yield* check({}, { bundle: oversized });
      assert.deepEqual(rulesOf(violations), ["bundle-budget"]);
    }));

  it.effect("demands a valid tier and a reason for every command", () =>
    Effect.gen(function*() {
      const violations = yield* check({
        "src/domain/Command.ts": `
export const COMMANDS = {
  noTier: { name: "noTier", description: "x", group: "misc" },
  noReason: { name: "noReason", description: "x", tier: "C", group: "tabs" },
  wrongKey: { name: "other", description: "x", tier: "A", group: "misc" },
} as const;
`,
      });
      assert.deepEqual(rulesOf(violations), [
        "command-tiers",
        "command-tiers",
        "command-tiers",
      ]);
    }));

  it.effect("formats a violation with its file and its line", () =>
    Effect.sync(() => {
      const text = formatViolations([
        { rule: "demo", file: "src/a.ts", line: 7, message: "a message" },
        { rule: "demo", file: "src/b.ts", message: "no line" },
      ]);
      assert.include(text, "src/a.ts:7");
      assert.include(text, "src/b.ts —");
    }));
});
