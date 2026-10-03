/**
 * The one gate to the userscript manager.
 *
 * No other file may name a `GM` or `GM_*` identifier.
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

import {
  Boolean,
  Context,
  Data,
  Effect,
  Layer,
  MutableRef,
  Option,
  Predicate,
  Queue,
  Result,
  Schema,
  Stream,
  pipe,
} from "effect";
import { constVoid, flow } from "effect/Function";
import { describeThrown } from "~/domain/Failure.ts";
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

export class GmError extends Schema.TaggedError<GmError>()("GmError", {
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

const gmFailed =
  (api: string) =>
  (cause: unknown): GmError =>
    new GmError({ reason: "failed", api, detail: describeThrown(cause), cause });

/**
 * Run a synchronous manager call.
 *
 * Synchronous by design. `Effect.try` does not suspend, so a call from inside a
 * key handler still runs inside the browser's activation window. That is the
 * only reason `setClipboard` works.
 */
export const gmAttempt = <A>(api: string, run: () => A): Effect.Effect<A, GmError> =>
  Effect.try({ try: run, catch: gmFailed(api) });

/** Run an asynchronous manager call. This suspends. Keep it off the key path. */
export const gmAttemptAsync = <A>(api: string, run: () => Promise<A>): Effect.Effect<A, GmError> =>
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
type RemoveValueChangeListener = (listenerId: string | number) => void;
type RegisterMenuCommand = (
  caption: string,
  onClick: () => void,
  accessKey?: string,
) => string | number;

/** Every binding of the manager that this module can use. `None` is an absent binding. */
interface GmSurface {
  readonly namespace: Option.Option<GmNamespace>;
  readonly info: unknown;
  readonly getValueSync: Option.Option<SyncGetValue>;
  readonly setValueSync: Option.Option<SyncSetValue>;
  readonly deleteValueSync: Option.Option<SyncDeleteValue>;
  readonly openInTabSync: Option.Option<OpenInTabSync>;
  readonly setClipboardSync: Option.Option<SetClipboardSync>;
  readonly xhrSync: Option.Option<XhrSync>;
  readonly addValueChangeListener: Option.Option<AddValueChangeListener>;
  readonly removeValueChangeListener: Option.Option<RemoveValueChangeListener>;
  readonly registerMenuCommand: Option.Option<RegisterMenuCommand>;
  readonly addStyle: Option.Option<(css: string) => unknown>;
  readonly hasUnsafeWindow: boolean;
  readonly windowClose: Option.Option<() => void>;
}

/** Read a binding that may throw, and give `fallback` when it does. */
const probeOr = <A>(read: () => A, fallback: A): A =>
  pipe(
    Result.try(read),
    Result.getOrElse(() => fallback),
  );

/**
 * A binding that the manager may not declare.
 *
 * `kind` gives the `typeof` of the binding, and the binding is read only when
 * that is `expected`. A nullish binding and a read that throws both give `None`.
 */
const binding = <A>(
  kind: () => string,
  expected: string,
  read: () => A | null | undefined,
): Option.Option<A> =>
  probeOr(
    () =>
      pipe(
        kind(),
        Option.liftPredicate((actual) => actual === expected),
        Option.flatMapNullishOr(read),
      ),
    Option.none(),
  );

/** A manager function, when the manager declares one. */
const callable = <A>(kind: () => string, read: () => A): Option.Option<A> =>
  binding(kind, "function", read);

