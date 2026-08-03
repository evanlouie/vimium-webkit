/**
 * The one gate to the userscript manager.
 *
 * No other file may name a `GM` or `GM_*` identifier. The build enforces that.
 * Everything here is feature-probed, never chosen by manager name, and every
 * operation that can fail gives an `Effect` whose error names the failure. A
 * caller is therefore forced to have an answer for the user, instead of an
 * unhandled rejection.
 *
 * A bare reference to an undeclared binding throws `ReferenceError`. `typeof`
 * does not. That is why every check below is written with `typeof`, and why
 * each one is also wrapped: a *declared but hostile* accessor can throw, and one
 * poisoned name must cost one API, not the whole surface.
 */

import { Context, Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import { Dom } from "./Dom.ts";
import type {
  GmNamespace,
  GmOpenInTabOptions,
  GmTabHandle,
  GmValue,
  GmXhrDetails,
  GmXhrHandle,
  GmXhrResponse,
} from "./GmApi.ts";

export type { GmOpenInTabOptions, GmXhrResponse };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Why a manager call gave no value.
 *
 * A `reason` field and not three classes. Almost every caller treats the three
 * the same way: tell the user that the function is off. The two callers that do
 * care use `Effect.catchReason` to take one out.
 */
export const GmFailureReason = Schema.Literals([
  /** The manager does not have this API. */
  "unavailable",
  /** The API is present, and it failed. */
  "failed",
  /** The API gave something that we cannot read. */
  "invalid",
]);

export type GmFailureReason = typeof GmFailureReason.Type;

export class GmError extends Schema.TaggedErrorClass<GmError>()("GmError", {
  reason: GmFailureReason,
  api: Schema.String,
  detail: Schema.String,
  // `Defect`, not `Unknown`: this can be any thrown value, and it must survive
  // a write to storage or a trip across the frame wire.
  cause: Schema.optional(Schema.Defect()),
}) {}

export const gmUnavailable = (api: string): GmError =>
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

const gmFailed = (api: string) => (cause: unknown): GmError =>
  new GmError({ reason: "failed", api, detail: describe(cause), cause });

/**
 * Run a synchronous manager call.
 *
 * Synchronous by design. `Effect.try` does not suspend, so a call from inside a
 * key handler still runs inside the browser's activation window. That is the
 * only reason `setClipboard` works.
 */
export const gmAttempt = <A>(
  api: string,
  run: () => A,
): Effect.Effect<A, GmError> => Effect.try({ try: run, catch: gmFailed(api) });

/** Run an asynchronous manager call. This suspends. Keep it off the key path. */
export const gmAttemptAsync = <A>(
  api: string,
  run: () => Promise<A>,
): Effect.Effect<A, GmError> =>
  Effect.tryPromise({ try: run, catch: gmFailed(api) });

// ---------------------------------------------------------------------------
// The probed surface
// ---------------------------------------------------------------------------

type SyncGetValue = (key: string, fallback?: GmValue) => GmValue | undefined;
type SyncSetValue = (key: string, value: GmValue) => void;
type SyncDeleteValue = (key: string) => void;
type OpenInTabSync = (
  url: string,
  options?: GmOpenInTabOptions | boolean,
) => GmTabHandle | undefined;
type SetClipboardSync = (data: string, type?: string) => void;
type XhrSync = (details: GmXhrDetails) => GmXhrHandle | undefined;
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

interface GmSurface {
  readonly namespace: GmNamespace | null;
  readonly info: unknown;
  readonly getValueSync: SyncGetValue | null;
  readonly setValueSync: SyncSetValue | null;
  readonly deleteValueSync: SyncDeleteValue | null;
  readonly openInTabSync: OpenInTabSync | null;
  readonly setClipboardSync: SetClipboardSync | null;
  readonly xhrSync: XhrSync | null;
  readonly addValueChangeListener: AddValueChangeListener | null;
  readonly registerMenuCommand: RegisterMenuCommand | null;
  readonly addStyle: ((css: string) => unknown) | null;
  readonly hasUnsafeWindow: boolean;
  readonly windowClose: (() => void) | null;
}

const detectSurface = (
  probeOr: <A>(read: () => A, fallback: A) => A,
): GmSurface => {
  const binding = <A>(read: () => A | undefined): A | null =>
    probeOr(() => read() ?? null, null);

  const namespace = binding<GmNamespace>(() =>
    typeof GM !== "undefined" && GM !== null && typeof GM === "object"
      ? GM
      : undefined
  );

  return {
    namespace,
    info: probeOr(
      () => typeof GM_info !== "undefined" ? GM_info : namespace?.info ?? null,
      null,
    ),
    getValueSync: binding(() =>
      typeof GM_getValue === "function" ? GM_getValue : undefined
    ),
    setValueSync: binding(() =>
      typeof GM_setValue === "function" ? GM_setValue : undefined
    ),
    deleteValueSync: binding(() =>
      typeof GM_deleteValue === "function" ? GM_deleteValue : undefined
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
    hasUnsafeWindow: probeOr(
      () => typeof unsafeWindow !== "undefined" && unsafeWindow !== undefined,
      false,
    ),
    // `window.close()` works from a userscript only when the manager honoured
    // `@grant window.close`. Violentmonkey and Tampermonkey do. Others do not,
    // and there is no way to tell "granted" from "silently does nothing".
    windowClose: probeOr(() => {
      const fn: unknown = globalThis.close;
      return typeof fn === "function" ? () => globalThis.close() : null;
    }, null),
  };
};

// ---------------------------------------------------------------------------
// Manager identity
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

/** For a bug report only. Never take a decision from this. Probe instead. */
const readIdentity = (info: unknown): ManagerIdentity => {
  const script = readObject(info, "script");
  return {
    handler: readString(info, "scriptHandler"),
    handlerVersion: readString(info, "version"),
    scriptVersion: readString(script, "version"),
    injectInto: readString(info, "injectInto") ??
      readString(script, "injectInto"),
    sandboxMode: readString(info, "sandboxMode"),
  };
};

// ---------------------------------------------------------------------------
// The value API
// ---------------------------------------------------------------------------

export type GmValueApiKind = "gm-async" | "gm-sync";

/**
 * A string-in, string-out value API.
 *
 * We store JSON strings, and never the managers' own structured values. quoid
 * goes through JSON anyway, Tampermonkey and Violentmonkey disagree on what
 * they accept, and owning the serialisation is what lets `Storage.ts` check
 * every read against a schema.
 *
 * `get` gives an `Option`. "Absent" is a normal answer here, not a failure, and
 * it must not be confused with a stored empty string.
 */
export interface GmValueApi {
  readonly kind: GmValueApiKind;
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, GmError>;
  readonly set: (key: string, value: string) => Effect.Effect<void, GmError>;
  readonly remove: (key: string) => Effect.Effect<void, GmError>;
  /** A synchronous API binding, when the manager gives one. */
  readonly setUnsafe: ((key: string, value: string) => void) | null;
  /** Changes made in another tab. `None` when the manager has no such API. */
  readonly changes: Option.Option<
    (key: string) => Stream.Stream<Option.Option<string>>
  >;
}

const asString = (value: GmValue | undefined): string | undefined =>
  typeof value === "string"
    ? value
    : value === undefined || value === null
    ? undefined
    : String(value);

const asOption = (value: GmValue | undefined): Option.Option<string> =>
  Option.fromNullishOr(asString(value) ?? null);

const asyncValueApi = (surface: GmSurface): Option.Option<GmValueApi> => {
  const ns = surface.namespace;
  if (!ns?.getValue || !ns.setValue || !ns.deleteValue) return Option.none();
  const { getValue, setValue, deleteValue } = ns;
  // Some managers give both forms. Stay 2.1.0 is one example. This field
  // describes the API surface. It does not describe disk durability.
  const sync = surface.setValueSync;
  return Option.some({
    kind: "gm-async",
    get: (key) =>
      gmAttemptAsync("GM.getValue", () => getValue(key).then(asOption)),
    set: (key, value) =>
      gmAttemptAsync("GM.setValue", () => setValue(key, value)),
    remove: (key) => gmAttemptAsync("GM.deleteValue", () => deleteValue(key)),
    setUnsafe: sync === null
      ? null
      : (key, value) => {
        sync(key, value);
      },
    changes: Option.none(),
  });
};

const syncValueApi = (surface: GmSurface): Option.Option<GmValueApi> => {
  const { getValueSync, setValueSync, deleteValueSync } = surface;
  if (!getValueSync || !setValueSync || !deleteValueSync) return Option.none();
  const watcher = surface.addValueChangeListener;

  return Option.some({
    kind: "gm-sync",
    get: (key) => gmAttempt("GM_getValue", () => asOption(getValueSync(key))),
    set: (key, value) =>
      gmAttempt("GM_setValue", () => {
        setValueSync(key, value);
      }),
    remove: (key) =>
      gmAttempt("GM_deleteValue", () => {
        deleteValueSync(key);
      }),
    setUnsafe: (key, value) => {
      setValueSync(key, value);
    },
    changes: watcher === null
      ? Option.none()
      : Option.some((key: string) =>
        Stream.callback<Option.Option<string>>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              watcher(key, (_name, _old, next) => {
                Queue.offerUnsafe(queue, asOption(next));
              })
            ),
            (id) =>
              Effect.sync(() => {
                // Not in the compatibility floor, so this is best effort. A
                // listener that stays is better than a throw during teardown.
                try {
                  if (typeof GM_removeValueChangeListener === "function") {
                    GM_removeValueChangeListener(id);
                  }
                } catch {
                  // Nothing else can be done.
                }
              }),
          )
        )
      ),
  });
};

