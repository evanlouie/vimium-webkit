/**
 * Navigation lifecycle.
 *
 * Two things are going on here, both WebKit-shaped:
 *
 * 1. **Back/forward cache.** Safari bfcaches aggressively, and a restored page
 *    never re-runs its scripts. `pagehide`/`pageshow` with the `persisted` flag
 *    are the only correct signals. `unload` is never used: WebKit declines to
 *    bfcache pages that register it — and having declined, then does not fire
 *    it either, which is the worst of both worlds.
 *
 * 2. **Single-page navigation.** In the content world we do not share the
 *    page's JS realm, so patching `history.pushState` is useless: the page's
 *    calls go through its own realm's `History.prototype`. The `navigation` API
 *    would solve this cleanly but is not implemented in Safari. What is left is
 *    event-driven checks (`popstate`, `hashchange`, and a post-click sample)
 *    with a slow interval as the backstop — deliberately gated on document
 *    visibility so a background tab costs nothing.
 */

export interface LifecycleOptions {
  /** The URL changed without a document load. */
  onUrlChange(url: string, previous: string): void;
  /** The page is being restored from the back/forward cache. */
  onRestore?(): void;
  /** The page is going away for real (not into the bfcache). */
  onLeave?(): void;
  /** The tab became visible again; a good moment to re-read shared storage. */
  onVisible?(): void;
}

/** Backstop poll interval. Only runs while the document is visible. */
const URL_POLL_MS = 900;
/** Delay after a click before sampling the URL, to let the router run. */
const CLICK_SETTLE_MS = 60;

export class Lifecycle {
  readonly #options: LifecycleOptions;
  #url = location.href;
  #interval: number | null = null;
  #disposed = false;

  readonly #check = (): void => {
    if (this.#disposed) return;
    const next = location.href;
    if (next === this.#url) return;
    const previous = this.#url;
    this.#url = next;
    this.#options.onUrlChange(next, previous);
  };

  readonly #onClick = (): void => {
    setTimeout(this.#check, CLICK_SETTLE_MS);
  };

  readonly #onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) this.#options.onRestore?.();
    this.#check();
  };

  readonly #onPageHide = (event: PageTransitionEvent): void => {
    this.#stopPolling();
    if (!event.persisted) this.#options.onLeave?.();
  };

  readonly #onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") {
      this.#startPolling();
      this.#check();
      this.#options.onVisible?.();
    } else {
      this.#stopPolling();
    }
  };

  constructor(options: LifecycleOptions) {
    this.#options = options;

    globalThis.addEventListener("popstate", this.#check);
    globalThis.addEventListener("hashchange", this.#check);
    globalThis.addEventListener("pageshow", this.#onPageShow);
    globalThis.addEventListener("pagehide", this.#onPageHide);
    document.addEventListener("visibilitychange", this.#onVisibilityChange);
    // Passive and in the capture phase: we only ever read the URL afterwards,
    // and must never influence the page's own click handling.
    globalThis.addEventListener("click", this.#onClick, {
      capture: true,
      passive: true,
    });

    if (document.visibilityState === "visible") this.#startPolling();
  }

  #startPolling(): void {
    if (this.#interval !== null || this.#disposed) return;
    this.#interval = setInterval(this.#check, URL_POLL_MS);
  }

  #stopPolling(): void {
    if (this.#interval === null) return;
    clearInterval(this.#interval);
    this.#interval = null;
  }

  dispose(): void {
    this.#disposed = true;
    this.#stopPolling();
    globalThis.removeEventListener("popstate", this.#check);
    globalThis.removeEventListener("hashchange", this.#check);
    globalThis.removeEventListener("pageshow", this.#onPageShow);
    globalThis.removeEventListener("pagehide", this.#onPageHide);
    document.removeEventListener("visibilitychange", this.#onVisibilityChange);
    globalThis.removeEventListener("click", this.#onClick, { capture: true });
  }
}

export const watchLifecycle = (options: LifecycleOptions): Lifecycle =>
  new Lifecycle(options);
