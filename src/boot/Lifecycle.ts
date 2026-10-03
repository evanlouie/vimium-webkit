/**
 * The navigation lifecycle.
 *
 * Two things happen here, and WebKit shapes both:
 *
 * 1. **The back/forward cache.** Safari keeps pages readily, and a restored
 *    page never runs its scripts again. `pagehide` and `pageshow` with the
 *    `persisted` flag are the only correct signals. This project never uses
 *    `unload`: WebKit refuses to cache a page that registers it, and then does
 *    not send it either, which is the worst of both results.
 *
 * 2. **Navigation inside one page.** In the content world we do not share the
 *    page's script realm, so a patch of `history.pushState` does nothing: the
 *    page's own calls go through its own realm. The `navigation` API would
 *    solve this, and Safari does not have it. What is left is `popstate`,
 *    `hashchange`, a sample after a click, and a slow poll as the last
 *    resource. The poll runs only while the document is visible, so a
 *    background tab costs nothing.
 *
 * ## The exit
 *
 * The exit is not an event on the bus. A subscriber reads the bus on its own
 * fiber, and that fiber runs after the browser's dispatch is over. The page can
 * be gone by then. `onExit` therefore takes a hook, and the hook starts inside
 * the dispatch. Four rules decide what a hook may do:
 *
 * 1. **The time budget is one synchronous run.** `pagehide` can give no time to
 *    an asynchronous task. A promise that starts there can stay unsettled for
 *    ever. The Effect scheduler is `setTimeout(f, 0)` in a page, so a fiber
 *    that resumes inside `pagehide` never runs. Work that *must* finish before
 *    the handler returns is work that never suspends. A synchronous backend
 *    gets a direct write. A promise-backed manager gets each write earlier,
 *    through the actor and without a debounce. Work after the first suspension
 *    can be lost. The page lives on after `visibilitychange`, so that exit
 *    loses nothing. See rule 3.
 * 2. **A kept page is not an exit.** `pagehide` with `persisted === true` means
 *    that the page may come back from the back/forward cache. A restored page
 *    never runs its scripts again. The hook therefore gets `Resumable`, and
 *    nothing that must be built again may be released. Only `pagehide` with
 *    `persisted === false` gives `Final`.
 * 3. **`visibilitychange` to `hidden` runs the same hooks.** It is the last
 *    moment that mobile WebKit reliably gives us. A tab that goes to the
 *    background may never see `pagehide`. It is never final: the tab can come
 *    forward again. `unload` is not used at all. WebKit refuses to cache a page
 *    that registers it, and then does not send it either.
 * 4. **A frame exits alone.** This file runs in every frame. Each frame has its
 *    own realm, its own window, its own runtime and its own listeners.
 *    `pagehide` reaches the window of the frame that is going away. "Final page
 *    exit" therefore means "this document will not run again". A child frame
 *    that leaves releases only what that child built, and the top frame keeps
 *    its own runtime.
 */

import {
  Array,
  Boolean,
  Context,
  Data,
  Effect,
  Fiber,
  FiberSet,
  Layer,
  Option,
  PubSub,
  Record,
  Ref,
  Schedule,
  type Scope,
  Stream,
  pipe,
} from "effect";
import { Dom } from "~/platform/Dom.ts";

/** A variant that carries no data. */
type NoFields = Record.ReadonlyRecord<never, never>;

export type LifecycleEvent = Data.TaggedEnum<{
  /** The URL changed with no document load. */
  UrlChange: { readonly url: string; readonly previous: string };
  /** The page came back from the back/forward cache. */
  Restore: NoFields;
  /** The page is going away for good. */
  Leave: NoFields;
  /** The tab is visible again. Read shared storage again. */
  Visible: NoFields;
}>;

export const LifecycleEvent = Data.taggedEnum<LifecycleEvent>();

/**
 * What the browser said when the page went away.
 *
 * One question decides everything: will this document run again? A hidden tab
 * and a page in the back/forward cache both come back, so both are resumable.
 */
