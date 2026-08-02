/**
 * Ambient declarations for the userscript-manager (Greasemonkey) API surface.
 *
 * NOTHING declared here may be dereferenced directly. Every identifier is
 * *optionally* present depending on the manager, the `@grant` lines the user's
 * manager honoured, and the injection world. The only safe access pattern is a
 * `typeof` guard, which — unlike a bare reference — does not throw a
 * `ReferenceError` for an undeclared binding:
 *
 * ```ts
 * if (typeof GM_setValue === "function") { ... }
 * ```
 *
 * All consumers must go through `platform/gm.ts`; see the CI invariant in
 * item 6.
 */

export type GmValue = string | number | boolean | null;

export interface GmOpenInTabOptions {
  /** Focus the new tab. `false` requests a background tab (VM/TM). */
  readonly active?: boolean;
  /** Insert directly after the current tab rather than at the end. */
  readonly insert?: boolean;
  /** Set the opener so closing the child returns focus here. */
  readonly setParent?: boolean;
  /** Tampermonkey's legacy spelling of `!active`. */
  readonly loadInBackground?: boolean;
  readonly pinned?: boolean;
  readonly incognito?: boolean;
}

export interface GmTabHandle {
  readonly closed?: boolean;
  close?: () => void;
  onclose?: (() => void) | null;
}

export interface GmXhrResponse {
  readonly readyState: number;
  readonly status: number;
  readonly statusText: string;
  readonly responseHeaders: string;
  readonly responseText?: string;
  readonly response?: unknown;
  readonly finalUrl?: string;
}

export interface GmXhrDetails {
  readonly method?: "GET" | "POST" | "HEAD";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly data?: string;
  readonly timeout?: number;
  readonly responseType?: "text" | "json" | "arraybuffer" | "blob";
  readonly onload?: (response: GmXhrResponse) => void;
  readonly onerror?: (response: GmXhrResponse) => void;
  readonly ontimeout?: (response: GmXhrResponse) => void;
  readonly onabort?: (response: GmXhrResponse) => void;
}

export interface GmXhrHandle {
  abort?: () => void;
}

/**
 * The `GM.*` promise-flavoured namespace. Every member is optional: quoid's
 * Userscripts exposes a strict subset, Stay another, and a `@grant`-less
 * Violentmonkey script gets none of it.
 */
export interface GmNamespace {
  readonly info?: unknown;
  readonly getValue?: (
    key: string,
    defaultValue?: GmValue,
  ) => Promise<GmValue | undefined>;
  readonly setValue?: (key: string, value: GmValue) => Promise<void>;
  readonly deleteValue?: (key: string) => Promise<void>;
  readonly openInTab?: (
    url: string,
    options?: GmOpenInTabOptions | boolean,
  ) => GmTabHandle | undefined | Promise<GmTabHandle | undefined>;
  readonly setClipboard?: (data: string, type?: string) => void | Promise<void>;
  readonly xmlHttpRequest?: (
    details: GmXhrDetails,
  ) => GmXhrHandle | undefined | Promise<GmXhrHandle | undefined>;
  readonly registerMenuCommand?: (
    caption: string,
    onClick: () => void,
    accessKey?: string,
  ) => unknown;
  readonly addStyle?: (css: string) => unknown;
  readonly addElement?: (
    tagName: string,
    attributes: Readonly<Record<string, string>>,
  ) => Element;
}

declare global {
  // --- `GM.*` (promise form). The compatibility floor. ---
  const GM: GmNamespace | undefined;

  // --- `GM_*` (synchronous / callback form). Richer, but less portable. ---
  // `unknown` on purpose: the shape is manager-defined, so it gets validated.
  const GM_info: unknown;

  function GM_getValue(
    key: string,
    defaultValue?: GmValue,
  ): GmValue | undefined;
  function GM_setValue(key: string, value: GmValue): void;
  function GM_deleteValue(key: string): void;
  function GM_addValueChangeListener(
    key: string,
    callback: (
      name: string,
      oldValue: GmValue | undefined,
      newValue: GmValue | undefined,
      remote: boolean,
    ) => void,
  ): string | number;
  function GM_removeValueChangeListener(listenerId: string | number): void;

  function GM_openInTab(
    url: string,
    options?: GmOpenInTabOptions | boolean,
  ): GmTabHandle | undefined;

  function GM_setClipboard(data: string, type?: string): void;

  function GM_xmlhttpRequest(details: GmXhrDetails): GmXhrHandle | undefined;

  function GM_registerMenuCommand(
    caption: string,
    onClick: () => void,
    accessKey?: string,
  ): string | number;

  function GM_addStyle(css: string): HTMLStyleElement | undefined;

  /** Present only in page-world-capable managers. Never in quoid. */
  const unsafeWindow: (Window & typeof globalThis) | undefined;
}
