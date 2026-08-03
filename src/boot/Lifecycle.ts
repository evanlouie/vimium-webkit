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
 *    the handler returns is work that never suspends. `boot/Bootstrap.ts`
 *    therefore writes every held value straight to the backend, with a direct
 *    call. Work that *may be lost* is everything after the first suspension:
 *    the answer of the backend, and the message about a failed write. The page
 *    lives on after `visibilitychange`, so that exit loses nothing; see rule 3.
 * 2. **A kept page is not an exit.** `pagehide` with `persisted === true` means
 *    that the page may come back from the back/forward cache. A restored page
 *    never runs its scripts again. The hook therefore gets `final: false`, and
 *    nothing that must be built again may be released. Only `pagehide` with
 *    `persisted === false` gives `final: true`.
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
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Schedule,
  type Scope,
  Stream,
} from "effect";
import { Dom } from "~/platform/Dom.ts";

export type LifecycleEvent =
  /** The URL changed with no document load. */
  | {
    readonly _tag: "UrlChange";
    readonly url: string;
    readonly previous: string;
  }
  /** The page came back from the back/forward cache. */
  | { readonly _tag: "Restore" }
  /** The page is going away for good. */
  | { readonly _tag: "Leave" }
  /** The tab is visible again. Read shared storage again. */
  | { readonly _tag: "Visible" };

/**
 * What the browser said when the page went away.
 *
 * One field, because one question decides everything: will this document run
 * again? A hidden tab and a page in the back/forward cache both come back.
 */
export interface PageExit {
  /** True when this document will not run again. */
  readonly final: boolean;
}

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
 * function reference, and a filter on the reference would remove both.
 */
interface Registration {
  readonly hook: ExitHook;
}

/** The interval of the last-resource poll. It runs only while visible. */
const URL_POLL_MS = 900;
/** The delay after a click, to let the page's router run. */
const CLICK_SETTLE_MS = 60;

export class Lifecycle extends Context.Service<Lifecycle, {
  readonly events: Stream.Stream<LifecycleEvent>;

  /**
   * Run this work when the page goes away or goes to the background.
   *
   * The hook belongs to the enclosing scope, and it goes when that scope
   * closes.
   */
  readonly onExit: (
    hook: ExitHook,
  ) => Effect.Effect<void, never, Scope.Scope>;
}>()("vimium/boot/Lifecycle") {
  static readonly layer: Layer.Layer<Lifecycle, never, Dom> = Layer.effect(
    Lifecycle,
    Effect.gen(function*() {
      const dom = yield* Dom;
      const bus = yield* PubSub.unbounded<LifecycleEvent>();
      const url = yield* Ref.make(yield* dom.href);
      const poller = yield* Ref.make<
        Option.Option<Fiber.Fiber<unknown, never>>
      >(
        Option.none(),
      );
      const exitHooks = yield* Ref.make<ReadonlyArray<Registration>>([]);

      const emit = (event: LifecycleEvent): Effect.Effect<void> =>
        Effect.asVoid(PubSub.publish(bus, event));

      const check = Effect.gen(function*() {
        const next = yield* dom.href;
        const previous = yield* Ref.getAndSet(url, next);
        if (next === previous) return;
        yield* emit({ _tag: "UrlChange", url: next, previous });
      });

      const startPolling = Effect.gen(function*() {
        if (Option.isSome(yield* Ref.get(poller))) return;
        const fiber = yield* Effect.forkScoped(
          Effect.repeat(check, Schedule.spaced(`${URL_POLL_MS} millis`)),
        );
        yield* Ref.set(poller, Option.some(fiber));
      });

      const stopPolling = Effect.gen(function*() {
        const running = yield* Ref.getAndSet(poller, Option.none());
        if (Option.isSome(running)) yield* Fiber.interrupt(running.value);
      });

      const isVisible = Effect.sync(() =>
        dom.document.visibilityState === "visible"
      );

      const onExit = (
        hook: ExitHook,
      ): Effect.Effect<void, never, Scope.Scope> =>
        Effect.suspend(() => {
          const entry: Registration = { hook };
          return Effect.acquireRelease(
            Ref.update(exitHooks, (current) => [...current, entry]),
            () =>
              Ref.update(
                exitHooks,
                (current) => current.filter((other) => other !== entry),
              ),
          );
        });

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
      const startExitHooks = (exit: PageExit): Effect.Effect<void> =>
        Effect.flatMap(
          Ref.get(exitHooks),
          (entries) =>
            Effect.forEach(
              entries,
              (entry) =>
                Effect.forkDetach(entry.hook(exit), {
                  startImmediately: true,
                }),
              { discard: true },
            ),
        );

      yield* dom.listen("window", "popstate", () => check);
      yield* dom.listen("window", "hashchange", () => check);

      // Passive, and in the capture phase. We only read the URL afterwards, and
      // we must never change the page's own handling of the click.
      yield* dom.listen(
        "window",
        "click",
        () =>
          Effect.asVoid(Effect.forkDetach(
            Effect.andThen(
              Effect.sleep(`${CLICK_SETTLE_MS} millis`),
              check,
            ),
          )),
        { capture: true, passive: true },
      );

      yield* dom.listen(
        "window",
        "pageshow",
        (event) =>
          Effect.gen(function*() {
            if (event.persisted) yield* emit({ _tag: "Restore" });
            // `pagehide` stopped the poll. Nothing else starts it again, so a
            // restored page would lose the one detector that does not depend on
            // `popstate`, on `hashchange` or on a click.
            if (yield* isVisible) yield* startPolling;
            yield* check;
          }),
      );

      yield* dom.listen(
        "window",
        "pagehide",
        (event) =>
          Effect.gen(function*() {
            // The hooks come first, and everything else comes second. They are
            // the work that the page may have no time for. The bus is last: a
            // subscriber reads it on another fiber, which can run after the
            // page is gone.
            yield* startExitHooks({ final: !event.persisted });
            yield* stopPolling;
            if (!event.persisted) yield* emit({ _tag: "Leave" });
          }),
      );

      yield* dom.listen(
        "document",
        "visibilitychange",
        () =>
          Effect.gen(function*() {
            if (yield* isVisible) {
              yield* startPolling;
              yield* check;
              yield* emit({ _tag: "Visible" });
              return;
            }
            yield* stopPolling;
            // The last moment that mobile WebKit reliably gives us. A tab that
            // goes to the background may never see `pagehide`. The tab can come
            // forward again, so this exit is never final.
            yield* startExitHooks({ final: false });
          }),
      );

      if (yield* isVisible) yield* startPolling;

      return Lifecycle.of({ events: Stream.fromPubSub(bus), onExit });
    }),
  );
}