export type PageExit = Data.TaggedEnum<{
  /** This document will not run again. */
  Final: NoFields;
  /** This document may run again. */
  Resumable: NoFields;
}>;

export const PageExit = Data.taggedEnum<PageExit>();

/**
 * Work that runs inside the browser's own dispatch.
 *
 * Read rule 1 at the top of this file before you write one. The first part of
 * the hook, up to the first suspension, is the only part that is sure to run.
 */
export type ExitHook = (exit: PageExit) => Effect.Effect<void>;

/**
 * One registration of a hook.
 *
 * The token is the key, and not the function. Two scopes may register the same
 * function reference, and a filter on the reference would remove both. The
 * token is a plain object, so it is equal to itself only.
 */
interface Registration {
  readonly hook: ExitHook;
}

type Registrations = ReadonlyArray<Registration>;

/** The fiber of the last-resource poll, while it runs. */
type Poller = Fiber.Fiber<unknown, never>;

/** The interval of the last-resource poll. It runs only while visible. */
const URL_POLL_MS = 900;
/** The delay after a click, to let the page's router run. */
const CLICK_SETTLE_MS = 60;

/** The event for the URL now. `None` while the URL has not changed. */
const urlChange = (previous: string, url: string): Option.Option<LifecycleEvent> =>
  pipe(
    url,
    Option.liftPredicate((next) => next !== previous),
    Option.map((next) => LifecycleEvent.UrlChange({ url: next, previous })),
  );

/** What a `pagehide` says. Only a page that the browser does not keep is gone for good. */
const exitOf = (event: PageTransitionEvent): PageExit =>
  pipe(
    event.persisted,
    Boolean.match({
      onTrue: () => PageExit.Resumable(),
      onFalse: () => PageExit.Final(),
    }),
  );

