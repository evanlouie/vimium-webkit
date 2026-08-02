/**
 * The browser, as a service.
 *
 * A userscript shares its realm with the page, with the manager that injected
 * it, and with every other extension. Any of them can replace a global with an
 * accessor, and an accessor can *throw* where an absent API only gives
 * `undefined`. A `typeof` guard does not survive that, and `?.` does not
 * either, because both still do the read. Only a `try` does.
 *
 * Therefore every read of a global that we do not own goes through `probe`
 * here, and every listener is a scoped resource. When the runtime scope closes,
 * every listener goes with it. No module keeps a list of things to remove.
 */

import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Schema,
  type Scope,
  Stream,
} from "effect";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const DomFailureReason = Schema.Literals([
  /** The API is not in this realm. */
  "missing",
  /** The API is present, and it threw. */
  "denied",
]);

export type DomFailureReason = typeof DomFailureReason.Type;

export class DomError extends Schema.TaggedErrorClass<DomError>()("DomError", {
  reason: DomFailureReason,
  api: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// ---------------------------------------------------------------------------
// Event targets
// ---------------------------------------------------------------------------

/**
 * Maps a target type to the events that it can give.
 *
 * The three maps cover every listener in this application. A target that is not
 * one of these uses `listenOn`, which gives a plain `Event`.
 */
export interface TargetEventMap {
  readonly window: WindowEventMap;
  readonly document: DocumentEventMap;
  readonly element: HTMLElementEventMap;
}

export interface ListenOptions {
  /** Capture phase. Necessary when the page also listens for the same event. */
  readonly capture?: boolean;
  readonly passive?: boolean;
  readonly once?: boolean;
}

/**
 * A listener body.
 *
 * It gives back an `Effect`, not `void`. The effect runs to completion inside
 * the browser's own dispatch, so `preventDefault` still works. Read
 * `ARCHITECTURE.md` section 3 before you put anything that suspends in here.
 */
export type Listener<Event, R> = (
  event: Event,
) => Effect.Effect<void, never, R>;

const toAddOptions = (
  options: ListenOptions | undefined,
): AddEventListenerOptions => ({
  capture: options?.capture ?? false,
  ...(options?.passive === undefined ? {} : { passive: options.passive }),
  ...(options?.once === undefined ? {} : { once: options.once }),
});

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Dom extends Context.Service<Dom, {
  /** This frame's global object. Use it instead of a bare `globalThis`. */
  readonly window: Window & typeof globalThis;
  readonly document: Document;

  /** The URL of this frame. A read, because a soft navigation changes it. */
  readonly href: Effect.Effect<string>;

  /**
   * Read a global that this realm may have poisoned.
   *
   * The failure says which API, so a caller can name it to the user.
   */
  readonly probe: <A>(
    api: string,
    read: () => A,
  ) => Effect.Effect<A, DomError>;

  /** The same read, with a value for "absent" and for "we could not tell". */
  readonly probeOr: <A>(read: () => A, fallback: A) => Effect.Effect<A>;

  /** Run a synchronous DOM call, and name the failure if it throws. */
  readonly attempt: <A>(
    api: string,
    run: () => A,
  ) => Effect.Effect<A, DomError>;

  /**
   * Listen on `window`, `document` or an element, for the enclosing scope.
   *
   * The handler runs synchronously, inside the browser's dispatch. That is what
   * lets a key handler call `preventDefault`.
   */
  readonly listen: <
    K extends keyof TargetEventMap,
    T extends keyof TargetEventMap[K],
    R,
  >(
    target: K,
    type: T,
    handler: Listener<TargetEventMap[K][T], R>,
    options?: ListenOptions,
  ) => Effect.Effect<void, never, R | Scope.Scope>;

  /** Listen on any other target. The event is not narrowed. */
  readonly listenOn: <R>(
    target: EventTarget,
    type: string,
    handler: Listener<Event, R>,
    options?: ListenOptions,
  ) => Effect.Effect<void, never, R | Scope.Scope>;

  /** The same events as a stream, for work that may suspend. */
  readonly events: <
    K extends keyof TargetEventMap,
    T extends keyof TargetEventMap[K],
  >(
    target: K,
    type: T,
    options?: ListenOptions,
  ) => Stream.Stream<TargetEventMap[K][T]>;

  /** Resolves on the next animation frame, with its timestamp. */
  readonly nextFrame: Effect.Effect<number>;

  /**
   * Give control back to the browser.
   *
   * A `MessageChannel`, not a timer. Every engine clamps a nested timeout to
   * 4 ms, which triples the cost of work that takes many slices.
   */
  readonly yieldToBrowser: Effect.Effect<void>;

  /** A monotonic clock reading in milliseconds. */
  readonly now: Effect.Effect<number>;
}>()("vimium/platform/Dom") {
  static readonly layer: Layer.Layer<Dom> = Layer.effect(
    Dom,
    Effect.gen(function*() {
      const services = yield* Effect.context<never>();
      const win = globalThis as unknown as Window & typeof globalThis;
      const doc = win.document;

      const probeOr = <A>(read: () => A, fallback: A): Effect.Effect<A> =>
        Effect.sync(() => {
          try {
            return read();
          } catch {
            return fallback;
          }
        });

      const probe = <A>(
        api: string,
        read: () => A,
      ): Effect.Effect<A, DomError> =>
        Effect.try({
          try: read,
          catch: (cause) =>
            new DomError({
              reason: "denied",
              api,
              detail: describe(cause),
              cause,
            }),
        });

      const resolveTarget = (name: keyof TargetEventMap): EventTarget =>
        name === "document" ? doc : win;

      /**
       * Attach one listener, and detach it when the scope closes.
       *
       * The handler is run with `runSyncExitWith`, so the whole of it happens
       * before the browser continues its dispatch. A failure becomes an `Exit`,
       * never a throw into page code: a throw inside a listener is swallowed by
       * the browser, and silence is the worse outcome.
       */
      const attach = <A extends Event, R>(
        target: EventTarget,
        type: string,
        handler: Listener<A, R>,
        options: ListenOptions | undefined,
      ): Effect.Effect<void, never, R | Scope.Scope> =>
        Effect.gen(function*() {
          const handlerServices = yield* Effect.context<R>();
          const run = Effect.runSyncExitWith(
            Context.merge(services, handlerServices),
          );
          const listen = (event: Event): void => {
            const exit = run(handler(event as A));
            if (Exit.isFailure(exit)) reportListenerFailure(type, exit.cause);
          };
          const addOptions = toAddOptions(options);
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              target.addEventListener(type, listen, addOptions);
            }),
            () =>
              Effect.sync(() => {
                target.removeEventListener(type, listen, addOptions);
              }),
          );
        });

      return Dom.of({
        window: win,
        document: doc,
        href: Effect.sync(() => win.location.href),
        probe,
        probeOr,
        attempt: probe,

        listen: (target, type, handler, options) =>
          attach(
            resolveTarget(target),
            String(type),
            handler as Listener<Event, never>,
            options,
          ),

        listenOn: (target, type, handler, options) =>
          attach(target, type, handler, options),

        events: (target, type, options) =>
          Stream.fromEventListener(
            resolveTarget(target),
            String(type),
            toAddOptions(options),
          ) as Stream.Stream<never>,

        nextFrame: Effect.callback<number>((resume) => {
          const handle = win.requestAnimationFrame((time) => {
            resume(Effect.succeed(time));
          });
          return Effect.sync(() => {
            win.cancelAnimationFrame(handle);
          });
        }),

        yieldToBrowser: Effect.callback<void>((resume) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            channel.port1.close();
            resume(Effect.void);
          };
          channel.port2.postMessage(null);
          return Effect.sync(() => {
            channel.port1.close();
            channel.port2.close();
          });
        }),

        now: Effect.sync(() =>
          typeof performance === "undefined" ? Date.now() : performance.now()
        ),
      });
    }),
  );
}

/**
 * A listener body must not fail. If it does, the fault is ours.
 *
 * `console.error` and not a logger, because this can run before the logger
 * exists, and because a userscript shares its console with the page.
 */
const reportListenerFailure = (
  type: string,
  cause: Cause.Cause<never>,
): void => {
  console.error(
    `[vimium-webkit] the ${type} listener failed`,
    Cause.pretty(cause),
  );
};

const describe = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
};
