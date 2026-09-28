/**
 * What a userscript can do to a tab: open one, close this one, mute its media,
 * and scale its content.
 *
 * None of these is the browser's own function. Each one is an approximation, or
 * a refusal that the user can see. The catalogue in `~/domain/Command.ts` marks
 * them tier B for that reason.
 */

import {
  Array,
  Boolean,
  Context,
  Data,
  Effect,
  FiberHandle,
  Layer,
  Match,
  Option,
  Record,
  Ref,
  flow,
  pipe,
} from "effect";
import { Commands } from "~/core/Commands.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { withZoom } from "~/domain/Persisted.ts";
import { Dom } from "~/platform/Dom.ts";
import { Storage } from "~/platform/Storage.ts";
import { type TabError, Tabs } from "~/platform/Tabs.ts";
import { BRIEFLY, Hud } from "~/ui/Hud.ts";

const MEDIA_SELECTOR = "audio, video";
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1.1;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** A variant that carries no data. */
type NoFields = Record.ReadonlyRecord<never, never>;

/** A change of the CSS zoom of this origin. */
type ZoomChange = Data.TaggedEnum<{
  /** Back to 100%. */
  Reset: NoFields;
  /** Scale the zoom by a factor, within the bounds. */
  Scale: { readonly factor: number };
}>;
const ZoomChange = Data.taggedEnum<ZoomChange>();

/** The zoom after a change, from the zoom that the origin has now. */
const zoomAfter = (current: number): ((change: ZoomChange) => number) =>
  ZoomChange.$match({
    Reset: () => 1,
    Scale: ({ factor }) => clamp(current * factor, ZOOM_MIN, ZOOM_MAX),
  });

/** The `zoom` style of the root element. 100% is no zoom, and leaves the style empty. */
const zoomStyle: (zoom: number) => string = flow(
  Option.liftPredicate((scale: number) => scale !== 1),
  Option.match({ onNone: () => "", onSome: (scale) => String(scale) }),
);

/** A refusal to close the tab, and the shortcut that the browser gives instead. */
const closeFailureText = (error: TabError): string =>
  pipe(
    error.nativeAlternative,
    Option.match({
      onNone: () => error.detail,
      onSome: (alternative) => `${error.detail} — use ${alternative}`,
    }),
  );

const isMedia = (node: Node): node is HTMLMediaElement => node instanceof HTMLMediaElement;

const isElement = (node: Node): node is Element => node instanceof Element;

/** The media elements below a node. */
const mediaBelow = (root: ParentNode): ReadonlyArray<HTMLMediaElement> =>
  pipe(root.querySelectorAll(MEDIA_SELECTOR), Array.fromIterable, Array.filter(isMedia));

/** The media elements that an added node brings: the node itself, or the ones below it. */
const addedMedia = (node: Node): ReadonlyArray<HTMLMediaElement> =>
  pipe(
    Match.value(node),
    Match.withReturnType<ReadonlyArray<HTMLMediaElement>>(),
    Match.when(isMedia, (media) => [media]),
    Match.when(isElement, mediaBelow),
    Match.orElse(() => []),
  );

const setMuted =
  (muted: boolean) =>
  (element: HTMLMediaElement): void => {
    element.muted = muted;
  };

/** Mute every media element that one mutation added. */
const muteAdded = (record: MutationRecord): void =>
  pipe(
    record.addedNodes,
    Array.fromIterable,
    Array.flatMap(addedMedia),
    Array.forEach(setMuted(true)),
  );

export class TabControl extends Context.Service<
  TabControl,
  {
    /** True while the media elements of this page are muted by us. */
    readonly isMuted: Effect.Effect<boolean>;
  }