export class Lifecycle extends Context.Service<
  Lifecycle,
  {
    readonly events: Stream.Stream<LifecycleEvent>;

    /**
     * Run this work when the page goes away or goes to the background.
     *
     * The hook belongs to the enclosing scope, and it goes when that scope
     * closes.
     */
    readonly onExit: (hook: ExitHook) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("vimium/boot/Lifecycle") {
  static readonly layer: Layer.Layer<Lifecycle, never, Dom> = Layer.effect(
    Lifecycle,
    Effect.gen(function* () {
      const dom = yield* Dom;
      const bus = yield* PubSub.unbounded<LifecycleEvent>();
      const url = yield* pipe(dom.href, Effect.flatMap(Ref.make));
      const poller = yield* Ref.make(Option.none<Poller>());
      const exitHooks = yield* Ref.make<Registrations>([]);

      const emit = (event: LifecycleEvent): Effect.Effect<void> =>
        pipe(bus, PubSub.publish(event), Effect.asVoid);

      const check = Effect.gen(function* () {
        const next = yield* dom.href;
        const previous = yield* pipe(url, Ref.getAndSet(next));
        yield* pipe(
          urlChange(previous, next),
          Option.match({ onNone: () => Effect.void, onSome: emit }),
        );
      });

      const keepPoller = (fiber: Poller): Effect.Effect<void> =>
        pipe(poller, Ref.set(Option.some(fiber)));

      const startPolling = pipe(
        Ref.get(poller),
        Effect.flatMap(
          Option.match({
            onSome: () => Effect.void,
            onNone: () =>
              pipe(
                check,
                Effect.repeat(Schedule.spaced(`${URL_POLL_MS} millis`)),
                Effect.forkScoped,
                Effect.flatMap(keepPoller),
              ),
          }),
        ),
      );

      const stopPolling = pipe(
        poller,
        Ref.getAndSet(Option.none<Poller>()),
        Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Fiber.interrupt })),
      );

      const isVisible = pipe(
        dom.visibility,
        Effect.map((state) => state === "visible"),
      );

      const pollWhileVisible = pipe(startPolling, Effect.when(isVisible), Effect.asVoid);

      const register = (entry: Registration): Effect.Effect<void, never, Scope.Scope> => {
        const add = pipe(exitHooks, Ref.update<Registrations>(Array.append(entry)));
        const remove = pipe(
          exitHooks,
          Ref.update<Registrations>(Array.filter((other) => other !== entry)),
        );
        return Effect.acquireRelease(add, () => remove);
      };

      /** A fresh token for each registration. Read `Registration`. */
      const onExit = (hook: ExitHook): Effect.Effect<void, never, Scope.Scope> =>
        Effect.suspend(() => register({ hook }));

      /**
       * Start every hook now, on this stack.
       *
       * `platform/Dom.ts` runs the listener with `runSyncExitWith`. That call
       * drains its own scheduler, so the part of a hook before the first
       * suspension happens inside the dispatch. `startImmediately` says the
       * same thing at the fork, and it does not depend on the drain. A plain
       * `yield*` would be wrong: a hook that suspends would become a defect
       * instead of work.
       */
      const startExitHooks = Effect.fnUntraced(function* (exit: PageExit) {
        const entries = yield* Ref.get(exitHooks);
        yield* pipe(
          entries,
          Effect.forEach(
            ({ hook }) => pipe(hook(exit), Effect.forkDetach({ startImmediately: true })),
            { discard: true },
          ),
        );
      });

      /** The tab came forward: poll again, read the URL, and say so. */
      const comeForward = Effect.gen(function* () {
        yield* startPolling;
        yield* check;
        yield* emit(LifecycleEvent.Visible());
      });

      /**
       * The tab went to the background.
       *
       * The last moment that mobile WebKit reliably gives us. A tab that goes to
       * the background may never see `pagehide`. The tab can come forward
       * again, so this exit is never final.
       */
      const goToBackground = pipe(
        stopPolling,
        Effect.andThen(startExitHooks(PageExit.Resumable())),
      );

      yield* dom.listen("window", "popstate", () => check);
      yield* dom.listen("window", "hashchange", () => check);

      // Passive, and in the capture phase. We only read the URL afterwards, and
      // we must never change the page's own handling of the click. The check
      // belongs to the layer scope.
      const settling = yield* FiberSet.make();
      yield* dom.listen(
        "window",
        "click",
        () =>
          pipe(
            check,
            Effect.delay(`${CLICK_SETTLE_MS} millis`),
            FiberSet.run(settling),
            Effect.asVoid,
          ),
        { capture: true, passive: true },
      );

      const onPageShow = Effect.fnUntraced(function* (event: PageTransitionEvent) {
        yield* pipe(
          event.persisted,
          Boolean.match({
            onTrue: () => emit(LifecycleEvent.Restore()),
            onFalse: () => Effect.void,
          }),
        );
        // `pagehide` stopped the poll. Nothing else starts it again, so a
        // restored page would lose the one detector that does not depend on
        // `popstate`, on `hashchange` or on a click.
        yield* pollWhileVisible;
        yield* check;
      });

      const onPageHide = Effect.fnUntraced(function* (event: PageTransitionEvent) {
        // The hooks come first, and everything else comes second. They are the
        // work that the page may have no time for. The bus is last: a
        // subscriber reads it on another fiber, which can run after the page
        // is gone.
        const exit = exitOf(event);
        yield* startExitHooks(exit);
        yield* stopPolling;
        yield* pipe(
          exit,
          PageExit.$match({
            Final: () => emit(LifecycleEvent.Leave()),
            Resumable: () => Effect.void,
          }),
        );
      });

      yield* dom.listen("window", "pageshow", onPageShow);
      yield* dom.listen("window", "pagehide", onPageHide);

      yield* dom.listen("document", "visibilitychange", () =>
        pipe(
          isVisible,
          Effect.flatMap(
            Boolean.match({
              onTrue: () => comeForward,
              onFalse: () => goToBackground,
            }),
          ),
        ),
      );

      yield* pollWhileVisible;

      return Lifecycle.of({ events: Stream.fromPubSub(bus), onExit });
    }),
  );
}
