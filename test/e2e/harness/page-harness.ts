/**
 * The in-page half of the harness.
 *
 * Everything here is serialised by `page.addInitScript()` and runs *before* the
 * bundle, in the page's own realm, at document start — the same position a
 * userscript manager injects from. It does three jobs:
 *
 * 1. **Stub the GM API**, so the `typeof` probes of `platform/Gm.ts` find something.
 *    Two variants: a Tampermonkey/Violentmonkey-shaped synchronous surface, and
 *    a quoid-shaped promise-only `GM.*` namespace (the capability floor).
 * 2. **Record side effects** a browser cannot show us — `GM_openInTab` targets,
 *    clipboard writes, and CSP violation reports.
 * 3. **Capture the overlay's closed shadow root.**
 * 4. **Keep the value store across a navigation.** The `Map` of the store is
 *    made again for each document. A mirror in `localStorage` therefore holds
 *    the same values under a private prefix. A spec can change a value, leave
 *    the page, and read the value back.
 *
 * On (3): this is a *page-side monkeypatch of `Element.prototype.attachShadow`
 * installed before the extension loads*. It touches nothing in `src/` and
 * weakens nothing in production — it is simply the fact that a closed shadow
 * root is a hardening measure against *page script that runs after us*, not a
 * capability boundary against script that runs before us. Specs use it only
 * where there is genuinely nothing observable outside the root (proving the
 * help dialog is *styled* under a strict CSP). Everything else asserts on
 * observable side effects: navigation, focus, scroll position, clipboard, and
 * document mutations.
 */

// ---------------------------------------------------------------------------
// Shapes shared between the page and the specs
// ---------------------------------------------------------------------------

/**
 * Which manager surface to emulate.
 *
 * - `sync` — `GM_*` functions present (Tampermonkey, Violentmonkey, ScriptCat).
 * - `async` — only the promise-flavoured `GM.*` namespace, like quoid's
 *   Userscripts. Stay gives both API forms. This variant is the capability
 *   floor that each decision must support.
 */
export type GmVariant = "sync" | "async";

export interface HarnessInit {
  readonly variant: GmVariant;
  /** Reported as `GM_info.scriptHandler`; diagnostics only, never branched on. */
  readonly scriptHandler: string;
  /** Pre-seeded value store: storage key -> raw stored string. */
  readonly seed: Readonly<Record<string, string>>;
}

export interface OpenedTab {
  readonly url: string;
  /** `null` when the caller passed no options at all. */
  readonly active: boolean | null;
}

export interface ClipboardWrite {
  readonly data: string;
  readonly type: string | null;
}

export interface CspViolation {
  readonly directive: string;
  readonly blockedUri: string;
  readonly sample: string;
  readonly documentUri: string;
}

export interface TimerCounters {
  readonly raf: number;
  readonly timeout: number;
  readonly interval: number;
}

/** A JSON-safe snapshot of everything the page recorded. */
export interface HarnessSnapshot {
  readonly openedTabs: readonly OpenedTab[];
  readonly clipboard: readonly ClipboardWrite[];
  readonly violations: readonly CspViolation[];
  readonly counters: TimerCounters;
  readonly stored: Readonly<Record<string, string>>;
  /** Whether the overlay's closed shadow root has been created yet. */
  readonly overlayAttached: boolean;
}

/**
 * The name the harness state hangs off `globalThis` under.
 *
 * Duplicated as a literal inside `installPageHarness` and in every in-page
 * accessor, because a serialised function cannot close over module scope.
 */
export const HARNESS_GLOBAL = "__vimiumHarness";

/** Mutable in-page state. Only ever touched from inside the browser. */
export interface HarnessState {
  readonly store: Map<string, string>;
  readonly openedTabs: OpenedTab[];
  readonly clipboard: ClipboardWrite[];
  readonly violations: CspViolation[];
  readonly counters: { raf: number; timeout: number; interval: number };
  shadow: ShadowRoot | null;
}