>()("vimium/features/TabControl") {
  static readonly layer: Layer.Layer<
    TabControl,
    never,
    Commands | Dom | Hud | Report | Settings | Storage | Tabs
  > = Layer.effect(
    TabControl,
    Effect.gen(function* () {
      const commands = yield* Commands;
      const dom = yield* Dom;
      const hud = yield* Hud;
      const report = yield* Report;
      const settings = yield* Settings;
      const storage = yield* Storage;
      const tabs = yield* Tabs;

      const muted = yield* Ref.make(false);

      const mediaElements = (): ReadonlyArray<HTMLMediaElement> => mediaBelow(dom.document);

      const setAllMuted = (value: boolean): Effect.Effect<void> =>
        Effect.sync(() => pipe(mediaElements(), Array.forEach(setMuted(value))));

      const observeAdditions = Effect.sync(() => {
        const observer = new MutationObserver(Array.forEach(muteAdded));
        observer.observe(dom.document.documentElement, {
          childList: true,
          subtree: true,
        });
        return observer;
      });

      /**
       * Mute every media element, and keep muting the ones that arrive.
       *
       * Only media *elements* are affected. A WebAudio graph keeps playing, and
       * a userscript has no page-level mute.
       *
       * The observer belongs to the fiber in `muteFiber`. Interrupting that
       * fiber closes its scope and disconnects the observer, so a soft
       * navigation cannot leave it watching elements that no longer exist.
       */
      const keepMuting = pipe(
        Effect.gen(function* () {
          yield* setAllMuted(true);

          yield* Effect.acquireRelease(observeAdditions, (observer) =>
            Effect.sync(() => {
              observer.disconnect();
            }),
          );

          yield* hud.show("Muted media elements (WebAudio is unaffected)", BRIEFLY);
          // Hold the scope open. The interruption below closes it.
          return yield* Effect.never;
        }),
        Effect.scoped,
      );

      const muteFiber = yield* FiberHandle.make<void, never>();

      const mute = pipe(keepMuting, FiberHandle.run(muteFiber), Effect.asVoid);

      const unmute = pipe(
        FiberHandle.clear(muteFiber),
        Effect.andThen(setAllMuted(false)),
        Effect.andThen(hud.show("Unmuted", BRIEFLY)),
      );

      const toggleMute = Effect.fn("TabControl.toggleMute")(function* () {
        const wasMuted = yield* pipe(muted, Ref.getAndUpdate(Boolean.not));
        yield* pipe(wasMuted, Boolean.match({ onFalse: () => mute, onTrue: () => unmute }));
      });

      const applyZoom = Effect.fn("TabControl.applyZoom")(function* (change: ZoomChange) {
        const origin = yield* dom.probeOrElse(
          () => dom.window.location.origin,
          () => "",
        );
        const session = yield* storage.session.current;
        const current = pipe(
          session.zoomByOrigin,
          Record.get(origin),
          Option.getOrElse(() => 1),
        );
        const next = pipe(change, zoomAfter(current));

        // `zoom` on the root element, and not the browser's own zoom. It does
        // not change the address bar, it does not survive a manager change,
        // and it breaks `position: fixed` on some sites. It is off by
        // default.
        yield* pipe(
          dom.attempt("documentElement.style.zoom", () => {
            dom.document.documentElement.style.zoom = zoomStyle(next);
          }),
          Effect.ignore,
        );

        yield* pipe(
          storage.session.update(withZoom(origin, next)),
          Effect.ignore,
          Effect.forkDetach,
        );

        yield* hud.show(`Zoom ${Math.round(next * 100)}%`, BRIEFLY);
      });

      const zoomIfEnabled = Effect.fnUntraced(function* (factor: number) {
        const { enableCssZoom } = yield* settings.current;
        yield* pipe(
          enableCssZoom,
          Boolean.match({
            onFalse: () =>
              report.error(
                "CSS zoom is off; turn it on in Settings. It is not the browser's own zoom.",
              ),
            onTrue: () => applyZoom(ZoomChange.Scale({ factor })),
          }),
        );
      });

      yield* commands.registerAll({
        createTab: () =>
          pipe(
            settings.current,
            // `internal` trust: the new-tab URL is the user's own setting, and
            // its default, `about:blank`, is outside the set that a
            // page-supplied URL may use.
            Effect.flatMap((current) =>
              tabs.open(current.newTabUrl, {
                active: true,
                trust: "internal",
              }),
            ),
            Effect.asVoid,
            Effect.catch((error) => report.error(error.detail)),
          ),

        removeTab: () =>
          pipe(
            tabs.closeCurrent,
            Effect.catch((error) => report.error(closeFailureText(error))),
          ),

        toggleMuteTab: () => toggleMute(),
        zoomIn: () => zoomIfEnabled(ZOOM_STEP),
        zoomOut: () => zoomIfEnabled(1 / ZOOM_STEP),
        zoomReset: () => applyZoom(ZoomChange.Reset()),
      });

      return TabControl.of({ isMuted: Ref.get(muted) });
    }),
  );
}