const detectSurface = (): GmSurface => {
  // `typeof null` is `"object"` too, and `binding` gives `None` for it.
  const namespace = binding(
    () => typeof GM,
    "object",
    () => GM,
  );

  return {
    namespace,
    info: probeOr(
      () =>
        pipe(
          typeof GM_info,
          Option.liftPredicate((kind) => kind !== "undefined"),
          Option.map((): unknown => GM_info),
          Option.orElse(() =>
            pipe(
              namespace,
              Option.flatMapNullishOr((ns) => ns.info),
            ),
          ),
          Option.getOrNull,
        ),
      null,
    ),
    getValueSync: callable(
      () => typeof GM_getValue,
      () => GM_getValue,
    ),
    setValueSync: callable(
      () => typeof GM_setValue,
      () => GM_setValue,
    ),
    deleteValueSync: callable(
      () => typeof GM_deleteValue,
      () => GM_deleteValue,
    ),
    openInTabSync: callable(
      () => typeof GM_openInTab,
      () => GM_openInTab,
    ),
    setClipboardSync: callable(
      () => typeof GM_setClipboard,
      () => GM_setClipboard,
    ),
    xhrSync: callable(
      () => typeof GM_xmlhttpRequest,
      () => GM_xmlhttpRequest,
    ),
    addValueChangeListener: callable(
      () => typeof GM_addValueChangeListener,
      () => GM_addValueChangeListener,
    ),
    // Not in the compatibility floor, so a manager can watch values and still
    // have no way to stop.
    removeValueChangeListener: callable(
      () => typeof GM_removeValueChangeListener,
      () => GM_removeValueChangeListener,
    ),
    registerMenuCommand: callable(
      () => typeof GM_registerMenuCommand,
      () => GM_registerMenuCommand,
    ),
    addStyle: callable(
      () => typeof GM_addStyle,
      () => GM_addStyle,
    ),
    hasUnsafeWindow: probeOr(
      () => typeof unsafeWindow !== "undefined" && unsafeWindow !== undefined,
      false,
    ),
    // `window.close()` works from a userscript only when the manager honoured
    // `@grant window.close`. Violentmonkey and Tampermonkey do. Others do not,
    // and there is no way to tell "granted" from "silently does nothing".
    windowClose: callable(
      () => typeof globalThis.close,
      () => (): void => {
        globalThis.close();
      },
    ),
  };
};

// ---------------------------------------------------------------------------
// Manager identity
// ---------------------------------------------------------------------------

export interface ManagerIdentity {
  readonly handler: Option.Option<string>;
  readonly handlerVersion: Option.Option<string>;
  readonly scriptVersion: Option.Option<string>;
  readonly injectInto: Option.Option<string>;
  readonly sandboxMode: Option.Option<string>;
}

/** A property of a value that the manager gave, when that value is an object. */
const propertyOf =
  (key: string) =>
  (source: unknown): Option.Option<unknown> =>
    pipe(
      source,
      Option.liftPredicate(Predicate.isObjectOrArray),
      Option.map((object): unknown => Reflect.get(object, key)),
    );

/** A string property of a value that the manager gave. */
const stringOf = (key: string) => flow(propertyOf(key), Option.filter(Predicate.isString));

/** For a bug report only. Never take a decision from this. Probe instead. */
const readIdentity = (info: unknown): ManagerIdentity => {
  const script = pipe(info, propertyOf("script"));
  const ofScript = (key: string): Option.Option<string> =>
    pipe(script, Option.flatMap(stringOf(key)));
  return {
    handler: pipe(info, stringOf("scriptHandler")),
    handlerVersion: pipe(info, stringOf("version")),
    scriptVersion: ofScript("version"),
    injectInto: pipe(
      info,
      stringOf("injectInto"),
      Option.orElse(() => ofScript("injectInto")),
    ),
    sandboxMode: pipe(info, stringOf("sandboxMode")),
  };
};

// ---------------------------------------------------------------------------
// The value API
// ---------------------------------------------------------------------------

/** The calls that every value API gives. */
type GmValueCalls = {
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, GmError>;
  readonly set: (key: string, value: string) => Effect.Effect<void, GmError>;
  readonly remove: (key: string) => Effect.Effect<void, GmError>;
};

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
export type GmValueApi = Data.TaggedEnum<{
  /** The promise form, `GM.getValue` and the rest. */
  Async: GmValueCalls;
  /** The synchronous form, `GM_getValue` and the rest. */
  Sync: GmValueCalls & {
    /** The write of `set`, as a plain call that completes before it returns. */
    readonly setUnsafe: (key: string, value: string) => void;
    /** Changes made in another tab. `None` when the manager has no such API. */
    readonly changes: Option.Option<(key: string) => Stream.Stream<Option.Option<string>>>;
  };
}>;