export interface HarnessHost {
  __vimiumHarness?: HarnessState;
}

// ---------------------------------------------------------------------------
// The init script
// ---------------------------------------------------------------------------

/**
 * Install the harness. Passed to `page.addInitScript(installPageHarness, init)`.
 *
 * Must remain self-contained: Playwright serialises the function body, so any
 * reference to module scope would be a `ReferenceError` in the page.
 */
export const installPageHarness = (init: HarnessInit): void => {
  type GmValue = string | number | boolean | null;

  /**
   * Where the store keeps a value that must survive the document.
   *
   * The `Map` below is made again for each document, so it alone can never
   * answer "is the value still there after the page closed". The mirror in
   * `localStorage` can, and it is private to the harness: every key carries
   * this prefix, and the application never reads one.
   */
  const DURABLE_PREFIX = "__vimiumHarness:";

  interface OpenInTabOptions {
    readonly active?: boolean;
    readonly loadInBackground?: boolean;
  }
  interface TabHandle {
    readonly closed: boolean;
    close(): void;
    onclose: (() => void) | null;
  }

  interface GmNamespaceStub {
    readonly info: unknown;
    readonly getValue: (
      key: string,
      fallback?: GmValue,
    ) => Promise<GmValue | undefined>;
    readonly setValue: (key: string, value: GmValue) => Promise<void>;
    readonly deleteValue: (key: string) => Promise<void>;
    readonly openInTab: (
      url: string,
      options?: OpenInTabOptions | boolean,
    ) => Promise<TabHandle>;
    readonly setClipboard: (data: string, type?: string) => Promise<void>;
  }

  interface GmGlobals {
    GM?: GmNamespaceStub;
    GM_info?: unknown;
    GM_getValue?: (key: string, fallback?: GmValue) => GmValue | undefined;
    GM_setValue?: (key: string, value: GmValue) => void;
    GM_deleteValue?: (key: string) => void;
    GM_openInTab?: (
      url: string,
      options?: OpenInTabOptions | boolean,
    ) => TabHandle;
    GM_setClipboard?: (data: string, type?: string) => void;
  }

  interface Host {
    __vimiumHarness?: HarnessState;
  }

  const host = globalThis as unknown as Host & GmGlobals;
  // `addInitScript` fires once per document, but a fixture that replaces its
  // own document (or a re-used about:blank) can get here twice.
  if (host.__vimiumHarness !== undefined) return;

  const state: HarnessState = {
    store: new Map<string, string>(Object.entries(init.seed)),
    openedTabs: [],
    clipboard: [],
    violations: [],
    counters: { raf: 0, timeout: 0, interval: 0 },
    shadow: null,
  };
  host.__vimiumHarness = state;

  // -- The mirror that survives the document --------------------------------

  const durableStore = (): Storage | null => {
    try {
      return globalThis.localStorage;
    } catch {
      return null;
    }
  };

  /** Read back what an earlier document of this test wrote. */
  const restoreDurable = (): void => {
    const durable = durableStore();
    if (durable === null) return;
    for (let index = 0; index < durable.length; index++) {
      const name = durable.key(index);
      if (name === null || !name.startsWith(DURABLE_PREFIX)) continue;
      // The stored value wins over the seed. It is the newer of the two.
      state.store.set(
        name.slice(DURABLE_PREFIX.length),
        durable.getItem(name) ?? "",
      );
    }
  };

  const keepDurable = (key: string, value: string | null): void => {
    const durable = durableStore();
    if (durable === null) return;
    try {
      if (value === null) durable.removeItem(DURABLE_PREFIX + key);
      else durable.setItem(DURABLE_PREFIX + key, value);
    } catch {
      // A quota or a blocked store. The test asserts on the outcome.
    }
  };

  restoreDurable();

  // -- Closed shadow root capture -------------------------------------------

  const nativeAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function(
    this: Element,
    options: ShadowRootInit,
  ): ShadowRoot {
    const root = nativeAttachShadow.call(this, options);
    // Only the extension's single host. `capabilities.ts` probes constructable
    // stylesheets by attaching a throwaway root to a `<div>`; capturing that
    // would leave the specs looking at the wrong tree.
    if (this.localName === "vimium-webkit-overlay") state.shadow = root;
    return root;
  };

  // -- CSP reporting ---------------------------------------------------------

  globalThis.addEventListener(
    "securitypolicyviolation",
    (event: SecurityPolicyViolationEvent) => {
      state.violations.push({
        directive: event.effectiveDirective || event.violatedDirective,
        blockedUri: event.blockedURI,
        sample: event.sample,
        documentUri: event.documentURI,
      });
    },
    true,
  );

  // -- Timer instrumentation -------------------------------------------------

  type TimerFn = (
    handler: TimerHandler,
    timeout?: number,
    ...args: readonly unknown[]
  ) => number;

  const timers = globalThis as unknown as {
    setTimeout: TimerFn;
    setInterval: TimerFn;
    requestAnimationFrame: (callback: FrameRequestCallback) => number;
  };

  const nativeSetTimeout = timers.setTimeout.bind(globalThis);
  const nativeSetInterval = timers.setInterval.bind(globalThis);
  const nativeRaf = timers.requestAnimationFrame.bind(globalThis);

  timers.setTimeout = (handler, timeout, ...args): number => {
    state.counters.timeout += 1;
    return nativeSetTimeout(handler, timeout, ...args);
  };
  timers.setInterval = (handler, timeout, ...args): number => {
    state.counters.interval += 1;
    return nativeSetInterval(handler, timeout, ...args);
  };
  timers.requestAnimationFrame = (callback): number => {
    state.counters.raf += 1;
    return nativeRaf(callback);
  };

  // -- Value store -----------------------------------------------------------

  const readValue = (
    key: string,
    fallback?: GmValue,
  ): GmValue | undefined => {
    const value = state.store.get(key);
    return value === undefined ? fallback : value;
  };
  const writeValue = (key: string, value: GmValue): void => {
    state.store.set(key, String(value));
    keepDurable(key, String(value));
  };
  const dropValue = (key: string): void => {
    state.store.delete(key);
    keepDurable(key, null);
  };
  const recordTab = (
    url: string,
    options?: OpenInTabOptions | boolean,
  ): TabHandle => {
    const active = typeof options === "boolean"
      ? !options
      : options === undefined
      ? null
      : options.active ?? (options.loadInBackground === undefined
        ? null
        : !options.loadInBackground);
    state.openedTabs.push({ url, active });
    // A real handle would open a tab; the point of the recording is that no
    // test should ever depend on a second tab actually existing.
    return { closed: false, close: (): void => {}, onclose: null };
  };

  const recordClipboard = (data: string, type?: string): void => {
    state.clipboard.push({ data, type: type ?? null });
  };

  const info = {
    scriptHandler: init.scriptHandler,
    version: "0.0.0-harness",
    injectInto: "content",
    script: { version: "0.1.0", name: "Vimium-WebKit" },
  };

  if (init.variant === "sync") {
    host.GM_info = info;
    host.GM_getValue = readValue;
    host.GM_setValue = writeValue;
    host.GM_deleteValue = dropValue;
    host.GM_openInTab = recordTab;
    host.GM_setClipboard = recordClipboard;
    return;
  }

  // quoid's floor: promise-only, and nothing else. No `GM_*`, no
  // `unsafeWindow`, no `GM_addValueChangeListener`, no `GM_registerMenuCommand`.
  host.GM = {
    info,
    getValue: (key, fallback) => Promise.resolve(readValue(key, fallback)),
    setValue: (key, value) => {
      writeValue(key, value);
      return Promise.resolve();
    },
    deleteValue: (key) => {
      dropValue(key);
      return Promise.resolve();
    },
    openInTab: (url, options) => Promise.resolve(recordTab(url, options)),
    setClipboard: (data, type) => {
      recordClipboard(data, type);
      return Promise.resolve();
    },
  };
};
