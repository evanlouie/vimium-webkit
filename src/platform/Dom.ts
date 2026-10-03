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
  Boolean,
  type Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Match,
  Result,
  Schema,
  type Scope,
  Stream,
  pipe,
} from "effect";
import { constVoid } from "effect/Function";
import { describeCause, describeThrown } from "~/domain/Failure.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A DOM call that threw. `api` names the call, so a caller can name it to the user. */
export class DomError extends Schema.TaggedError<DomError>()("DomError", {
  api: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// ---------------------------------------------------------------------------
// Event targets
// ---------------------------------------------------------------------------

/**
 * Maps a global of this frame to the events that it can give.
 *
 * Any other target uses `listenOn`.
 */
export interface TargetEventMap {
  readonly window: WindowEventMap;
  readonly document: DocumentEventMap;
}

/**
 * Maps the event types of a `MessagePort` to the events that it gives.
 *
 * The payload is `unknown`, and not the `any` of the DOM types. The page can
 * hold a copy of a port, so a message on it can carry anything.
 */
export interface PortEventMap {
  readonly message: MessageEvent<unknown>;
  readonly messageerror: MessageEvent<unknown>;
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
export type Listener<Event, R> = (event: Event) => Effect.Effect<void, never, R>;

/**
 * The options that the browser reads. An `undefined` member of the dictionary
 * counts as absent, so `passive` keeps the default of the browser.
 */
const toAddOptions = (options: ListenOptions = {}): AddEventListenerOptions => ({
  capture: options.capture ?? false,
  passive: options.passive,
  once: options.once,
});

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Dom extends Context.Service<
  Dom,
  {
    /** This frame's global object. Use it instead of a bare `globalThis`. */
    readonly window: Window & typeof globalThis;
    readonly document: Document;

    /** The URL of this frame. A read, because a soft navigation changes it. */
    readonly href: Effect.Effect<string>;

    /** The visibility of this frame's document. A read, because the user can hide the tab. */
    readonly visibility: Effect.Effect<DocumentVisibilityState>;

    /**
     * Read a global that this realm may have poisoned.
     *
     * The failure says which API, so a caller can name it to the user.
     */
    readonly probe: <A>(api: string, read: () => A) => Effect.Effect<A, DomError>;

    /**
     * The same read, with a fallback for "absent" and for "we could not tell".
     *
     * The fallback runs only when the read throws, so it can do work of its own.
     */
    readonly probeOrElse: <A>(read: () => A, orElse: () => A) => Effect.Effect<A>;

    /** Run a synchronous DOM call, and name the failure if it throws. */
    readonly attempt: <A>(api: string, run: () => A) => Effect.Effect<A, DomError>;

    /**
     * Listen on `window` or `document`, for the enclosing scope.
     *
     * The handler runs synchronously, inside the browser's dispatch. That is what
     * lets a key handler call `preventDefault`.
     */
    readonly listen: <K extends keyof TargetEventMap, T extends keyof TargetEventMap[K], R>(
      target: K,
      type: T,
      handler: Listener<TargetEventMap[K][T], R>,
      options?: ListenOptions,
    ) => Effect.Effect<void, never, R | Scope.Scope>;

    /**
     * Listen on any other target, for the enclosing scope.
     *
     * The event map of the target narrows the event. A port gives a
     * `MessageEvent`, and an element gives the event of its type, such as a
     * `MouseEvent` for `mousedown`. Any other target gives a plain `Event`.
     */
    readonly listenOn: {
      <T extends keyof PortEventMap, R>(
        target: MessagePort,
        type: T,
        handler: Listener<PortEventMap[T], R>,
        options?: ListenOptions,
      ): Effect.Effect<void, never, R | Scope.Scope>;
      <T extends keyof HTMLElementEventMap, R>(
        target: HTMLElement,
        type: T,
        handler: Listener<HTMLElementEventMap[T], R>,
        options?: ListenOptions,
      ): Effect.Effect<void, never, R | Scope.Scope>;
      <R>(
        target: EventTarget,
        type: string,
        handler: Listener<Event, R>,
        options?: ListenOptions,
      ): Effect.Effect<void, never, R | Scope.Scope>;
    };

    /** The same events as a stream, for work that may suspend. */
    readonly events: <K extends keyof TargetEventMap, T extends keyof TargetEventMap[K]>(
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
  }
>()("vimium/platform/Dom") {
  static readonly layer: Layer.Layer<Dom> = Layer.effect(
    Dom,
    Effect.gen(function* () {
      const services = yield* Effect.context<never>();
      // `globalThis` is the `Window` of this frame. The DOM types declare the
      // global `name` as `void`, so they cannot see the global scope as a
      // `Window`, and no runtime check can prove it either. This one assertion
      // says what the realm is.
      const win = globalThis as Window & typeof globalThis;
      const doc = win.document;

      const probeOrElse = <A>(read: () => A, orElse: () => A): Effect.Effect<A> =>
        Effect.sync(() => pipe(Result.try(read), Result.getOrElse(orElse)));

      const probe = <A>(api: string, read: () => A): Effect.Effect<A, DomError> =>
        Effect.try({
          try: read,
          catch: (cause) =>
            new DomError({
              api,
              detail: describeThrown(cause),
              cause,
            }),
        });

      const resolveTarget = (name: keyof TargetEventMap): EventTarget =>
        pipe(
          Match.value(name),
          Match.when("document", (): EventTarget => doc),
          Match.when("window", (): EventTarget => win),
          Match.exhaustive,
        );

      /**
       * Attach one listener, and detach it when the scope closes.
       *
       * The handler is run with `runSyncExitWith`, so the whole of it happens
       * before the browser continues its dispatch. A failure becomes an `Exit`,
       * never a throw into page code: a throw inside a listener is swallowed by
       * the browser, and silence is the worse outcome.
       */
      const attach = Effect.fnUntraced(function* <E, R>(
        target: EventTarget,
        type: string,
        handler: Listener<E, R>,
        options?: ListenOptions,
      ) {
        const handlerServices = yield* Effect.context<R>();
        const run = Effect.runSyncExitWith(Context.merge(services, handlerServices));
        const listen = (event: Event): void =>
          pipe(
            // The browser gives a plain `Event`. Only the DOM types tie a
            // target and an event name to an event type, so the target and
            // the name that `listen` or `listenOn` took are the evidence, and
            // this assertion is where they become the type.
            event as E,
            handler,
            run,
            Exit.match({
              onSuccess: constVoid,
              onFailure: (cause) => reportListenerFailure(type, cause),
            }),
          );
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
        visibility: Effect.sync(() => doc.visibilityState),
        probe,
        probeOrElse,
        attempt: probe,

        listen: (target, type, handler, options) =>
          attach(resolveTarget(target), String(type), handler, options),

        listenOn: attach,

        events: <K extends keyof TargetEventMap, T extends keyof TargetEventMap[K]>(
          target: K,
          type: T,
          options?: ListenOptions,
        ) =>
          Stream.fromEventListener<TargetEventMap[K][T]>(
            resolveTarget(target),
            String(type),
            toAddOptions(options),
          ),

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

        now: Effect.sync(readClock),
      });
    }),
  );
}

/**
 * A monotonic clock where the realm has one, and the wall clock otherwise.
 *
 * The question is asked at each read, because the page can replace
 * `performance` at any time.
 */
const readClock = (): number =>
  pipe(
    typeof performance === "undefined",
    Boolean.match({ onFalse: () => performance.now(), onTrue: () => Date.now() }),
  );

/**
 * A listener body must not fail. If it does, the fault is ours.
 *
 * `console.error` and not a logger, because this can run before the logger
 * exists, and because a userscript shares its console with the page. The
 * console therefore gets the text of the first failure, and not the whole
 * cause.
 */
const reportListenerFailure = (type: string, cause: Cause.Cause<never>): void => {
  console.error(`[vimium-webkit] the ${type} listener failed`, describeCause(cause));
};
