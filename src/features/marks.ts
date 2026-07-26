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

import type { AppContext, MarksApi } from "~/core/context.ts";
import type { Marks } from "~/settings/schema.ts";
import { navigate, openTab } from "~/platform/tabs.ts";

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
    void this.#update((marks) => ({
      ...marks,
      local: {
        ...marks.local,
        [key]: {
          ...marks.local[key],
          [letter]: { scrollX: x, scrollY: y, savedAt: Date.now() },
        },
      },
    }));
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
    void this.#update((marks) => ({
      ...marks,
      global: {
        ...marks.global,
        [letter]: {
          url: location.href,
          scrollX: x,
          scrollY: y,
          savedAt: Date.now(),
        },
      },
    }));
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

    void openTab(this.#app.gm, target.href, { active: true }).match(
      () => {
        this.#app.hud.show(
          `Opened global mark "${letter}" in a new tab ` +
            "(a userscript cannot focus an existing tab)",
        );
      },
      (error) => {
        // The scheme allowlist used to *cause* the unsafe path: `openTab`
        // refused a `javascript:` or `data:` mark, the refusal was read as "the
        // manager could not do it", and the fallback then handed the very same
        // URL to `location.assign` — which is the sink the allowlist exists to
        // guard. Marks live in manager storage, which the manager's own UI can
        // edit, so a poisoned one is a realistic source.
        if (error.kind === "unsafe-url") {
          this.#app.hud.error(
            `Global mark "${letter}" points somewhere unsafe; refusing to open it`,
          );
          return;
        }
        const result = navigate(target.href);
        if (result.isErr()) this.#app.hud.error(result.error.message);
      },
    );
  }

  #update(mutate: (marks: Marks) => Marks): Promise<void> {
    return this.#app.groups.marks.update(mutate).match(
      () => undefined,
      (issue) => {
        this.#app.hud.error(`Could not save mark: ${issue.message}`);
      },
    );
  }
}

export const createMarks = (app: AppContext): MarksApi => new MarksFeature(app);