export const GmValueApi = Data.taggedEnum<GmValueApi>();

/** A stored value as text. A manager that gives another primitive gives its text. */
const asOption = (value: GmValue | undefined): Option.Option<string> =>
  pipe(value, Option.fromNullishOr, Option.map(String));

const asyncValueApi = (surface: GmSurface): Option.Option<GmValueApi> =>
  pipe(
    surface.namespace,
    Option.flatMap((ns) =>
      Option.all({
        getValue: Option.fromNullishOr(ns.getValue),
        setValue: Option.fromNullishOr(ns.setValue),
        deleteValue: Option.fromNullishOr(ns.deleteValue),
      }),
    ),
    Option.map(({ getValue, setValue, deleteValue }) =>
      GmValueApi.Async({
        get: (key) => gmAttemptAsync("GM.getValue", () => getValue(key).then(asOption)),
        set: (key, value) => gmAttemptAsync("GM.setValue", () => setValue(key, value)),
        remove: (key) => gmAttemptAsync("GM.deleteValue", () => deleteValue(key)),
      }),
    ),
  );

/**
 * Remove a value listener, as far as the manager allows.
 *
 * Not in the compatibility floor, so this is best effort. A listener that stays
 * is better than a throw during teardown.
 */
const stopWatching = (
  unwatch: Option.Option<RemoveValueChangeListener>,
  id: string | number,
): Effect.Effect<void> =>
  pipe(
    unwatch,
    Option.match({
      onNone: () => Effect.void,
      onSome: (remove) =>
        pipe(
          Effect.try(() => remove(id)),
          Effect.ignore,
        ),
    }),
  );

/**
 * The values that another tab writes to one key, for the life of the stream.
 *
 * The manager also calls the listener for a write of this tab, with `remote`
 * false. That echo is dropped: the writer already holds the value, and an echo
 * that arrives late could publish an older value over a newer one. A manager
 * that leaves the flag out is read as reporting another tab.
 */
const watchValue =
  (watch: AddValueChangeListener, unwatch: Option.Option<RemoveValueChangeListener>) =>
  (key: string): Stream.Stream<Option.Option<string>> =>
    Stream.callback<Option.Option<string>>((queue) => {
      const listen = Effect.sync(() =>
        watch(key, (_name, _old, next, remote) =>
          pipe(
            remote === false,
            Boolean.match({
              onFalse: () => {
                Queue.offerUnsafe(queue, asOption(next));
              },
              onTrue: constVoid,
            }),
          ),
        ),
      );
      return Effect.acquireRelease(listen, (id) => stopWatching(unwatch, id));
    });

