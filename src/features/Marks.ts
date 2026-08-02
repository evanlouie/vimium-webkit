/**
 * Marks.
 *
 * Ported from upstream Vimium's `content_scripts/marks.js` (MIT), with one
 * degradation that we cannot avoid: a *global* mark can only go to the page.
 * Upstream focuses a tab that is already open, through `chrome.tabs`. A
 * userscript cannot enumerate tabs, so `` ` `` is "go there" and not "go back
 * to where you were". The HUD says so.
 *
 * Storage is the manager, and never `localStorage`: ITP erases storage that a
 * script can write after seven idle days, which would lose every mark that the
 * user set (§7.4).
 */

import { Clock, Context, Effect, Layer, Option } from "effect";
import { Commands } from "~/core/Commands.ts";
import { Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import type { Marks as MarksData } from "~/domain/Persisted.ts";
import { pruneMarks } from "~/domain/Persisted.ts";
import { Dom } from "~/platform/Dom.ts";
import { Storage } from "~/platform/Storage.ts";
import { Tabs } from "~/platform/Tabs.ts";
import { Hud } from "~/ui/Hud.ts";
import { captureNextKey } from "./CaptureKey.ts";
import { Scroller } from "./Scroller.ts";

/**
 * A mark is keyed by the URL without the fragment, as upstream does.
 *
 * A stored mark holds any string that reached storage, so `new URL` can fail
 * here. The raw text is then the key, which keeps the mark reachable.
 */
export const markKeyForUrl = (href: string): string => {
  try {
    const url = new URL(href);
    url.hash = "";
    return url.href;
  } catch {
    return href;
  }
};

/** An upper-case letter is a global mark, as in Vim. */
const isGlobalLetter = (letter: string): boolean =>
  letter.length === 1 && letter >= "A" && letter <= "Z";

/**
 * The schemes that a stored mark may open.
 *
 * The allowlist used to *cause* the unsafe path. The tab service refused a
 * `javascript:` or `data:` mark, the refusal was read as "the manager could not
 * do it", and the fallback then gave the same URL to `location.assign`, which
 * is the sink that the allowlist exists to guard. Marks live in manager
 * storage, which the interface of the manager can edit, so a poisoned mark is a
 * realistic source. There is no fallback here. A refusal is final.
 */
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

const isSafeMarkUrl = (href: string): boolean => {
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
};

export class Marks extends Context.Service<Marks, {
  /** `m` — set a mark on this page. An upper-case letter sets a global one. */
  readonly setLocal: (letter: string) => Effect.Effect<void>;

  /** `` ` `` — go to a mark on this page. */
  readonly jumpLocal: (letter: string) => Effect.Effect<void>;

  readonly setGlobal: (letter: string) => Effect.Effect<void>;

  readonly jumpGlobal: (letter: string) => Effect.Effect<void>;
}>()("vimium/features/Marks") {
  static readonly layer: Layer.Layer<
    Marks,
    never,
    Commands | Dom | Hud | Modes | Report | Scroller | Storage | Tabs
  > = Layer.effect(
    Marks,
    Effect.gen(function*() {
      const commands = yield* Commands;
      const dom = yield* Dom;
      const hud = yield* Hud;
      const report = yield* Report;
      const scroller = yield* Scroller;
      const storage = yield* Storage;
      const tabs = yield* Tabs;

      /**
       * `now` comes from the `Clock`, and not from `Date.now()`.
       *
       * Every timestamp here is stored and later compared with another one, so
       * the clock is an input of this feature and not an ambient fact. A test
       * can age a mark without waiting for real time, and the mark that is
       * written and the prune that goes with it share one reading. Two
       * `Date.now()` calls did not share one.
       */
      const update = Effect.fn("Marks.update")(
        function*(mutate: (marks: MarksData, now: number) => MarksData) {
          const now = yield* Clock.currentTimeMillis;
          // Pruned on every write, and not on a timer: a local mark is keyed by
          // URL, nothing else ever removes one, so the table only grew — and
          // the whole of it is rewritten on every mark.
          yield* Effect.catch(
            storage.marks.update((marks) =>
              pruneMarks(mutate(marks, now), now)
            ),
            (error) => report.error(`Could not save mark: ${error.detail}`),
          );
        },
      );

      const setGlobal = Effect.fn("Marks.setGlobal")(function*(letter: string) {
        const { x, y } = yield* scroller.position;
        const href = yield* dom.href;
        yield* update((marks, now) => ({
          ...marks,
          global: {
            ...marks.global,
            [letter]: { url: href, scrollX: x, scrollY: y, savedAt: now },
          },
        }));
        yield* hud.show(`Global mark "${letter}" set`);
      });

      const setLocal = Effect.fn("Marks.setLocal")(function*(letter: string) {
        if (isGlobalLetter(letter)) {
          yield* setGlobal(letter);
          return;
        }
        const key = markKeyForUrl(yield* dom.href);
        const { x, y } = yield* scroller.position;
        yield* update((marks, now) => ({
          ...marks,
          local: {
            ...marks.local,
            [key]: {
              ...marks.local[key],
              [letter]: { scrollX: x, scrollY: y, savedAt: now },
            },
          },
        }));
        yield* hud.show(`Mark "${letter}" set`);
      });

      const jumpGlobal = Effect.fn("Marks.jumpGlobal")(
        function*(letter: string) {
          const marks = yield* storage.marks.current;
          const mark = Option.fromNullishOr(marks.global[letter]);
          if (Option.isNone(mark)) {
            yield* report.error(`Global mark "${letter}" is not set`);
            return;
          }

          const href = yield* dom.href;
          if (markKeyForUrl(mark.value.url) === markKeyForUrl(href)) {
            yield* scroller.restore(mark.value.scrollX, mark.value.scrollY);
            return;
          }

          if (!isSafeMarkUrl(mark.value.url)) {
            yield* report.error(
              `Global mark "${letter}" points somewhere unsafe; ` +
                "it will not be opened",
            );
            return;
          }

          const target = mark.value.url;
          yield* hud.show(
            `Going to global mark "${letter}" ` +
              "(a userscript cannot focus another tab)",
          );
          // The scroll position of the mark is lost across the navigation.
          // There is no channel that survives a document change, and the next
          // document cannot know which letter brought it there.
          // Through the tab service, which is the one place that decides
          // what a safe URL is. A refusal is final; there is no fallback.
          yield* Effect.catch(
            tabs.navigate(target),
            (error) =>
              report.error(`Could not go to the mark: ${error.detail}`),
          );
        },
      );

      const jumpLocal = Effect.fn("Marks.jumpLocal")(function*(letter: string) {
        if (isGlobalLetter(letter)) {
          yield* jumpGlobal(letter);
          return;
        }
        const key = markKeyForUrl(yield* dom.href);
        const marks = yield* storage.marks.current;
        const mark = Option.fromNullishOr(marks.local[key]?.[letter]);
        if (Option.isNone(mark)) {
          yield* report.error(`Mark "${letter}" is not set on this page`);
          return;
        }
        yield* scroller.restore(mark.value.scrollX, mark.value.scrollY);
        yield* hud.show(`Jumped to mark "${letter}"`);
      });

      const service = Marks.of({
        setLocal,
        jumpLocal,
        setGlobal,
        jumpGlobal,
      });

      yield* commands.registerAll({
        "Marks.activateCreateMode": () =>
          Effect.gen(function*() {
            const letter = yield* captureNextKey({ prompt: "Set mark:" });
            if (Option.isSome(letter)) yield* service.setLocal(letter.value);
          }),
        "Marks.activateGotoMode": () =>
          Effect.gen(function*() {
            const letter = yield* captureNextKey({ prompt: "Go to mark:" });
            if (Option.isSome(letter)) yield* service.jumpLocal(letter.value);
          }),
      });

      return service;
    }),
  );
}
