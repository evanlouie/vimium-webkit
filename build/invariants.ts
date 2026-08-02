/**
 * Build-time invariants (IMPLEMENTATION_PLAN.md §9.4).
 *
 * These are checks a reviewer would otherwise have to remember. Each one
 * corresponds to a way this project could quietly stop working on WebKit — a
 * `<style>` element sneaking back in, a `GM_*` call bypassing the capability
 * shim, Stage 0 growing until it costs real time in twenty frames.
 */

import { readdir, readFile } from "node:fs/promises";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import { parseAst } from "rollup/parseAst";

export interface Violation {
  readonly rule: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export interface InvariantInput {
  readonly root: string;
  readonly bundle: string;
  /** The compiled code alone, without the metadata block or the banner. */
  readonly code: string;
  readonly stage0Bytes: number;
  readonly declaredVersion: string;
  readonly metadataBlock: string;
}

/**
 * Stage 0's code cost, **minified**.
 *
 * Measured minified because the budget is about parse and execute work in
 * twenty frames, and an unminified measurement charges the file for its own
 * documentation — which is a budget that punishes exactly the wrong thing. The
 * shipped bundle is not minified, but nothing in it is charged per-frame
 * separately either: the whole ~890 KB IIFE is what an engine sees at
 * `document-start`, and that is the `bundle-budget` line's problem, not this
 * one's.
 *
 * 3 KB against a measured 2.5 KB: enough headroom for a real change, not enough
 * to absorb a rewrite unnoticed.
 */
export const STAGE0_BUDGET_BYTES = 3 * 1024;
/** Headroom under Greasy Fork's 2 MB unminified ceiling. */
export const BUNDLE_BUDGET_BYTES = 1_500 * 1024;

/**
 * Copyright lines that must appear in the shipped artefact.
 *
 * The MIT licence permits redistribution *on condition* that the notice travels
 * with the code. These strings are what `build/metadata.ts` emits; if a
 * dependency is added or removed, this list is where the obligation is
 * recorded.
 */
const BUNDLED_COPYRIGHT_HOLDERS: readonly string[] = [
  "Copyright (c) 2023 Effectful Technologies Inc",
  "Copyright (c) 2010 Phil Crosby, Ilya Sukhar",
];

/**
 * Proof that a bundled dependency is actually *in* the code.
 *
 * The notice check alone could not fail: it scanned the whole artefact, and
 * the artefact is the banner the build had just written plus the code, so the
 * banner satisfied its own check. It would have passed on an empty bundle, and
 * would never have noticed Effect being dropped. These strings come from the
 * dependency itself, so they only appear if it shipped.
 */
const BUNDLED_DEPENDENCY_MARKERS: ReadonlyArray<
  { readonly name: string; readonly marker: string }
> = [
  { name: "effect", marker: "effect/Effect" },
];

/** Files exempt from the "all GM access goes through the shim" rule. */
const GM_SHIM_FILES: ReadonlySet<string> = new Set([
  "src/platform/gm.ts",
  "src/platform/gm-api.ts",
]);

/** The one documented place a `<style>` element may be created. */
const STYLE_ELEMENT_FILES: ReadonlySet<string> = new Set([
  "src/ui/root.ts",
]);

/**
 * Files allowed to name a global that someone else can replace.
 *
 * A page, an extension, or a sandboxing manager can swap `navigator` (or
 * `unsafeWindow`) for an accessor, and an accessor can *throw* where a missing
 * API would merely be `undefined` — which is how a Safari user lost the whole
 * of Stage 1 to a `userAgent` getter. `typeof` and `?.` both perform the read,
 * so neither helps; only a `try` does.
 *
 * Everywhere else goes through `platform/ambient.ts`. The exemptions:
 * `ambient.ts` itself; `boot/stage0.ts`, which may not import anything (§5.2)
 * and so carries its own `try`; `platform/gm.ts`, the manager chokepoint, which
 * probes each binding individually; and `platform/gm-api.ts`, which only
 * `declare`s these names for the type checker and emits nothing.
 */
const AMBIENT_GLOBAL_FILES: ReadonlySet<string> = new Set([
  "src/platform/ambient.ts",
  "src/boot/stage0.ts",
  "src/platform/gm.ts",
  "src/platform/gm-api.ts",
]);

const sourceFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(`${root}/src`, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `${entry.parentPath}/${entry.name}`)
    .sort();
};

