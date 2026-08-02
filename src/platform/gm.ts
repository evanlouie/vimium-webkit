/**
 * The single chokepoint for every userscript-manager API call.
 *
 * Nothing outside this module may reference a `GM`/`GM_*` identifier; the build
 * enforces that (IMPLEMENTATION_PLAN.md §9.4 item 6). Everything here is
 * feature-*probed*, never sniffed by manager name, and every fallible operation
 * returns an `Effect` whose error channel names the failure, so callers are
 * forced to have a user-visible story for failure rather than an unhandled
 * rejection.
 */

import { Context, Effect, Layer, Option, Schema } from "effect";
import { probe } from "./ambient.ts";
import type {
  GmNamespace,
  GmOpenInTabOptions,
  GmTabHandle,
  GmValue,
  GmXhrDetails,
  GmXhrHandle,
  GmXhrResponse,
} from "./gm-api.ts";

export type { GmOpenInTabOptions, GmXhrDetails, GmXhrResponse };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Why a manager call did not produce a value.
 *
 * A `reason` field rather than three error classes: callers overwhelmingly
 * treat all three the same way (tell the user the feature is off), and the two
 * that do care use `Effect.catchReason` to pick one out. Three classes would
 * have made the common case a three-arm match.
 */
export const GmFailureReason = Schema.Literals([
  /** The manager does not expose this API at all. */
  "unavailable",
  /** The API exists but threw or rejected. */
  "failed",
  /** The API returned something we could not make sense of. */
  "invalid",
]);

export type GmFailureReason = typeof GmFailureReason.Type;

export class GmError extends Schema.TaggedErrorClass<GmError>()("GmError", {
  reason: GmFailureReason,
  api: Schema.String,
  detail: Schema.String,
  // `Defect` rather than `Unknown`: this may be an arbitrary thrown value, and
  // it has to survive being written to storage or crossing the frame wire.
  cause: Schema.optional(Schema.Defect()),
}) {}

const unavailable = (api: string): GmError =>
  new GmError({
    reason: "unavailable",
    api,
    detail: `${api} is not provided by this userscript manager`,
  });

const describe = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
};

const failed = (api: string) => (cause: unknown): GmError =>
  new GmError({ reason: "failed", api, detail: describe(cause), cause });

/**
 * Run a synchronous manager call, converting a throw into a `GmError`.
 *
 * Synchronous on purpose. `Effect.try` does not suspend, so a call made from
 * inside a key handler still runs within the browser's transient activation
 * window — which is the whole reason `setClipboard` works at all.
 */
export const attempt = <T>(
  api: string,
  fn: () => T,
): Effect.Effect<T, GmError> => Effect.try({ try: fn, catch: failed(api) });

/** Run an async manager call, converting a rejection into a `GmError`. */
export const attemptAsync = <T>(
  api: string,
  fn: () => Promise<T>,
): Effect.Effect<T, GmError> =>
  Effect.tryPromise({ try: async () => await fn(), catch: failed(api) });

// ---------------------------------------------------------------------------
// Surface detection
// ---------------------------------------------------------------------------

type SyncGetValue = (
  key: string,
  defaultValue?: GmValue,
) => GmValue | undefined;
type SyncSetValue = (key: string, value: GmValue) => void;
type SyncDeleteValue = (key: string) => void;
type SyncListValues = () => readonly string[];
type OpenInTab = (
  url: string,
  options?: GmOpenInTabOptions | boolean,
) => GmTabHandle | undefined;
type SetClipboard = (data: string, type?: string) => void;
type Xhr = (details: GmXhrDetails) => GmXhrHandle | undefined;
type AddValueChangeListener = (
  key: string,
  callback: (
    name: string,
    oldValue: GmValue | undefined,
    newValue: GmValue | undefined,
    remote: boolean,
  ) => void,
) => string | number;
type RegisterMenuCommand = (
  caption: string,
  onClick: () => void,
  accessKey?: string,
) => string | number;

/**
 * A snapshot of which manager entry points actually exist in this realm.
 *
 * This is the *only* place in the codebase that performs `typeof GM_*` guards.
 * A bare reference to an undeclared binding throws `ReferenceError`; `typeof`
 * does not, which is why every check below is written this way.
 */
