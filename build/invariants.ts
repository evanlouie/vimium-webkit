/**
 * Build-time invariants.
 *
 * These are checks a reviewer would otherwise have to remember. Each one
 * corresponds to a way this project could quietly stop working on WebKit — a
 * `<style>` element sneaking back in, a `GM_*` call bypassing the capability
 * gate, or a key decision that suspends and therefore arrives too late.
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
  readonly declaredVersion: string;
  readonly metadataBlock: string;
}

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

/** Files exempt from the "all manager access goes through the gate" rule. */
const GM_SHIM_FILES: ReadonlySet<string> = new Set([
  "src/platform/Gm.ts",
  "src/platform/GmApi.ts",
]);

/** The one documented place where a `<style>` element may be made. */
const STYLE_ELEMENT_FILES: ReadonlySet<string> = new Set([
  "src/ui/Ui.ts",
]);

/**
 * The files that may name a global that somebody else can replace.
 *
 * A page, an extension or a sandboxing manager can exchange `navigator` or
 * `unsafeWindow` for an accessor, and an accessor can *throw* where an absent
 * API only gives `undefined`. One Safari user lost the whole application to a
 * `userAgent` getter. A `typeof` guard does the read, and `?.` does the read, so
 * neither helps. Only a `try` does.
 *
 * Every other file goes through `Dom.probe` or `Dom.probeOr`. The files below
 * are the ones that implement those probes: `Dom.ts` itself, `Gm.ts`, which is
 * the manager gate and probes each binding on its own, `GmApi.ts`, which only
 * declares the names for the type checker, and the two services that must read
 * `navigator` inside their own guard.
 */
const AMBIENT_GLOBAL_FILES: ReadonlySet<string> = new Set([
  "src/platform/Dom.ts",
  "src/platform/Gm.ts",
  "src/platform/GmApi.ts",
  "src/platform/Capabilities.ts",
  "src/platform/Clipboard.ts",
]);

/**
 * The modules that a `keydown` listener reaches, and that must not suspend.
 *
 * `preventDefault` works only during synchronous dispatch, and Safari has no
 * `setImmediate`, so a fiber yield becomes a macrotask. The browser has already
 * scrolled by the time a decision that yields arrives.
 *
 * A command body is not on this list. `core/Keyboard.ts` starts one with
 * `Effect.forkDetach({ startImmediately: true })`, so it runs on this stack
 * until it suspends, and then continues on its own.
 *
 * Read `ARCHITECTURE.md` section 3.
 */
const SYNCHRONOUS_KEY_PATH: ReadonlySet<string> = new Set([
  "src/core/HandlerStack.ts",
  "src/core/Keyboard.ts",
  "src/core/Modes.ts",
  "src/boot/KeyBridge.ts",
]);

/** The combinators that suspend. None of them may be on the key path. */
const SUSPENDING_COMBINATORS =
  /Effect\s*\.\s*(sleep|promise|tryPromise|async|callback|timeout)\b/g;

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
 * Blank comments and string literals, and keep the offsets and the newlines.
 *
 * Without this every rule fires on its own documentation: the comment that
 * explains why `<style>` is banned holds the word `createElement("style")`.
 * A replacement, and not a deletion, keeps every reported line number correct.
 */
export const stripNonCode = (source: string): string => strip(source, true);

/**
 * Blank the comments, and keep the string literals.
 *
 * Three rules match on the *content* of a string literal:
 * `createElement("style")`, `setAttribute("onclick", …)` and
 * `setTimeout("…")`. `stripNonCode` blanks that content, so those rules could
 * never fire. They read this instead.
 *
 * The walk still tracks a string, because the `//` inside `"https://x"` is not
 * the start of a comment. A scanner that looks only for `//` hides the rest of
 * the line.
 */
export const stripComments = (source: string): string => strip(source, false);

