/**
 * Marks (IMPLEMENTATION_PLAN.md §4.1, §4.2).
 *
 * Ported from upstream Vimium's `content_scripts/marks.js` (MIT), with one
 * unavoidable degradation: a *global* mark can only ever open a new tab.
 * Upstream focuses an already-open tab via `chrome.tabs`, and a userscript has
 * no tab enumeration, so `M` + `` ` `` is "go there" rather than "go back to
 * where you were". The HUD says so the first time.
 *
 * Storage is `GM_setValue`, never `localStorage`: ITP erases script-writable
 * storage after seven idle days, which would silently lose every mark the user
 * set (§7.4).
 */

import { Clock, Effect } from "effect";
import type { AppContext, MarksApi } from "~/core/context.ts";
import type { Marks } from "~/settings/schema.ts";
import { pruneMarks } from "~/settings/schema.ts";
import { Tabs } from "~/platform/tabs.ts";

/** Marks are keyed by URL without the fragment, matching upstream. */
export const markKeyForUrl = (href: string): string => {
  try {
    const url = new URL(href);
    url.hash = "";
    return url.href;
  } catch {
    return href;
  }
};

const isGlobalLetter = (letter: string): boolean =>
  letter.length === 1 && letter >= "A" && letter <= "Z";

class MarksFeature implements MarksApi {
  readonly #app: AppContext;

  constructor(app: AppContext) {
    this.#app = app;
  }

  setLocal(letter: string): void {
    if (isGlobalLetter(letter)) {
      this.setGlobal(letter);
      return;
    }
    const key = markKeyForUrl(location.href);
    const { x, y } = this.#app.scroller.position();
    this.#app.runtime.runFork(this.#update((marks, now) => ({
      ...marks,
      local: {
        ...marks.local,
        [key]: {
          ...marks.local[key],
          [letter]: { scrollX: x, scrollY: y, savedAt: now },
        },
      },
    })));
    this.#app.hud.show(`Mark "${letter}" set`);
  }

  jumpLocal(letter: string): void {
    if (isGlobalLetter(letter)) {
      this.jumpGlobal(letter);
      return;
    }
    const key = markKeyForUrl(location.href);
    const mark = this.#app.groups.marks.current().local[key]?.[letter];
    if (!mark) {
      this.#app.hud.error(`Mark "${letter}" is not set on this page`);
      return;
    }
    this.#app.scroller.restore(mark.scrollX, mark.scrollY);
    this.#app.hud.show(`Jumped to mark "${letter}"`);
  }

  setGlobal(letter: string): void {
    const { x, y } = this.#app.scroller.position();
    this.#app.runtime.runFork(this.#update((marks, now) => ({
      ...marks,
      global: {
        ...marks.global,
        [letter]: {
          url: location.href,
          scrollX: x,
          scrollY: y,
          savedAt: now,
        },
      },
    })));
    this.#app.hud.show(`Global mark "${letter}" set`);
  }

  jumpGlobal(letter: string): void {
    const mark = this.#app.groups.marks.current().global[letter];
    if (!mark) {
      this.#app.hud.error(`Global mark "${letter}" is not set`);
      return;
    }

    if (markKeyForUrl(mark.url) === markKeyForUrl(location.href)) {
      this.#app.scroller.restore(mark.scrollX, mark.scrollY);
      return;
    }

    // Restore the scroll position after the new document loads by handing it
    // through the fragment; there is no cross-navigation channel otherwise.
    const target = new URL(mark.url);
    target.hash = `${target.hash.replace(/^#/, "")}`;

    // `runFork` rather than `runSync`: opening a tab goes through the
    // manager's async API. The fork starts running immediately, so the call
    // still leaves within the keystroke's transient-activation window.
    this.#app.runtime.runFork(
      Tabs.use((tabs) => tabs.open(target.href, { active: true })).pipe(
        Effect.map(() => {
          this.#app.hud.show(
            `Opened global mark "${letter}" in a new tab ` +
              "(a userscript cannot focus an existing tab)",
          );
        }),
        // The scheme allowlist used to *cause* the unsafe path: `openTab`
        // refused a `javascript:` or `data:` mark, the refusal was read as "the
        // manager could not do it", and the fallback then handed the very same
        // URL to `location.assign` — which is the sink the allowlist exists to
        // guard. Marks live in manager storage, which the manager's own UI can
        // edit, so a poisoned one is a realistic source.
        Effect.catch((error) =>
          error.reason === "unsafe-url"
            ? Effect.sync(() => {
              this.#app.hud.error(
                `Global mark "${letter}" points somewhere unsafe; refusing to open it`,
              );
            })
            : Tabs.use((tabs) => tabs.navigate(target.href)).pipe(
              Effect.catch((failure) =>
                Effect.sync(() => {
                  this.#app.hud.error(failure.detail);
                })
              ),
            )
        ),
      ),
    );
  }

  /**
   * `now` comes from the `Clock`, not from `Date.now()`.
   *
   * Every timestamp here is persisted and later compared against another one,
   * so the clock is an input to this feature rather than an ambient fact.
   * Taking it from the service lets a test age a mark without waiting for real
   * time to pass, and it gives the mark being written and the prune that
   * accompanies it one shared reading — which two `Date.now()` calls did not.
   */
  #update(
    mutate: (marks: Marks, now: number) => Marks,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function*() {
      const now = yield* Clock.currentTimeMillis;
      // Pruned on every write rather than on a timer: local marks are keyed by
      // URL and nothing else ever removes one, so the table only ever grew —
      // and the whole of it is rewritten on each mark.
      return yield* this.#app.groups.marks.update((marks) =>
        pruneMarks(mutate(marks, now), now)
      ).pipe(
        Effect.asVoid,
        Effect.catch((issue) =>
          Effect.sync(() => {
            this.#app.hud.error(`Could not save mark: ${issue.detail}`);
          })
        ),
      );
    });
  }
}

export const createMarks = (app: AppContext): MarksApi => new MarksFeature(app);
