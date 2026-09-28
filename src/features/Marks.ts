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

import {
  Array,
  Boolean,
  Clock,
  Context,
  Data,
  Effect,
  Layer,
  Match,
  Option,
  Record,
  flow,
  pipe,
} from "effect";
import { Commands } from "~/core/Commands.ts";
import { Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { PLAIN_KEY_CONTEXT } from "~/domain/Key.ts";
import type { GlobalMark, Marks as MarksData } from "~/domain/Persisted.ts";
import { localMark, pruneMarks, withGlobalMark, withLocalMark } from "~/domain/Persisted.ts";
import { Dom } from "~/platform/Dom.ts";
import { Storage } from "~/platform/Storage.ts";
import { Tabs } from "~/platform/Tabs.ts";
import { BRIEFLY, Hud } from "~/ui/Hud.ts";
import { captureNextKey } from "./CaptureKey.ts";
import { Scroller } from "./Scroller.ts";

const parseUrl = Option.liftThrowable((href: string) => new URL(href));

/** The URL as text, without its fragment. */
const withoutFragment = (url: URL): string => {
  url.hash = "";
  return url.href;
};

/**
 * A mark is keyed by the URL without the fragment, as upstream does.
 *
 * A stored mark holds any string that reached storage, so `new URL` can fail
 * here. The raw text is then the key, which keeps the mark reachable.
 */
export const markKeyForUrl = (href: string): string =>
  pipe(
    href,
    parseUrl,
    Option.map(withoutFragment),
    Option.getOrElse(() => href),
  );

/** A mark letter, and where the mark lives. */
type MarkLetter = Data.TaggedEnum<{
  /** A mark on this page, keyed by its URL. */
  Local: { readonly letter: string };
  /** A mark that remembers its URL, and that any page can go to. */
  Global: { readonly letter: string };
}>;
const MarkLetter = Data.taggedEnum<MarkLetter>();

/** An upper-case letter is a global mark, as in Vim. */
const markLetter = (letter: string): MarkLetter =>
  pipe(
    letter.length === 1 && letter >= "A" && letter <= "Z",
    Boolean.match({
      onFalse: () => MarkLetter.Local({ letter }),
      onTrue: () => MarkLetter.Global({ letter }),
    }),
  );

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
const SAFE_PROTOCOLS: ReadonlyArray<string> = ["http:", "https:"];

const isSafeMarkUrl: (href: string) => boolean = flow(
  parseUrl,
  Option.exists((url) => pipe(SAFE_PROTOCOLS, Array.contains(url.protocol))),
);

/** A variant that carries no data. */
type NoFields = Record.ReadonlyRecord<never, never>;

/** What a jump to a global mark does. */
type GlobalJump = Data.TaggedEnum<{
  /** No mark has the letter. */
  Unset: NoFields;
  /** The mark is on this page, so the jump is a scroll. */
  Here: { readonly mark: GlobalMark };
  /** The mark points at a URL that we will not open. */
  Unsafe: NoFields;
  /** The mark is on another page. */
  Away: { readonly url: string };
}>;
const GlobalJump = Data.taggedEnum<GlobalJump>();

/** Decide what a jump to a global mark does, from the stored marks and the URL of this page. */
const globalJump = (marks: MarksData, letter: string, href: string): GlobalJump =>
  pipe(
    marks.global,
    Record.get(letter),
    Option.match({
      onNone: () => GlobalJump.Unset(),
      onSome: (mark) =>
        pipe(
          Match.value(mark),
          Match.withReturnType<GlobalJump>(),
          Match.when(
            ({ url }) => markKeyForUrl(url) === markKeyForUrl(href),
            (here) => GlobalJump.Here({ mark: here }),
          ),
          Match.when(
            ({ url }) => isSafeMarkUrl(url),
            ({ url }) => GlobalJump.Away({ url }),
          ),
          Match.orElse(() => GlobalJump.Unsafe()),
        ),
    }),
  );

export class Marks extends Context.Service<
  Marks,
  {
    /** `m` — set a mark on this page. An upper-case letter sets a global one. */
    readonly setLocal: (letter: string) => Effect.Effect<void>;

    /** `` ` `` — go to a mark on this page. */
    readonly jumpLocal: (letter: string) => Effect.Effect<void>;

    readonly setGlobal: (letter: string) => Effect.Effect<void>;

    readonly jumpGlobal: (letter: string) => Effect.Effect<void>;
  }
>()("vimium/features/Marks") {
  static readonly layer: Layer.Layer<
    Marks,
    never,
    Commands | Dom | Hud | Modes | Report | Scroller | Storage | Tabs
  > = Layer.effect(
    Marks,
    Effect.gen(function* () {
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
      const update = Effect.fn("Marks.update")(function* (
        change: (now: number) => (marks: MarksData) => MarksData,
      ) {
        const now = yield* Clock.currentTimeMillis;
        // Pruned on every write, and not on a timer: a local mark is keyed by
        // URL, nothing else ever removes one, so the table only grew — and
        // the whole of it is rewritten on every mark.
        yield* pipe(
          storage.marks.update(flow(change(now), (marks) => pruneMarks(marks, now))),
          Effect.catch((error) => report.error(`Could not save mark: ${error.detail}`)),
        );
      });

      const setGlobal = Effect.fn("Marks.setGlobal")(function* (letter: string) {
        const { x, y } = yield* scroller.position;
        const href = yield* dom.href;
        yield* update((now) =>
          withGlobalMark(letter, { url: href, scrollX: x, scrollY: y, savedAt: now }),
        );
        yield* hud.show(`Global mark "${letter}" set`, BRIEFLY);
      });

      const setOnPage = Effect.fnUntraced(function* (letter: string) {
        const href = yield* dom.href;
        const key = markKeyForUrl(href);
        const { x, y } = yield* scroller.position;
        yield* update((now) =>
          withLocalMark(key, letter, { scrollX: x, scrollY: y, savedAt: now }),
        );
        yield* hud.show(`Mark "${letter}" set`, BRIEFLY);
      });

      const setLocal = Effect.fn("Marks.setLocal")(function* (letter: string) {
        yield* pipe(
          markLetter(letter),
          MarkLetter.$match({
            Local: ({ letter: local }) => setOnPage(local),
            Global: ({ letter: global }) => setGlobal(global),
          }),
        );
      });

      /**
       * Go to a mark on another page.
       *
       * The scroll position of the mark is lost across the navigation. There is
       * no channel that survives a document change, and the next document
       * cannot know which letter brought it there.
       */
      const goToMark = Effect.fnUntraced(function* (letter: string, url: string) {
        yield* hud.show(
          `Going to global mark "${letter}" (a userscript cannot focus another tab)`,
          BRIEFLY,
        );
        // Through the tab service, which is the one place that decides what a
        // safe URL is. A refusal is final; there is no fallback.
        yield* pipe(
          tabs.navigate(url),
          Effect.catch((error) => report.error(`Could not go to the mark: ${error.detail}`)),
        );
      });

      const jumpGlobal = Effect.fn("Marks.jumpGlobal")(function* (letter: string) {
        const marks = yield* storage.marks.current;
        const href = yield* dom.href;
        yield* pipe(
          globalJump(marks, letter, href),
          GlobalJump.$match({
            Unset: () => report.error(`Global mark "${letter}" is not set`),
            Here: ({ mark }) => scroller.restore(mark.scrollX, mark.scrollY),
            Unsafe: () =>
              report.error(
                `Global mark "${letter}" points somewhere unsafe; it will not be opened`,
              ),
            Away: ({ url }) => goToMark(letter, url),
          }),
        );
      });

      const jumpOnPage = Effect.fnUntraced(function* (letter: string) {
        const href = yield* dom.href;
        const key = markKeyForUrl(href);
        const marks = yield* storage.marks.current;
        yield* pipe(
          localMark(marks, key, letter),
          Option.match({
            onNone: () => report.error(`Mark "${letter}" is not set on this page`),
            onSome: (mark) =>
              pipe(
                scroller.restore(mark.scrollX, mark.scrollY),
                Effect.andThen(hud.show(`Jumped to mark "${letter}"`, BRIEFLY)),
              ),
          }),
        );
      });

      const jumpLocal = Effect.fn("Marks.jumpLocal")(function* (letter: string) {
        yield* pipe(
          markLetter(letter),
          MarkLetter.$match({
            Local: ({ letter: local }) => jumpOnPage(local),
            Global: ({ letter: global }) => jumpGlobal(global),
          }),
        );
      });

      const service = Marks.of({
        setLocal,
        jumpLocal,
        setGlobal,
        jumpGlobal,
      });

      yield* commands.registerAll({
        "Marks.activateCreateMode": () =>
          pipe(
            captureNextKey({ prompt: "Set mark:", context: PLAIN_KEY_CONTEXT }),
            Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: service.setLocal })),
          ),
        "Marks.activateGotoMode": () =>
          pipe(
            captureNextKey({ prompt: "Go to mark:", context: PLAIN_KEY_CONTEXT }),
            Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: service.jumpLocal })),
          ),
      });

      return service;
    }),
  );
}