export interface GmSurface {
  readonly namespace: GmNamespace | null;
  readonly info: unknown;
  readonly getValueSync: SyncGetValue | null;
  readonly setValueSync: SyncSetValue | null;
  readonly deleteValueSync: SyncDeleteValue | null;
  readonly listValuesSync: SyncListValues | null;
  readonly openInTabSync: OpenInTab | null;
  readonly setClipboardSync: SetClipboard | null;
  readonly xhrSync: Xhr | null;
  readonly addValueChangeListener: AddValueChangeListener | null;
  readonly registerMenuCommand: RegisterMenuCommand | null;
  readonly addStyle: ((css: string) => unknown) | null;
  readonly hasUnsafeWindow: boolean;
  /** `window.close` is `@grant`-gated; VM/TM only. Probed lazily by `tabs.ts`. */
  readonly windowClose: (() => void) | null;
}

/**
 * Read one manager binding, tolerating both kinds of absence.
 *
 * `typeof` is what stops an *undeclared* identifier throwing `ReferenceError`.
 * The `probe` is what stops a *declared but hostile* one — an accessor that
 * throws — taking the rest of the surface with it. Both are needed, and in the
 * page world both are reachable by the site: these are ordinary `window`
 * properties there, so a page gets a vote on what we see.
 *
 * Per binding rather than around the whole surface, so one poisoned name costs
 * one API instead of sending us to the no-storage fallback.
 */
const binding = <T>(read: () => T | undefined): T | null =>
  probe(() => read() ?? null, null);

export const detectGmSurface = (): GmSurface => {
  const namespace = binding<GmNamespace>(() =>
    typeof GM !== "undefined" && GM !== null && typeof GM === "object"
      ? GM
      : undefined
  );

  const info: unknown = probe(
    () => typeof GM_info !== "undefined" ? GM_info : namespace?.info ?? null,
    null,
  );

  return {
    namespace,
    info,
    getValueSync: binding(() =>
      typeof GM_getValue === "function" ? GM_getValue : undefined
    ),
    setValueSync: binding(() =>
      typeof GM_setValue === "function" ? GM_setValue : undefined
    ),
    deleteValueSync: binding(() =>
      typeof GM_deleteValue === "function" ? GM_deleteValue : undefined
    ),
    listValuesSync: binding(() =>
      typeof GM_listValues === "function" ? GM_listValues : undefined
    ),
    openInTabSync: binding(() =>
      typeof GM_openInTab === "function" ? GM_openInTab : undefined
    ),
    setClipboardSync: binding(() =>
      typeof GM_setClipboard === "function" ? GM_setClipboard : undefined
    ),
    xhrSync: binding(() =>
      typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : undefined
    ),
    addValueChangeListener: binding(() =>
      typeof GM_addValueChangeListener === "function"
        ? GM_addValueChangeListener
        : undefined
    ),
    registerMenuCommand: binding(() =>
      typeof GM_registerMenuCommand === "function"
        ? GM_registerMenuCommand
        : undefined
    ),
    addStyle: binding(() =>
      typeof GM_addStyle === "function" ? GM_addStyle : undefined
    ),
    hasUnsafeWindow: probe(
      () => typeof unsafeWindow !== "undefined" && unsafeWindow !== undefined,
      false,
    ),
    windowClose: probeWindowClose(),
  };
};

/**
 * `window.close()` only works from a userscript when the manager honoured the
 * `@grant window.close` line (Violentmonkey and Tampermonkey do; quoid and Stay
 * do not). There is no way to distinguish "granted" from "will silently no-op"
 * ahead of time, so we only report whether the function is callable at all.
 */
const probeWindowClose = (): (() => void) | null =>
  probe(() => {
    const fn: unknown = globalThis.close;
    return typeof fn === "function" ? () => globalThis.close() : null;
  }, null);

// ---------------------------------------------------------------------------
// GM_info
// ---------------------------------------------------------------------------

export interface ManagerIdentity {
  readonly handler: string | null;
  readonly handlerVersion: string | null;
  readonly scriptVersion: string | null;
  readonly injectInto: string | null;
  readonly sandboxMode: string | null;
}