// ---------------------------------------------------------------------------
// Tabs, clipboard and network
// ---------------------------------------------------------------------------

export interface OpenInTabResult {
  readonly handle: GmTabHandle | null;
  /** `false` when the manager had no API and `window.open` was used. */
  readonly viaManager: boolean;
}

export interface XhrRequest {
  readonly url: string;
  readonly method?: "GET" | "POST" | "HEAD";
  readonly headers?: Readonly<Record<string, string>>;
  readonly data?: string;
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Gm extends Context.Service<Gm, {
  /** Diagnostics only. */
  readonly identity: ManagerIdentity;
  /** The raw `GM_info`, for a bug report. */
  readonly info: unknown;

  /** The best value API that this manager has, if it has one. */
  readonly values: Option.Option<GmValueApi>;

  /** True when the manager gives the page-world `unsafeWindow`. */
  readonly hasUnsafeWindow: boolean;

  readonly canOpenInTab: boolean;
  readonly canSetClipboard: boolean;
  readonly canRequest: boolean;
  readonly canRegisterMenuCommand: boolean;
  readonly canCloseWindow: boolean;
  readonly canAddStyle: boolean;

  /**
   * Open a URL in a new tab.
   *
   * `window.open` is the fallback, and a poor one on WebKit. It needs fresh
   * synchronous activation, and it cannot make a background tab from page
   * script. Always prefer the manager.
   */
  readonly openInTab: (
    url: string,
    options: GmOpenInTabOptions,
  ) => Effect.Effect<OpenInTabResult, GmError>;

  /**
   * Write to the clipboard through the manager.
   *
   * This must run synchronously inside the key task. Anything that suspends
   * first spends the transient activation that the write needs. Every effect
   * on this path is `Effect.try` or `Effect.fail`, and neither suspends.
   */
  readonly setClipboard: (text: string) => Effect.Effect<void, GmError>;

  /**
   * A cross-origin request through the manager.
   *
   * This needs `@connect`, which quoid does not have. Treat `unavailable` as
   * "this function is off", and do not report it more than once.
   */
  readonly request: (
    request: XhrRequest,
  ) => Effect.Effect<GmXhrResponse, GmError>;

  /** Add a menu entry for the life of the enclosing scope. */
  readonly registerMenuCommand: (
    caption: string,
    onClick: Effect.Effect<void>,
  ) => Effect.Effect<void, GmError>;

  /** Close this tab. Only Violentmonkey and Tampermonkey grant this. */
  readonly closeWindow: Effect.Effect<void, GmError>;
}>()("vimium/platform/Gm") {
  static readonly layer: Layer.Layer<Gm, never, Dom> = Layer.effect(
    Gm,
    Effect.gen(function*() {
      const dom = yield* Dom;
      const surface = detectSurface(
        <A>(read: () => A, fallback: A): A => {
          try {
            return read();
          } catch {
            return fallback;
          }
        },
      );
      return makeGm(surface, dom);
    }),
  );

  /** A layer over a surface that a test supplies. */
  static readonly layerFrom = (
    surface: GmSurface,
  ): Layer.Layer<Gm, never, Dom> =>
    Layer.effect(
      Gm,
      Effect.gen(function*() {
        const dom = yield* Dom;
        return makeGm(surface, dom);
      }),
    );
}

const makeGm = (surface: GmSurface, dom: Dom["Service"]): Gm["Service"] => {
  const ns = surface.namespace;

  const openInTab = Effect.fn("Gm.openInTab")(
    function*(url: string, options: GmOpenInTabOptions) {
      if (ns?.openInTab) {
        const open = ns.openInTab;
        return yield* gmAttemptAsync("GM.openInTab", async () => {
          const handle = await open(url, options);
          return { handle: handle ?? null, viaManager: true };
        });
      }
      if (surface.openInTabSync) {
        const open = surface.openInTabSync;
        return yield* gmAttempt("GM_openInTab", () => ({
          handle: open(url, options) ?? null,
          viaManager: true,
        }));
      }
      return yield* gmAttempt("window.open", () => {
        const opened = dom.window.open(url, "_blank", "noopener,noreferrer");
        if (opened === null) {
          throw new Error("window.open was blocked (no transient activation?)");
        }
        return { handle: null, viaManager: false };
      });
    },
  );

  const setClipboard = (text: string): Effect.Effect<void, GmError> => {
    if (ns?.setClipboard) {
      const write = ns.setClipboard;
      return gmAttempt("GM.setClipboard", () => {
        // Some managers give a promise. We do not wait for it: the caller is
        // inside an activation-sensitive synchronous task. A rejection handler
        // keeps it from becoming an unhandled rejection.
        const result = write(text, "text/plain");
        if (result instanceof Promise) result.catch(() => {});
      });
    }
    if (surface.setClipboardSync) {
      const write = surface.setClipboardSync;
      return gmAttempt("GM_setClipboard", () => write(text, "text/plain"));
    }
    return Effect.fail(gmUnavailable("GM_setClipboard"));
  };

  const request = Effect.fn("Gm.request")(function*(input: XhrRequest) {
    const impl: ((details: GmXhrDetails) => unknown) | null = ns?.xmlHttpRequest
      ? (details) => ns.xmlHttpRequest?.(details)
      : surface.xhrSync;
    if (impl === null) return yield* gmUnavailable("GM_xmlhttpRequest");

    return yield* Effect.callback<GmXhrResponse, GmError>((resume) => {
      let handle: GmXhrHandle | undefined;
      let aborted = false;

      const fail = (detail: string) => (): void => {
        resume(
          Effect.fail(
            new GmError({
              reason: "failed",
              api: "GM_xmlhttpRequest",
              detail: `${detail} for ${input.url}`,
            }),
          ),
        );
      };

      const details: GmXhrDetails = {
        method: input.method ?? "GET",
        url: input.url,
        headers: input.headers,
        data: input.data,
        timeout: input.timeoutMs,
        responseType: "text",
        onload: (response) => {
          resume(Effect.succeed(response));
        },
        onerror: fail("network error"),
        ontimeout: fail("timeout"),
        onabort: fail("aborted"),
      };

      const returned: unknown = impl(details);
      if (returned instanceof Promise) {
        returned.then(
          (value: unknown) => {
            handle = (value ?? undefined) as GmXhrHandle | undefined;
            if (aborted) handle?.abort?.();
          },
          (cause: unknown) => {
            resume(Effect.fail(gmFailed("GM_xmlhttpRequest")(cause)));
          },
        );
      } else if (returned !== null && typeof returned === "object") {
        handle = returned as GmXhrHandle;
      }

      return Effect.sync(() => {
        aborted = true;
        handle?.abort?.();
      });
    });
  });

  const registerMenuCommand = (
    caption: string,
    onClick: Effect.Effect<void>,
  ): Effect.Effect<void, GmError> => {
    const register = surface.registerMenuCommand ??
      (ns?.registerMenuCommand
        ? (text: string, callback: () => void) => {
          ns.registerMenuCommand?.(text, callback);
          return 0;
        }
        : null);
    if (register === null) {
      return Effect.fail(gmUnavailable("GM_registerMenuCommand"));
    }
    return gmAttempt("GM_registerMenuCommand", () => {
      register(caption, () => {
        Effect.runFork(onClick);
      });
    });
  };

  const closeWindow = Effect.suspend(() => {
    const close = surface.windowClose;
    if (close === null) return Effect.fail(gmUnavailable("window.close"));
    return gmAttempt("window.close", close);
  });

  return Gm.of({
    identity: readIdentity(surface.info),
    info: surface.info,
    values: Option.orElse(
      // The async form is preferred on purpose. It is the only one on quoid,
      // which is the capability floor, and preferring it everywhere gives the
      // start path the same timing on every manager.
      asyncValueApi(surface),
      () => syncValueApi(surface),
    ),
    hasUnsafeWindow: surface.hasUnsafeWindow,
    canOpenInTab: ns?.openInTab !== undefined || surface.openInTabSync !== null,
    canSetClipboard: ns?.setClipboard !== undefined ||
      surface.setClipboardSync !== null,
    canRequest: ns?.xmlHttpRequest !== undefined || surface.xhrSync !== null,
    canRegisterMenuCommand: ns?.registerMenuCommand !== undefined ||
      surface.registerMenuCommand !== null,
    canCloseWindow: surface.windowClose !== null,
    canAddStyle: surface.addStyle !== null,
    openInTab,
    setClipboard,
    request,
    registerMenuCommand,
    closeWindow,
  });
};

export type { GmSurface };