const syncValueApi = (surface: GmSurface): Option.Option<GmValueApi> =>
  pipe(
    Option.all({
      getValue: surface.getValueSync,
      setValue: surface.setValueSync,
      deleteValue: surface.deleteValueSync,
    }),
    Option.map(({ getValue, setValue, deleteValue }) =>
      GmValueApi.Sync({
        get: (key) => gmAttempt("GM_getValue", () => asOption(getValue(key))),
        set: (key, value) =>
          gmAttempt("GM_setValue", () => {
            setValue(key, value);
          }),
        remove: (key) =>
          gmAttempt("GM_deleteValue", () => {
            deleteValue(key);
          }),
        setUnsafe: (key, value) => {
          setValue(key, value);
        },
        changes: pipe(
          surface.addValueChangeListener,
          Option.map((watch) => watchValue(watch, surface.removeValueChangeListener)),
        ),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tabs, clipboard and network
// ---------------------------------------------------------------------------

/** How a tab was opened. */
export type OpenInTabResult = Data.TaggedEnum<{
  /** The manager opened it. Some managers give a handle that can close it. */
  Manager: { readonly handle: Option.Option<GmTabHandle> };
  /** The manager had no API, and `window.open` was used. */
  Window: Record<never, never>;
}>;

export const OpenInTabResult = Data.taggedEnum<OpenInTabResult>();

export interface XhrRequest {
  readonly url: string;
  readonly method?: "GET" | "POST" | "HEAD";
  readonly headers?: Readonly<Record<string, string>>;
  readonly data?: string;
  readonly timeoutMs?: number;
}

/**
 * A response of the manager, as `request` gives it.
 *
 * A manager may leave `responseText` out. No reader can tell an absent text
 * from an empty body, so the text is `""` then.
 */
export interface XhrResponse {
  readonly readyState: number;
  readonly status: number;
  readonly statusText: string;
  readonly responseHeaders: string;
  readonly responseText: string;
}

const toXhrResponse = (response: GmXhrResponse): XhrResponse => ({
  readyState: response.readyState,
  status: response.status,
  statusText: response.statusText,
  responseHeaders: response.responseHeaders,
  responseText: response.responseText ?? "",
});

type XhrSend = (
  details: GmXhrDetails,
) => GmXhrHandle | undefined | Promise<GmXhrHandle | undefined>;

/** What an interrupt of a request can reach. */
type XhrLink = Data.TaggedEnum<{
  /** The manager has given no handle yet. */
  Waiting: Record<never, never>;
  /** The manager gave a handle, and the request can be aborted through it. */
  Attached: { readonly handle: GmXhrHandle };
  /** The caller stopped waiting. A handle that arrives now is aborted at once. */
  Cancelled: Record<never, never>;
}>;

const XhrLink = Data.taggedEnum<XhrLink>();

const abortRequest = (handle: GmXhrHandle): void =>
  pipe(
    handle.abort,
    Option.fromNullishOr,
    Option.match({
      onNone: constVoid,
      onSome: (abort) => {
        abort.call(handle);
      },
    }),
  );

/** A handle arrives. It is kept, or aborted when the caller already stopped waiting. */
const attachRequest = (
  link: MutableRef.MutableRef<XhrLink>,
  arrived: Option.Option<GmXhrHandle>,
): void =>
  pipe(
    arrived,
    Option.match({
      onNone: constVoid,
      onSome: (handle) => {
        const keep = (): void => {
          pipe(link, MutableRef.set<XhrLink>(XhrLink.Attached({ handle })));
        };
        return pipe(
          MutableRef.get(link),
          XhrLink.$match({
            Waiting: keep,
            Attached: keep,
            Cancelled: () => abortRequest(handle),
          }),
        );
      },
    }),
  );

const cancelRequest = flow(
  MutableRef.getAndSet<XhrLink>(XhrLink.Cancelled()),
  XhrLink.$match({
    Waiting: constVoid,
    Attached: ({ handle }) => abortRequest(handle),
    Cancelled: constVoid,
  }),
);

/** A handle that the manager gave at once, and not the promise of one. */
const isImmediateHandle = (returned: ReturnType<XhrSend>): returned is GmXhrHandle =>
  typeof returned === "object" && returned !== null && !Predicate.isPromise(returned);

/**
 * Start one request, and give the effect that aborts it.
 *
 * A manager can give the handle at once, give it later through a promise, or
 * give none at all.
 */
const startRequest = (
  send: XhrSend,
  input: XhrRequest,
  resume: (effect: Effect.Effect<GmXhrResponse, GmError>) => void,
): Effect.Effect<void> => {
  const link = MutableRef.make<XhrLink>(XhrLink.Waiting());

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

  const returned = send(details);
  const immediate = pipe(returned, Option.liftPredicate(isImmediateHandle));
  attachRequest(link, immediate);
  pipe(
    returned,
    Option.liftPredicate(Predicate.isPromise),
    Option.match({
      onNone: constVoid,
      onSome: (pending) => {
        pending.then(
          (handle) => attachRequest(link, Option.fromNullishOr(handle)),
          (cause: unknown) => {
            resume(Effect.fail(gmFailed("GM_xmlhttpRequest")(cause)));
          },
        );
      },
    }),
  );

  return Effect.sync(() => cancelRequest(link));
};

type TabOpener = (
  url: string,
  options: GmOpenInTabOptions,
) => Effect.Effect<OpenInTabResult, GmError>;

const openedByManager = (handle: GmTabHandle | undefined): OpenInTabResult =>
  OpenInTabResult.Manager({ handle: Option.fromNullishOr(handle) });

/** `GM.openInTab`. Some managers give the handle through a promise. */
const namespaceOpener =
  (open: NonNullable<GmNamespace["openInTab"]>): TabOpener =>
  (url, options) =>
    pipe(
      gmAttemptAsync("GM.openInTab", async () => open(url, options)),
      Effect.map(openedByManager),
    );

/** `GM_openInTab`, which gives the handle at once. */
const syncOpener =
  (open: OpenInTabSync): TabOpener =>
  (url, options) =>
    pipe(
      gmAttempt("GM_openInTab", () => open(url, options)),
      Effect.map(openedByManager),
    );

/** A rejection that nobody waits for must not become an unhandled rejection. */
const detachRejection = (result: unknown): void =>
  pipe(
    result,
    Option.liftPredicate(Predicate.isPromise),
    Option.match({
      onNone: constVoid,
      onSome: (promise) => {
        promise.catch(constVoid);
      },
    }),
  );

type ClipboardWrite = (text: string) => Effect.Effect<void, GmError>;

/**
 * `GM.setClipboard`.
 *
 * Some managers give a promise. We do not wait for it: the caller is inside an
 * activation-sensitive synchronous task.
 */
const namespaceClipboard =
  (write: NonNullable<GmNamespace["setClipboard"]>): ClipboardWrite =>
  (text) =>
    gmAttempt("GM.setClipboard", () => detachRejection(write(text, "text/plain")));

const syncClipboard =
  (write: SetClipboardSync): ClipboardWrite =>
  (text) =>
    gmAttempt("GM_setClipboard", () => write(text, "text/plain"));

/** `GM.xmlHttpRequest`, called on its namespace. */
const namespaceRequest = (ns: GmNamespace): Option.Option<XhrSend> =>
  pipe(
    ns.xmlHttpRequest,
    Option.fromNullishOr,
    Option.map(
      (send): XhrSend =>
        (details) =>
          send.call(ns, details),
    ),
  );

type MenuRegister = (caption: string, onClick: () => void) => unknown;

/** `GM.registerMenuCommand`, called on its namespace. */
const namespaceMenu = (ns: GmNamespace): Option.Option<MenuRegister> =>
  pipe(
    ns.registerMenuCommand,
    Option.fromNullishOr,
    Option.map(
      (add): MenuRegister =>
        (caption, onClick) =>
          add.call(ns, caption, onClick),
    ),
  );

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Gm extends Context.Service<
  Gm,
  {
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
    readonly request: (request: XhrRequest) => Effect.Effect<XhrResponse, GmError>;

    /** Add a menu entry for the life of the enclosing scope. */
    readonly registerMenuCommand: (
      caption: string,
      onClick: Effect.Effect<void>,
    ) => Effect.Effect<void, GmError>;

    /** Close this tab. Only Violentmonkey and Tampermonkey grant this. */
    readonly closeWindow: Effect.Effect<void, GmError>;
  }
>()("vimium/platform/Gm") {
  static readonly layer: Layer.Layer<Gm, never, Dom> = Layer.effect(
    Gm,
    Effect.gen(function* () {
      const dom = yield* Dom;
      return makeGm(detectSurface(), dom);
    }),
  );

  /** A layer over a surface that a test supplies. */
  static readonly layerFrom = (surface: GmSurface): Layer.Layer<Gm, never, Dom> =>
    Layer.effect(
      Gm,
      Effect.gen(function* () {
        const dom = yield* Dom;
        return makeGm(surface, dom);
      }),
    );
}

const makeGm = (surface: GmSurface, dom: Dom["Service"]): Gm["Service"] => {
  /** A member of the `GM.*` namespace, when the manager gives both. */
  const member = <A>(read: (ns: GmNamespace) => A | null | undefined): Option.Option<A> =>
    pipe(surface.namespace, Option.flatMapNullishOr(read));

  const managerOpen: Option.Option<TabOpener> = pipe(
    member((ns) => ns.openInTab),
    Option.map(namespaceOpener),
    Option.orElse(() => pipe(surface.openInTabSync, Option.map(syncOpener))),
  );

  const windowOpen = (url: string): Effect.Effect<OpenInTabResult, GmError> =>
    pipe(
      gmAttempt("window.open", () => dom.window.open(url, "_blank", "noopener,noreferrer")),
      Effect.filterOrFail(Predicate.isNotNull, () =>
        gmFailed("window.open")(new Error("window.open was blocked (no transient activation?)")),
      ),
      Effect.as(OpenInTabResult.Window()),
    );

  const openTab = pipe(
    managerOpen,
    Option.getOrElse(() => windowOpen),
  );

  const openInTab = Effect.fn("Gm.openInTab")(function* (url: string, options: GmOpenInTabOptions) {
    return yield* openTab(url, options);
  });

  const clipboardWrite: Option.Option<ClipboardWrite> = pipe(
    member((ns) => ns.setClipboard),
    Option.map(namespaceClipboard),
    Option.orElse(() => pipe(surface.setClipboardSync, Option.map(syncClipboard))),
  );

  const setClipboard = pipe(
    clipboardWrite,
    Option.getOrElse((): ClipboardWrite => () => Effect.fail(gmUnavailable("GM_setClipboard"))),
  );

  const send: Option.Option<XhrSend> = pipe(
    surface.namespace,
    Option.flatMap(namespaceRequest),
    Option.orElse(() => surface.xhrSync),
  );

  const request = Effect.fn("Gm.request")(function* (input: XhrRequest) {
    const start = yield* pipe(
      send,
      Effect.fromOption(() => gmUnavailable("GM_xmlhttpRequest")),
    );
    const response = yield* Effect.callback<GmXhrResponse, GmError>((resume) =>
      startRequest(start, input, resume),
    );
    return toXhrResponse(response);
  });

  const register: Option.Option<MenuRegister> = pipe(
    surface.registerMenuCommand,
    Option.orElse(() => pipe(surface.namespace, Option.flatMap(namespaceMenu))),
  );

  const registerMenuCommand = (
    caption: string,
    onClick: Effect.Effect<void>,
  ): Effect.Effect<void, GmError> =>
    pipe(
      register,
      Option.match({
        onNone: () => Effect.fail(gmUnavailable("GM_registerMenuCommand")),
        onSome: (add) =>
          gmAttempt("GM_registerMenuCommand", () => {
            add(caption, () => {
              Effect.runFork(onClick);
            });
          }),
      }),
    );

  const closeWindow = pipe(
    surface.windowClose,
    Effect.fromOption(() => gmUnavailable("window.close")),
    Effect.flatMap((close) => gmAttempt("window.close", close)),
  );

  return Gm.of({
    identity: readIdentity(surface.info),
    info: surface.info,
    values: pipe(
      surface,
      syncValueApi,
      Option.orElse(
        // Prefer a complete synchronous surface. This changes Stay and other
        // managers that give both forms. Storage debounces the selected kind.
        () => asyncValueApi(surface),
      ),
    ),
    hasUnsafeWindow: surface.hasUnsafeWindow,
    canOpenInTab: Option.isSome(managerOpen),
    canSetClipboard: Option.isSome(clipboardWrite),
    canRequest: Option.isSome(send),
    canRegisterMenuCommand: Option.isSome(register),
    canCloseWindow: Option.isSome(surface.windowClose),
    canAddStyle: Option.isSome(surface.addStyle),
    openInTab,
    setClipboard,
    request,
    registerMenuCommand,
    closeWindow,
  });
};

export type { GmSurface };
