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
  /**
   * The page is going away, or it is going to the background.
   *
   * This is not `Leave`. It also occurs for the cache, and it is the moment to
   * write anything that is still held.
   */
  | { readonly _tag: "Persist" }
  /** The tab is visible again. Read shared storage again. */
  | { readonly _tag: "Visible" };

/** The interval of the last-resource poll. It runs only while visible. */
const URL_POLL_MS = 900;
/** The delay after a click, to let the page's router run. */
const CLICK_SETTLE_MS = 60;

export class Lifecycle extends Context.Service<Lifecycle, {
  readonly events: Stream.Stream<LifecycleEvent>;
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
            yield* stopPolling;
            yield* emit({ _tag: "Persist" });
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
            // goes to the background may never see `pagehide`.
            yield* emit({ _tag: "Persist" });
          }),
      );

      if (yield* isVisible) yield* startPolling;

      return Lifecycle.of({ events: Stream.fromPubSub(bus) });
    }),
  );
}