/**
 * Blank out comments and string literals, preserving offsets and line breaks.
 *
 * Without this every rule fires on its own documentation: the comment
 * explaining why `<style>` is banned contains the word `createElement("style")`.
 * Replacing rather than deleting keeps reported line numbers accurate.
 */
export const stripNonCode = (source: string): string => {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      blank(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      let cursor = index + 1;
      while (cursor < source.length) {
        const current = source[cursor];
        if (current === "\\") {
          cursor += 2;
          continue;
        }
        if (current === quote) break;
        // An unterminated single- or double-quoted string cannot span lines;
        // bail out so a stray apostrophe in prose cannot swallow the file.
        if (current === "\n" && quote !== "`") break;
        cursor++;
      }
      blank(index, Math.min(cursor + 1, source.length));
      index = cursor + 1;
      continue;
    }

    index++;
  }

  return out.join("");
};

/** True when executable code contains a `node:` string literal. */
export const hasNodeSpecifier = (source: string): boolean => {
  const pending: unknown[] = [parseAst(source)];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      continue;
    }
    seen.add(value);

    const node = value as Record<string, unknown>;
    if (
      node["type"] === "Literal" && typeof node["value"] === "string" &&
      node["value"].startsWith("node:")
    ) {
      return true;
    }
    if (node["type"] === "TemplateElement") {
      const templateValue = node["value"];
      if (
        typeof templateValue === "object" && templateValue !== null &&
        typeof (templateValue as Record<string, unknown>)["raw"] === "string" &&
        ((templateValue as Record<string, unknown>)["raw"] as string)
          .startsWith(
            "node:",
          )
      ) {
        return true;
      }
    }

    pending.push(...Object.values(node));
  }
  return false;
};

const scan = (
  contents: string,
  pattern: RegExp,
): ReadonlyArray<{ line: number; text: string }> => {
  const hits: Array<{ line: number; text: string }> = [];
  const code = stripNonCode(contents).split("\n");
  const original = contents.split("\n");
  for (let index = 0; index < code.length; index++) {
    pattern.lastIndex = 0;
    if (pattern.test(code[index] ?? "")) {
      hits.push({ line: index + 1, text: (original[index] ?? "").trim() });
    }
  }
  return hits;
};