const strip = (source: string, blankStrings: boolean): string => {
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
      if (blankStrings) blank(index, Math.min(cursor + 1, source.length));
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
  options: { readonly keepStrings?: boolean } = {},
): ReadonlyArray<{ line: number; text: string }> => {
  const hits: Array<{ line: number; text: string }> = [];
  const code = (options.keepStrings === true
    ? stripComments(contents)
    : stripNonCode(contents)).split("\n");
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
        { keepStrings: true },
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
        const hit of scan(contents, /createElement\s*\(\s*["'`]style["'`]/g, {
          keepStrings: true,
        })
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

    // 8. A global that a page or a manager can replace is read through one
    //    guarded probe, and never inline. See `AMBIENT_GLOBAL_FILES`.
    if (!AMBIENT_GLOBAL_FILES.has(rel)) {
      for (
        const hit of scan(contents, /(?<![\w$.])(navigator|unsafeWindow)\b/g)
      ) {
        violations.push({
          rule: "ambient-globals",
          file: rel,
          line: hit.line,
          message: `read this through Dom.probe: ${hit.text}`,
        });
      }
    }

    // 12. The key path must not suspend.
    //
    //     `preventDefault` works only during synchronous dispatch, and a fiber
    //     yield becomes a macrotask on Safari. A decision that arrives after
    //     the browser has scrolled is not a decision.
    if (SYNCHRONOUS_KEY_PATH.has(rel)) {
      for (const hit of scan(contents, SUSPENDING_COMBINATORS)) {
        violations.push({
          rule: "synchronous-key-path",
          file: rel,
          line: hit.line,
          message:
            `this suspends, and a keydown listener reaches this file: ${hit.text}`,
        });
      }
    }

    // Inline event-handler strings would also be CSP-blocked, and are a common
    // accidental regression when porting DOM code.
    for (
      const hit of scan(contents, /setAttribute\s*\(\s*["'`]on[a-z]+["'`]/g, {
        keepStrings: true,
      })
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
  //     it, before a single key is pressed.
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
  violations.push(...(await checkCommandBodies(input.root, sources)));
  return violations;
};

/**
 * 13. Every tier A and tier B command has somewhere that can run it.
 *
 * The catalogue and the bodies are deliberately apart: the catalogue is pure
 * data, and a feature layer writes the bodies into the registry. That split is
 * what keeps the layer graph a tree, and it is also what lets a command be
 * carried over with no body at all. Twenty-one of them were, and each one
 * answered "unavailable" to the user instead of working.
 *
 * A tier C command has no body on purpose. `Commands.run` answers with its
 * `unavailableReason`.
 */
const checkCommandBodies = async (
  root: string,
  sources: ReadonlyArray<{ readonly rel: string; readonly contents: string }>,
): Promise<readonly Violation[]> => {
  const file = "src/domain/Command.ts";
  const module = await import(pathToFileURL(`${root}/${file}`).href);
  const catalogue: unknown = (module as Record<string, unknown>)["COMMANDS"];
  if (typeof catalogue !== "object" || catalogue === null) return [];

  // A body is registered either by name, `register("goBack", …)`, or as a key
  // of the record that `registerAll({ goBack: … })` takes.
  const registered = new Set<string>();
  for (const { rel, contents } of sources) {
    if (rel === file) continue;
    // Comments go, and string literals stay. A quoted key is the only way to
    // write a command name that has a dot in it, and `stripNonCode` blanks the
    // content of a string literal, so it would erase exactly those names.
    const code = stripComments(contents);
    for (const match of code.matchAll(/register\(\s*"([^"]+)"/g)) {
      const name = match[1];
      if (name !== undefined) registered.add(name);
    }
    for (
      const match of code.matchAll(
        /(?:^|[\s{,])"?([A-Za-z][\w.-]*)"?\s*:\s*(?:\(|function|Effect|[A-Za-z_$][\w$]*\s*\()/g,
      )
    ) {
      const name = match[1];
      if (name !== undefined) registered.add(name);
    }
  }

  const violations: Violation[] = [];
  for (const [name, entry] of Object.entries(catalogue)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const tier = record["tier"];
    // A malformed entry is the business of `command-tiers`. Two rules that
    // report the same fault make the output harder to read, and neither of
    // them more true.
    if (tier !== "A" && tier !== "B") continue;
    if (record["name"] !== name) continue;
    if (registered.has(name)) continue;
    violations.push({
      rule: "command-bodies",
      file,
      message:
        `no file under src/ registers a body for the tier ${String(tier)} ` +
        `command "${name}", so it answers "unavailable" to the user`,
    });
  }
  return violations;
};

/**
 * 7. Every command carries a tier, and every tier C command explains itself.
 *
 * The catalogue is imported and read, and not matched with a pattern, so a
 * command that arrives by any route is covered.
 */
const checkCommandTiers = async (
  root: string,
): Promise<readonly Violation[]> => {
  const file = "src/domain/Command.ts";
  const violations: Violation[] = [];
  const module = await import(pathToFileURL(`${root}/${file}`).href);
  const catalogue: unknown = (module as Record<string, unknown>)["COMMANDS"];

  if (typeof catalogue !== "object" || catalogue === null) {
    return [{
      rule: "command-tiers",
      file,
      message: "COMMANDS is not exported",
    }];
  }

  for (const [key, entry] of Object.entries(catalogue)) {
    if (typeof entry !== "object" || entry === null) {
      violations.push({
        rule: "command-tiers",
        file,
        message: `the catalogue entry for "${key}" is not an object`,
      });
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record["name"] === "string" ? record["name"] : key;

    if (name !== key) {
      violations.push({
        rule: "command-tiers",
        file,
        message: `the entry for "${key}" carries the name "${name}"`,
      });
    }

    const tier = record["tier"];
    if (tier !== "A" && tier !== "B" && tier !== "C") {
      violations.push({
        rule: "command-tiers",
        file,
        message: `the command "${name}" has no valid tier`,
      });
      continue;
    }

    if (tier === "C" && typeof record["unavailableReason"] !== "string") {
      violations.push({
        rule: "command-tiers",
        file,
        message: `the tier C command "${name}" needs an unavailableReason`,
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
