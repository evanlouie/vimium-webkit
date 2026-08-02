/**
 * What a userscript can do to a tab: open one, close this one, mute its media,
 * and scale its content.
 *
 * None of these is the browser's own function. Each one is an approximation, or
 * a refusal that the user can see. The catalogue in `~/domain/Command.ts` marks
 * them tier B for that reason.
 */

import { Context, Effect, FiberHandle, Layer, Ref } from "effect";
import { Commands } from "~/core/Commands.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { Dom } from "~/platform/Dom.ts";
import { Storage } from "~/platform/Storage.ts";
import { Tabs } from "~/platform/Tabs.ts";
import { Hud } from "~/ui/Hud.ts";

const MEDIA_SELECTOR = "audio, video";
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1.1;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export class TabControl extends Context.Service<TabControl, {
  /** True while the media elements of this page are muted by us. */
  readonly isMuted: Effect.Effect<boolean>;
}>()("vimium/features/TabControl") {
  static readonly layer: Layer.Layer<
    TabControl,
    never,
    Commands | Dom | Hud | Report | Settings | Storage | Tabs
  > = Layer.effect(
    TabControl,
    Effect.gen(function*() {
      const commands = yield* Commands;
      const dom = yield* Dom;
      const hud = yield* Hud;
      const report = yield* Report;
      const settings = yield* Settings;
      const storage = yield* Storage;
      const tabs = yield* Tabs;

      const muted = yield* Ref.make(false);

      const mediaElements = (): ReadonlyArray<HTMLMediaElement> =>
        [...dom.document.querySelectorAll(MEDIA_SELECTOR)]
          .filter((element): element is HTMLMediaElement =>
            element instanceof HTMLMediaElement
          );

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
      const keepMuting = Effect.scoped(Effect.gen(function*() {
        for (const element of mediaElements()) element.muted = true;

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const observer = new MutationObserver((records) => {
              for (const record of records) {
                for (const node of record.addedNodes) {
                  if (node instanceof HTMLMediaElement) node.muted = true;
                  else if (node instanceof Element) {
                    for (
                      const nested of node.querySelectorAll(MEDIA_SELECTOR)
                    ) {
                      if (nested instanceof HTMLMediaElement) {
                        nested.muted = true;
                      }
                    }
                  }
                }
              }
            });
            observer.observe(dom.document.documentElement, {
              childList: true,
              subtree: true,
            });
            return observer;
          }),
          (observer) =>
            Effect.sync(() => {
              observer.disconnect();
            }),
        );

        yield* hud.show("Muted media elements (WebAudio is unaffected)");
        // Hold the scope open. The interruption below closes it.
        return yield* Effect.never;
      }));

      const muteFiber = yield* FiberHandle.make<void, never>();

      const toggleMute = Effect.fn("TabControl.toggleMute")(function*() {
        if (yield* Ref.getAndSet(muted, false)) {
          yield* FiberHandle.clear(muteFiber);
          for (const element of mediaElements()) element.muted = false;
          yield* hud.show("Unmuted");
          return;
        }
        yield* Ref.set(muted, true);
        yield* FiberHandle.run(muteFiber, keepMuting);
      });

      const applyZoom = Effect.fn("TabControl.applyZoom")(
        function*(factor: number | undefined) {
          const origin = yield* dom.probeOr(
            () => dom.window.location.origin,
            "",
          );
          const session = yield* storage.session.current;
          const current = session.zoomByOrigin[origin] ?? 1;
          const next = factor === undefined
            ? 1
            : clamp(current * factor, ZOOM_MIN, ZOOM_MAX);

          // `zoom` on the root element, and not the browser's own zoom. It does
          // not change the address bar, it does not survive a manager change,
          // and it breaks `position: fixed` on some sites. It is off by
          // default.
          yield* Effect.ignore(
            dom.attempt("documentElement.style.zoom", () => {
              dom.document.documentElement.style.zoom = next === 1
                ? ""
                : String(next);
            }),
          );

          yield* Effect.forkDetach(
            Effect.ignore(storage.session.update((state) => ({
              ...state,
              zoomByOrigin: { ...state.zoomByOrigin, [origin]: next },
            }))),
          );

          yield* hud.show(`Zoom ${Math.round(next * 100)}%`);
        },
      );

      const zoomIfEnabled = (
        factor: number,
      ): Effect.Effect<void> =>
        Effect.gen(function*() {
          const current = yield* settings.current;
          if (!current.enableCssZoom) {
            yield* report.error(
              "CSS zoom is off; turn it on in Settings. " +
                "It is not the browser's own zoom.",
            );
            return;
          }
          yield* applyZoom(factor);
        });

      yield* commands.registerAll({
        createTab: () =>
          Effect.gen(function*() {
            const current = yield* settings.current;
            // `internal` trust: the new-tab URL is the user's own setting, and
            // its default, `about:blank`, is outside the set that a
            // page-supplied URL may use.
            yield* Effect.catch(
              tabs.open(current.newTabUrl, {
                active: true,
                trust: "internal",
              }),
              (error) => report.error(error.detail),
            );
          }),

        removeTab: () =>
          Effect.catch(
            tabs.closeCurrent,
            (error) =>
              report.error(
                error.nativeAlternative === undefined
                  ? error.detail
                  : `${error.detail} — use ${error.nativeAlternative}`,
              ),
          ),

        toggleMuteTab: () => toggleMute(),
        zoomIn: () => zoomIfEnabled(ZOOM_STEP),
        zoomOut: () => zoomIfEnabled(1 / ZOOM_STEP),
        zoomReset: () => applyZoom(undefined),
      });

      return TabControl.of({ isMuted: Ref.get(muted) });
    }),
  );
}