export const checkInvariants = async (
  input: InvariantInput,
): Promise<readonly Violation[]> => {
  const violations: Violation[] = [];
  const files = await sourceFiles(input.root);
  const sources = await Promise.all(
    files.map(async (path) => ({
      rel: relative(input.root, path).replaceAll("\\", "/"),
      contents: await readFile(path, "utf8"),
    })),
  );

  for (const { rel, contents } of sources) {
    // 1. No dynamic code evaluation. Beyond the obvious security argument,
    //    every one of these is blocked outright by a page CSP with
    //    `script-src` restrictions — which is most of the sites that matter.
    for (
      const hit of scan(
        contents,
        /\beval\s*\(|new\s+Function\s*\(|document\s*\.\s*write\s*\(|\bsetTimeout\s*\(\s*["'`]/g,
      )
    ) {
      violations.push({
        rule: "no-dynamic-code",
        file: rel,
        line: hit.line,
        message: `dynamic code evaluation: ${hit.text}`,
      });
    }

    // 2. No `<style>` elements outside the documented Safari <16.4 fallback.
    //    Safari applies the page's `style-src` to content-script-injected nodes,
    //    so a `<style>` here is silently dropped on CSP-hardened sites.
    if (!STYLE_ELEMENT_FILES.has(rel)) {
      for (
        const hit of scan(contents, /createElement\s*\(\s*["'`]style["'`]/g)
      ) {
        violations.push({
          rule: "no-style-element",
          file: rel,
          line: hit.line,
          message:
            `create a constructable stylesheet via ui.addStyle instead: ${hit.text}`,
        });
      }
    }

    // 6. All manager access flows through the capability shim.
    if (!GM_SHIM_FILES.has(rel)) {
      for (const hit of scan(contents, /(?<![\w$.])GM[._][A-Za-z]/g)) {
        violations.push({
          rule: "gm-through-shim",
          file: rel,
          line: hit.line,
          message: `route this through platform/gm.ts: ${hit.text}`,
        });
      }
    }

    // 8. Globals a page or manager can replace are read through one guarded
    //    accessor, never inline. See `AMBIENT_GLOBAL_FILES` for why.
    if (!AMBIENT_GLOBAL_FILES.has(rel)) {
      for (
        const hit of scan(contents, /(?<![\w$.])(navigator|unsafeWindow)\b/g)
      ) {
        violations.push({
          rule: "ambient-globals",
          file: rel,
          line: hit.line,
          message: `read this through platform/ambient.ts: ${hit.text}`,
        });
      }
    }

    // Inline event-handler strings would also be CSP-blocked, and are a common
    // accidental regression when porting DOM code.
    for (
      const hit of scan(contents, /setAttribute\s*\(\s*["'`]on[a-z]+["'`]/g)
    ) {
      violations.push({
        rule: "no-inline-handlers",
        file: rel,
        line: hit.line,
        message: `use addEventListener: ${hit.text}`,
      });
    }

    // 9. No HTML sinks. Three separate modules call this discipline out in
    //    prose as load-bearing — link text, page titles and search suggestions
    //    are all page-supplied and all end up inside our own overlay — and
    //    nothing enforced it. `textContent` on the parts is the only way in.
    for (
      const hit of scan(
        contents,
        /\.(inner|outer)HTML\b|insertAdjacentHTML\s*\(|createContextualFragment\s*\(|\bsrcdoc\s*=/g,
      )
    ) {
      violations.push({
        rule: "no-html-sinks",
        file: rel,
        line: hit.line,
        message: `build nodes and set textContent instead: ${hit.text}`,
      });
    }
  }

  // 3. Stage 0 runs in every frame of every page; growth here is the classic
  //    userscript CPU sink.
  if (input.stage0Bytes > STAGE0_BUDGET_BYTES) {
    violations.push({
      rule: "stage0-budget",
      file: "src/boot/stage0.ts",
      message: `Stage 0 is ${input.stage0Bytes} bytes, over the ` +
        `${STAGE0_BUDGET_BYTES}-byte budget`,
    });
  }

  // 4. Greasy Fork rejects scripts over 2 MB unminified.
  const bundleBytes = new TextEncoder().encode(input.bundle).length;
  if (bundleBytes > BUNDLE_BUDGET_BYTES) {
    violations.push({
      rule: "bundle-budget",
      file: "dist/vimium-webkit.user.js",
      message: `bundle is ${bundleBytes} bytes, over the ` +
        `${BUNDLE_BUDGET_BYTES}-byte budget`,
    });
  }

  // 5. The metadata `@version` is what update checks compare.
  if (!input.metadataBlock.includes(`@version`)) {
    violations.push({
      rule: "version-match",
      file: "build/metadata.ts",
      message: "metadata block has no @version",
    });
  } else if (!input.metadataBlock.includes(input.declaredVersion)) {
    violations.push({
      rule: "version-match",
      file: "build/metadata.ts",
      message:
        `metadata @version does not match package.json (${input.declaredVersion})`,
    });
  }

  // The metadata block must be first in the file, with exactly one space after
  // `//`; ScriptCat rejects anything else.
  if (!input.bundle.startsWith("// ==UserScript==\n")) {
    violations.push({
      rule: "metadata-first",
      file: "dist/vimium-webkit.user.js",
      message: "the metadata block must be the very first thing in the file",
    });
  }

  // 10. Every bundled MIT dependency's copyright notice ships with it.
  //
  //     Scanned in the *bundle*, not the source: the licence obligation is on
  //     the artefact, and every other rule here inspects source only. Roughly
  //     105 KB of third-party code shipped with no notice at all, which is
  //     distribution-blocking for Greasy Fork and a licence violation
  //     regardless of where it is distributed.
  for (const holder of BUNDLED_COPYRIGHT_HOLDERS) {
    if (input.bundle.includes(holder)) continue;
    violations.push({
      rule: "third-party-notices",
      file: "dist/vimium-webkit.user.js",
      message: `the bundle carries no copyright notice for ${holder}`,
    });
  }

  // 11. No Node globals in the artefact.
  //
  //     Rule 8 bans reading a replaceable global inline, because a page or a
  //     sandboxing manager can make the read *throw* rather than answer
  //     `undefined`. It scans `src/` — so when Effect arrived with
  //     `typeof process === "object"` probes for `hrtime` and a TTY, they
  //     walked straight in underneath it. This artefact is one IIFE evaluated
  //     at `document-start`, so a throw there takes the whole extension with
  //     it, Stage 0 included, before a single key is pressed.
  //
  //     The *identifier* is banned, not the member access. An earlier version
  //     of this rule required `process` to be followed by `.` or `[`, which
  //     the `define` substitutions already remove — so it was green whether or
  //     not the rewrite that actually matters had run, and could not fail on
  //     the thing it was added for. `global` keeps the member form, because
  //     this project has its own `global:` keys and `#global` fields.
  //
  //     Scanned in the code with comments and strings blanked, so prose about
  //     an "in-process channel" does not fire it.
  for (
    const hit of scan(
      input.code,
      /(?<![\w$.])(process|Buffer|__dirname|__filename)(?![\w$])|(?<![\w$.])global\s*[.[]|(?<![\w$.])require\s*\(/g,
    )
  ) {
    violations.push({
      rule: "no-node-globals",
      file: "dist/vimium-webkit.user.js",
      line: hit.line,
      message: `the bundle reads a Node global: ${hit.text.slice(0, 80)}`,
    });
  }

  // Parse rather than remove comments with a regular expression. Vite 8 keeps
  // Effect examples such as `import * as assert from "node:assert"` inside
  // documentation comments. A hand-written comment scanner also mistook the
  // escaped `//` in `/https?:\\/\\//` for a line comment and hid the next real
  // string. Rollup already parses this exact generated language.
  if (hasNodeSpecifier(input.code)) {
    violations.push({
      rule: "no-node-globals",
      file: "dist/vimium-webkit.user.js",
      message: "the bundle references a `node:` module specifier",
    });
  }

  // The other half: the notice is only an obligation if the code is there.
  // Checked against the code alone, which the banner is not part of.
  for (const { name, marker } of BUNDLED_DEPENDENCY_MARKERS) {
    if (input.code.includes(marker)) continue;
    violations.push({
      rule: "third-party-notices",
      file: "dist/vimium-webkit.user.js",
      message:
        `the bundle does not appear to contain ${name} (no "${marker}"), so ` +
        "either it was tree-shaken away or this list is out of date",
    });
  }

  violations.push(...(await checkCommandTiers(input.root)));
  return violations;
};

/**
 * 7. Every command carries a tier, and every Tier C command explains itself.
 *
 * Imported and executed rather than pattern-matched, so a command added through
 * any code path is covered.
 */
const checkCommandTiers = async (
  root: string,
): Promise<readonly Violation[]> => {
  const violations: Violation[] = [];
  const module = await import(
    pathToFileURL(`${root}/src/core/commands.ts`).href
  );
  const build: unknown = (module as Record<string, unknown>)["buildCommands"];
  if (typeof build !== "function") {
    return [{
      rule: "command-tiers",
      file: "src/core/commands.ts",
      message: "buildCommands is not exported",
    }];
  }

  const commands: unknown = (build as () => unknown)();
  if (!Array.isArray(commands)) {
    return [{
      rule: "command-tiers",
      file: "src/core/commands.ts",
      message: "buildCommands must return an array",
    }];
  }

  for (const entry of commands) {
    if (typeof entry !== "object" || entry === null) {
      violations.push({
        rule: "command-tiers",
        file: "src/core/commands.ts",
        message: "buildCommands returned a malformed command entry",
      });
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record["name"] === "string"
      ? record["name"]
      : "<unnamed>";
    const tier = record["tier"];

    if (tier !== "A" && tier !== "B" && tier !== "C") {
      violations.push({
        rule: "command-tiers",
        file: "src/core/commands.ts",
        message: `command "${name}" has no valid tier`,
      });
      continue;
    }

    if (tier === "C" && typeof record["unavailableReason"] !== "string") {
      violations.push({
        rule: "command-tiers",
        file: "src/core/commands.ts",
        message:
          `Tier C command "${name}" needs a user-facing unavailableReason`,
      });
    }
  }

  return violations;
};

export const formatViolations = (violations: readonly Violation[]): string =>
  violations
    .map((violation) =>
      `  ${violation.rule}: ${violation.file}` +
      `${
        violation.line === undefined ? "" : `:${violation.line}`
      } — ${violation.message}`
    )
    .join("\n");
