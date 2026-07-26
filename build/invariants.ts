/**
 * Build-time invariants (IMPLEMENTATION_PLAN.md §9.4).
 *
 * These are checks a reviewer would otherwise have to remember. Each one
 * corresponds to a way this project could quietly stop working on WebKit — a
 * `<style>` element sneaking back in, a `GM_*` call bypassing the capability
 * shim, Stage 0 growing until it costs real time in twenty frames.
 */

import { walk } from "@std/fs";
import { relative } from "@std/path";

export interface Violation {
  readonly rule: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export interface InvariantInput {
  readonly root: string;
  readonly bundle: string;
  readonly stage0Bytes: number;
  readonly declaredVersion: string;
  readonly metadataBlock: string;
}

export const STAGE0_BUDGET_BYTES = 5 * 1024;
/** Headroom under Greasy Fork's 2 MB unminified ceiling. */
export const BUNDLE_BUDGET_BYTES = 1_500 * 1024;

/** Files exempt from the "all GM access goes through the shim" rule. */
const GM_SHIM_FILES: ReadonlySet<string> = new Set([
  "src/platform/gm.ts",
  "src/platform/gm-api.ts",
]);

/** The one documented place a `<style>` element may be created. */
const STYLE_ELEMENT_FILES: ReadonlySet<string> = new Set([
  "src/ui/root.ts",
]);

const sourceFiles = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  for await (
    const entry of walk(`${root}/src`, {
      exts: [".ts"],
      includeDirs: false,
    })
  ) {
    out.push(entry.path);
  }
  return out.sort();
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
      contents: await Deno.readTextFile(path),
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
        `metadata @version does not match deno.json (${input.declaredVersion})`,
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
  const module = await import(`file://${root}/src/core/commands.ts`);
  const build: unknown = (module as Record<string, unknown>)["buildCommands"];
  if (typeof build !== "function") {
    return [{
      rule: "command-tiers",
      file: "src/core/commands.ts",
      message: "buildCommands is not exported",
    }];
  }

  const commands: unknown = (build as () => unknown)();
  if (!Array.isArray(commands)) return violations;

  for (const entry of commands) {
    if (typeof entry !== "object" || entry === null) continue;
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