const readString = (source: unknown, key: string): string | null => {
  if (typeof source !== "object" || source === null) return null;
  const value: unknown = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

const readObject = (source: unknown, key: string): unknown => {
  if (typeof source !== "object" || source === null) return null;
  return (source as Record<string, unknown>)[key];
};

/** Diagnostics only. Never branch on this — probe the API instead. */
export const readManagerIdentity = (info: unknown): ManagerIdentity => {
  const script = readObject(info, "script");
  return {
    handler: readString(info, "scriptHandler"),
    handlerVersion: readString(info, "version"),
    scriptVersion: readString(script, "version"),
    injectInto: readString(info, "injectInto") ??
      readString(readObject(info, "script"), "injectInto"),
    sandboxMode: readString(info, "sandboxMode"),
  };
};

// ---------------------------------------------------------------------------
// Value store backends
// ---------------------------------------------------------------------------

export type ValueBackendKind =
  | "gm-sync"
  | "gm-async"
  | "localstorage-fallback"
  | "memory";

/**
 * A string-in / string-out key-value backend.
 *
 * We deliberately store only JSON strings rather than relying on the managers'
 * own (inconsistent) structured-value support: quoid round-trips through JSON
 * anyway, Tampermonkey and Violentmonkey differ on what they will accept, and
 * owning the serialisation is what lets `storage.ts` validate every read
 * against a schema.
 *
 * `get` answers `Option` rather than `string | undefined`: "absent" is a normal
 * outcome here, not a failure, and the two must not be confused with a stored
 * empty string.
 */
export interface ValueBackend {
  readonly kind: ValueBackendKind;
  get(key: string): Effect.Effect<Option.Option<string>, GmError>;
  set(key: string, value: string): Effect.Effect<void, GmError>;
  remove(key: string): Effect.Effect<void, GmError>;
  /** Cross-tab change notification; `null` when the manager has no primitive. */
  readonly watch:
    | ((key: string, onChange: (raw: string | undefined) => void) => () => void)
    | null;
}

const asString = (value: GmValue | undefined): string | undefined =>
  typeof value === "string"
    ? value
    : value === undefined || value === null
    ? undefined
    : String(value);

const asOption = (value: GmValue | undefined): Option.Option<string> =>
  Option.fromNullishOr(asString(value) ?? null);

const syncBackend = (surface: GmSurface): ValueBackend | null => {
  const { getValueSync, setValueSync, deleteValueSync } = surface;
  if (!getValueSync || !setValueSync || !deleteValueSync) return null;

  const watcher = surface.addValueChangeListener;

  return {
    kind: "gm-sync",
    get: (key) => attempt("GM_getValue", () => asOption(getValueSync(key))),
    set: (key, value) =>
      attempt("GM_setValue", () => {
        setValueSync(key, value);
      }),
    remove: (key) =>
      attempt("GM_deleteValue", () => {
        deleteValueSync(key);
      }),
    watch: watcher
      ? (key, onChange) => {
        const id = watcher(key, (_name, _old, newValue) => {
          onChange(asString(newValue));
        });
        return () => {
          // Not in the compatibility floor; best-effort teardown only. A leaked
          // listener is strictly better than a throw during mode teardown.
          if (typeof GM_removeValueChangeListener === "function") {
            try {
              GM_removeValueChangeListener(id);
            } catch {
              // ignored
            }
          }
        };
      }
      : null,
  };
};

const asyncBackend = (surface: GmSurface): ValueBackend | null => {
  const ns = surface.namespace;
  if (!ns?.getValue || !ns.setValue || !ns.deleteValue) return null;
  const { getValue, setValue, deleteValue } = ns;

  return {
    kind: "gm-async",
    get: (key) =>
      attemptAsync("GM.getValue", async () => asOption(await getValue(key))),
    set: (key, value) =>
      attemptAsync("GM.setValue", async () => {
        await setValue(key, value);
      }),
    remove: (key) =>
      attemptAsync("GM.deleteValue", async () => {
        await deleteValue(key);
      }),
    watch: null,
  };
};

/**
 * Last resort. `localStorage` is *not* durable on WebKit: ITP erases all
 * script-writable storage after seven days without user interaction on the
 * site, and it is partitioned per top-level site so settings do not follow the
 * user around. Callers must surface the warning in `capabilities.ts`.
 */
const localStorageBackend = (prefix: string): ValueBackend | null => {
  let store: Storage;
  try {
    store = globalThis.localStorage;
    const probeKey = `${prefix}__probe`;
    store.setItem(probeKey, "1");
    store.removeItem(probeKey);
  } catch {
    return null;
  }

  const scoped = (key: string): string => `${prefix}${key}`;

  return {
    kind: "localstorage-fallback",
    get: (key) =>
      attempt(
        "localStorage.getItem",
        () => Option.fromNullOr(store.getItem(scoped(key))),
      ),
    set: (key, value) =>
      attempt("localStorage.setItem", () => {
        store.setItem(scoped(key), value);
      }),
    remove: (key) =>
      attempt("localStorage.removeItem", () => {
        store.removeItem(scoped(key));
      }),
    watch: (key, onChange) => {
      const listener = (event: StorageEvent): void => {
        if (event.key === scoped(key)) onChange(event.newValue ?? undefined);
      };
      globalThis.addEventListener("storage", listener);
      return () => globalThis.removeEventListener("storage", listener);
    },
  };
};

/** In-memory, per-frame, non-durable. Keeps the app alive when all else fails. */
const memoryBackend = (): ValueBackend => {
  const map = new Map<string, string>();
  return {
    kind: "memory",
    get: (key) => Effect.sync(() => Option.fromNullishOr(map.get(key) ?? null)),
    set: (key, value) =>
      Effect.sync(() => {
        map.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        map.delete(key);
      }),
    watch: null,
  };
};

/**
 * `GM.setValue/getValue → GM_setValue/getValue → localStorage → memory`
 *
 * The async `GM.*` form is preferred over the sync `GM_*` form deliberately:
 * it is the only one present on quoid (our capability floor), and preferring it
 * everywhere means the boot path has identical timing characteristics across
 * managers instead of being fast on Tampermonkey and untested on quoid.
 */
export const selectValueBackend = (
  surface: GmSurface,
  localStoragePrefix: string,
): ValueBackend =>
  asyncBackend(surface) ??
    syncBackend(surface) ??
    localStorageBackend(localStoragePrefix) ??
    memoryBackend();

// ---------------------------------------------------------------------------
// Tabs / clipboard / network primitives
// ---------------------------------------------------------------------------

export interface OpenInTabResult {
  readonly handle: GmTabHandle | null;
  /** `false` when we had to fall back to `window.open`. */
  readonly viaManager: boolean;
}

/**
 * Open a URL in a new tab.
 *
 * `window.open` is the fallback and a bad one on WebKit: it requires *fresh,
 * synchronous* transient activation (well under a second in Safari) and cannot
 * produce a background tab from page JS at all. Prefer the manager path always.
 */
export const openInTab = (
  surface: GmSurface,
  url: string,
  options: GmOpenInTabOptions,
): Effect.Effect<OpenInTabResult, GmError> => {
  const ns = surface.namespace;
  if (ns?.openInTab) {
    const open = ns.openInTab;
    return attemptAsync("GM.openInTab", async () => {
      const handle = await open(url, options);
      return { handle: handle ?? null, viaManager: true };
    });
  }

  if (surface.openInTabSync) {
    const open = surface.openInTabSync;
    return attempt("GM_openInTab", () => ({
      handle: open(url, options) ?? null,
      viaManager: true,
    }));
  }

  return attempt("window.open", () => {
    const opened = globalThis.open(url, "_blank", "noopener,noreferrer");
    if (opened === null) {
      throw new Error("window.open was blocked (no transient activation?)");
    }
    return { handle: null, viaManager: false };
  });
};

/**
 * Write to the clipboard via the manager.
 *
 * Must run synchronously inside the keydown task; awaiting anything first
 * consumes the transient activation the write depends on. Every effect on this
 * path is `Effect.try` or `Effect.fail`, neither of which suspends, so the
 * write still happens inside the activation window when run with `runSync`.
 */
export const setClipboard = (
  surface: GmSurface,
  text: string,
): Effect.Effect<void, GmError> => {
  const ns = surface.namespace;
  if (ns?.setClipboard) {
    const write = ns.setClipboard;
    return attempt("GM.setClipboard", () => {
      // May return a promise on some managers; we intentionally do not await —
      // the caller is inside an activation-sensitive synchronous task.
      void write(text, "text/plain");
    });
  }
  if (surface.setClipboardSync) {
    const write = surface.setClipboardSync;
    return attempt("GM_setClipboard", () => write(text, "text/plain"));
  }
  return Effect.fail(unavailable("GM_setClipboard"));
};

export interface XhrRequest {
  readonly url: string;
  readonly method?: "GET" | "POST" | "HEAD";
  readonly headers?: Readonly<Record<string, string>>;
  readonly data?: string;
  readonly timeoutMs?: number;
}

export interface XhrHandle {
  readonly response: Effect.Effect<GmXhrResponse, GmError>;
  abort(): void;
}

/**
 * Cross-origin fetch through the manager. Requires `@connect`, which quoid does
 * not implement — callers must treat `unavailable` as "this feature is off",
 * not as an error worth surfacing repeatedly.
 */
export const xmlHttpRequest = (
  surface: GmSurface,
  request: XhrRequest,
): Effect.Effect<XhrHandle, GmError> => {
  const ns = surface.namespace;
  const impl: ((details: GmXhrDetails) => unknown) | null = ns?.xmlHttpRequest
    ? (details) => ns.xmlHttpRequest?.(details)
    : surface.xhrSync;
  if (!impl) return Effect.fail(unavailable("GM_xmlhttpRequest"));

  return Effect.sync(() => {
    let handle: GmXhrHandle | undefined;
    let aborted = false;

    const promise = new Promise<GmXhrResponse>((resolve, reject) => {
      const details: GmXhrDetails = {
        method: request.method ?? "GET",
        url: request.url,
        headers: request.headers,
        data: request.data,
        timeout: request.timeoutMs,
        responseType: "text",
        onload: resolve,
        onerror: () => reject(new Error(`network error for ${request.url}`)),
        ontimeout: () => reject(new Error(`timeout for ${request.url}`)),
        onabort: () => reject(new Error("aborted")),
      };
      const returned: unknown = impl(details);
      if (returned instanceof Promise) {
        void returned.then((value: unknown) => {
          handle = (value ?? undefined) as GmXhrHandle | undefined;
          if (aborted) handle?.abort?.();
        });
      } else if (returned !== null && typeof returned === "object") {
        handle = returned as GmXhrHandle;
      }
    });

    return {
      response: attemptAsync("GM_xmlhttpRequest", () => promise),
      abort: () => {
        aborted = true;
        handle?.abort?.();
      },
    };
  });
};

/** Progressive enhancement only; absent on quoid and on Stay. */
export const registerMenuCommand = (
  surface: GmSurface,
  caption: string,
  onClick: () => void,
): Effect.Effect<void, GmError> => {
  const register = surface.registerMenuCommand ??
    (surface.namespace?.registerMenuCommand
      ? (c: string, cb: () => void) => {
        surface.namespace?.registerMenuCommand?.(c, cb);
        return 0;
      }
      : null);
  if (!register) return Effect.fail(unavailable("GM_registerMenuCommand"));
  return attempt("GM_registerMenuCommand", () => {
    register(caption, onClick);
  });
};

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * The manager surface, as a service.
 *
 * Detection reads ambient globals, which is real work in a realm we do not
 * control, so it happens once when the layer is built rather than at each call
 * site. Holding it as a service is also what lets a test swap the whole manager
 * for a fake by providing a different layer, instead of reaching into globals.
 */
export class Gm extends Context.Service<Gm, {
  /** The probed surface. Read-only; never branch on the manager's name. */
  readonly surface: GmSurface;
}>()("vimium/platform/Gm") {
  static readonly layer = Layer.effect(
    Gm,
    Effect.sync(() => Gm.of({ surface: detectGmSurface() })),
  );

  /** A layer over an already-probed surface, for Stage 1 and for tests. */
  static readonly layerFrom = (surface: GmSurface): Layer.Layer<Gm> =>
    Layer.succeed(Gm, Gm.of({ surface }));
}
