/**
 * The userscript metadata block.
 *
 * Generated rather than hand-maintained so that `@version` can be derived from
 * `deno.json` (CI invariant 5) and so the `@grant` list cannot drift away from
 * what `platform/gm.ts` actually probes for.
 */

export interface MetadataInput {
  readonly version: string;
  readonly repository: string;
  readonly downloadUrl: string;
  readonly updateUrl: string;
  readonly dev?: boolean;
}

/**
 * Both spellings of every storage/tab/clipboard grant.
 *
 * `platform/gm.ts` probes for `GM.*` first and `GM_*` second, so granting only
 * one form would silently disable the other path on managers that honour it.
 * Tampermonkey and Violentmonkey accept both; quoid ignores the ones it does
 * not implement.
 */
const GRANTS: readonly string[] = [
  "GM.info",
  "GM.setValue",
  "GM.getValue",
  "GM.deleteValue",
  "GM.listValues",
  "GM.openInTab",
  "GM.setClipboard",
  "GM.xmlHttpRequest",
  "GM_info",
  "GM_setValue",
  "GM_getValue",
  "GM_deleteValue",
  "GM_listValues",
  "GM_openInTab",
  "GM_setClipboard",
  "GM_xmlhttpRequest",
  // Progressive enhancement: absent on quoid and Stay, and the code path is
  // feature-probed, so requesting them costs nothing where they do not exist.
  "GM_addValueChangeListener",
  "GM_removeValueChangeListener",
  "GM_registerMenuCommand",
  "window.close",
];

export const buildMetadata = (input: MetadataInput): string => {
  const lines: Array<readonly [string, string]> = [
    ["name", input.dev === true ? "Vimium-WebKit (dev)" : "Vimium-WebKit"],
    ["namespace", input.repository],
    ["version", input.version],
    [
      "description",
      "Vim-style keyboard navigation for the web. Built for WebKit; works everywhere.",
    ],
    ["author", "Vimium-WebKit contributors"],
    ["license", "MIT"],
    ["homepageURL", input.repository],
    ["supportURL", `${input.repository}/issues`],
    ["match", "*://*/*"],
    ["run-at", "document-start"],
    // Violentmonkey and quoid honour this; Tampermonkey infers the world from
    // the `@grant` list. Content world is required because quoid only exposes
    // the GM API there (§5.3).
    ["inject-into", "content"],
    ...GRANTS.map((grant): readonly [string, string] => ["grant", grant]),
    // Needed for Omnibar-lite's search suggestions. quoid does not implement
    // `@connect` at all, which degrades to "no suggestions" rather than an error.
    ["connect", "*"],
    ["downloadURL", input.downloadUrl],
    ["updateURL", input.updateUrl],
  ];

  // `@noframes` is deliberately absent. It is a presence-only flag in
  // Tampermonkey — writing `@noframes false` *enables* it in some managers —
  // and running in every frame is required for cross-frame link hints (§6.5).

  const width = Math.max(...lines.map(([key]) => key.length));
  const body = lines
    .map(([key, value]) => `// @${key.padEnd(width)}  ${value}`)
    .join("\n");

  // Exactly one space after `//`, and the block must be the very first thing in
  // the file: ScriptCat rejects the script otherwise.
  return `// ==UserScript==\n${body}\n// ==/UserScript==\n`;
};

export const BANNER_NOTICE = `/*
 * Vimium-WebKit — Vim-style keyboard navigation for the web.
 *
 * Copyright (c) Vimium-WebKit contributors. Released under the MIT licence.
 *
 * Portions are derived from Vimium (https://github.com/philc/vimium):
 *   Copyright (c) 2010 Phil Crosby, Ilya Sukhar. Released under the MIT
 *   licence. Individual source files name the upstream file they derive from.
 *
 * See THIRD-PARTY-NOTICES.md in the repository for full licence texts.
 */
`;
