/**
 * The overlay host: one closed shadow root for the whole application.
 *
 * This is the most important decision for WebKit. It solves three problems at
 * the same time:
 *
 * - **The page Content Security Policy.** Safari applies the `style-src` of the
 *   page to a DOM node that a content script inserts. Chrome does not. A rule
 *   that goes in through CSSOM (`adoptedStyleSheets`) is not a `style-src`
 *   fetch, so the policy does not block it. Unlike `GM_addElement`, a
 *   constructed stylesheet exists in every manager.
 * - **Page CSS that leaks in.** `all: initial` on the host, plus the shadow
 *   boundary, keeps every page rule and every inherited property out.
 * - **Detection.** Page script cannot walk into a closed root, restyle it, or
 *   remove it with a selector.
 *
 * The host itself is still a node with a known name in the light DOM. Page CSS
 * can therefore name it, and page script can remove it. Two measures answer
 * that: every inline declaration on the host carries the important priority,
 * and a mutation observer puts the host back when the page takes it away. See
 * `HOST_STYLE` and the removal guard below.
 *
 * The overlay is hidden from assistive technology while nothing is active, and
 * `expose` opens one layer at a time. A hint marker decorates a link that the
 * page already offers, so a screen reader must not read it twice; a dialog, a
 * prompt and the omnibar are true controls, and a screen reader must reach
 * them.
 *
 * There is no iframe here, on purpose. Upstream Vimium puts its HUD, its
 * omnibar and its help dialog in a `web_accessible_resources` iframe. A
 * userscript has no such origin, and `frame-src` would block a `blob:` frame.
 *
 * Every element, every listener and every stylesheet is acquired with
 * `Effect.acquireRelease` in the layer scope. Closing that scope removes the
 * whole overlay, so there is no `destroy` method that somebody must remember
 * to call.
 */

import {
  Context,
  Effect,
  FiberHandle,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Settings } from "~/core/Settings.ts";
import { Capabilities } from "~/platform/Capabilities.ts";
import { Dom } from "~/platform/Dom.ts";
import { BASE_CSS, type ColorScheme, detectPageScheme } from "~/ui/Styles.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UiError extends Schema.TaggedErrorClass<UiError>()("UiError", {
  reason: Schema.Literals(["unavailable"]),
  detail: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Layers of the overlay
// ---------------------------------------------------------------------------

export type UiLayerName = "hud" | "hints" | "find" | "dialog" | "omnibar";

/** The stacking order, lowest first. */
const LAYER_ORDER: readonly UiLayerName[] = [
  "hints",
  "find",
  "hud",
  "omnibar",
  "dialog",
];

/** The layers that can take pointer events while they hold content. */
const INTERACTIVE_LAYERS: ReadonlySet<UiLayerName> = new Set<UiLayerName>([
  "omnibar",
  "dialog",
]);

/** The visible part of the page, in CSS pixels. */
export interface ViewportRect {
  readonly offsetLeft: number;
  readonly offsetTop: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/**
 * Let a layer take pointer events for as long as the scope is open.
 *
 * A modal opens with this, and the release step gives the clicks back to the
 * page. Nothing has to remember to turn it off.
 */
export const acceptPointerEvents = (
  layer: HTMLElement,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.asVoid(Effect.acquireRelease(
    Effect.sync(() => {
      layer.dataset["interactive"] = "true";
    }),
    () =>
      Effect.sync(() => {
        layer.dataset["interactive"] = "false";
      }),
  ));

// ---------------------------------------------------------------------------
// The host element
// ---------------------------------------------------------------------------

/**
 * The style of the host, written through CSSOM and not as a `style` attribute.
 *
 * A `style` attribute obeys `style-src-attr`, which falls back to `style-src`.
 * Under `style-src 'self'` Safari therefore drops the declarations and reports
 * a violation. CSP does not police CSSOM. Writing the same properties through
 * `element.style` is the only way to keep `all: initial`, the stacking context
 * and the visual-viewport transform on exactly the sites that need them most.
 *
 * Every declaration carries the important priority. The host has a known name
 * in the light DOM, so a page can address it with `vimium-webkit-overlay {
 * display: none !important }`. An important inline declaration beats an
 * important rule of the page, and `all: initial` extends that protection to
 * `visibility`, `opacity`, `transform` and every other property that could
 * hide us.
 *
 * The list holds longhands, and not the `inset` shorthand, because the guard
 * below compares what it wrote. A shorthand does not serialise back when a
 * later declaration changes one of its longhands.
 */
export const HOST_STYLE: ReadonlyArray<readonly [string, string]> = [
  ["all", "initial"],
  ["position", "fixed"],
  ["top", "0px"],
  ["right", "0px"],
  ["bottom", "0px"],
  ["left", "0px"],
  ["pointer-events", "none"],
  ["z-index", "2147483647"],
  ["display", "block"],
  // `all` does not cover every property in every engine. WebKit leaves
  // `transform` out of the expansion, so a page rule of `transform: scale(0)
  // !important` collapsed the whole overlay. The rest are written for the same
  // reason: each one alone can make the interface invisible, and none of them
  // may depend on what `all` happens to include.
  ["transform", "none"],
  ["visibility", "visible"],
  ["opacity", "1"],
  ["clip-path", "none"],
  ["filter", "none"],
  ["margin", "0"],
  ["padding", "0"],
  ["border", "0"],
];

/**
 * The declarations that the guard compares against the live style.
 *
 * Each one is a longhand with a stable serialisation, so a comparison gives
 * the same answer in every engine. Three kinds of declaration are written but
 * never compared:
 *
 * - A shorthand such as `all`, `margin` or `border`. An engine gives back an
 *   empty string for a shorthand whose longhands disagree, so the comparison
 *   would always fail and the guard would write for ever.
 * - `transform`, `width` and `height`, because the visual-viewport sync owns
 *   them and writes a value of its own.
 * - A property that an older engine may not know at all, for the same reason
 *   as the first.
 */
const GUARDED_HOST_STYLE: ReadonlyArray<readonly [string, string]> = HOST_STYLE
  .filter(([property]) =>
    property === "position" || property === "top" || property === "right" ||
    property === "bottom" || property === "left" ||
    property === "pointer-events" || property === "z-index" ||
    property === "display" || property === "visibility" ||
    property === "opacity"
  );

/**
 * The host properties that no longer hold the value that we wrote.
 *
 * Page script can write over the whole `style` attribute of the host, and page
 * CSS can win a property that we wrote without the important priority. The
 * guard therefore compares first and writes only when something changed. A
 * write for each check would make a page that watches the attribute fight us
 * in a loop.
 *
 * `read` gives the current value and the current priority of one property. It
 * is a parameter, so this function stays pure and a test needs no DOM.
 */
export const outOfDateHostProperties = (
  read: (property: string) => readonly [value: string, priority: string],
): readonly string[] =>
  GUARDED_HOST_STYLE
    .filter(([property, value]) => {
      const [current, priority] = read(property);
      return current !== value || priority !== "important";
    })
    .map(([property]) => property);

/**
 * How many times the guard puts the host back after a removal.
 *
 * A page that removes the host inside its own mutation observer would fight us
 * in a loop of microtasks, and that loop would starve the page. The observer
 * stops after the cap. The overlay still comes back, because every visible
 * action attaches the host again.
 */
const REATTACH_LIMIT = 32;

// ---------------------------------------------------------------------------
// Exposure to assistive technology
// ---------------------------------------------------------------------------

/**
 * Add `delta` to the number of holds on one layer.
 *
 * A hold is one open modal. Two nested holds on the same layer are normal: the
 * settings dialog opens over the help dialog, and the help dialog closes
 * afterwards. The layer stays exposed until the last hold goes.
 */
export const shiftHold = <K>(
  holds: ReadonlyMap<K, number>,
  key: K,
  delta: number,
): ReadonlyMap<K, number> => {
  const next = new Map(holds);
  next.set(key, Math.max(0, (holds.get(key) ?? 0) + delta));
  return next;
};

/** Does any layer hold the accessibility tree open? */
export const anyHeld = <K>(holds: ReadonlyMap<K, number>): boolean => {
  for (const count of holds.values()) {
    if (count > 0) return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Stylesheets
// ---------------------------------------------------------------------------

/**
 * One installed stylesheet.
 *
 * A constructed sheet is the normal case. A `<style>` element is the documented
 * fallback for an engine below Safari 16.4 or Chrome 111. That element is still
 * subject to the `style-src` of the page, so the fallback breaks under a strict
 * policy. `Capabilities` warns the user when we reach it.
 */
type StyleTarget =
  | { readonly _tag: "sheet"; readonly sheet: CSSStyleSheet }
  | { readonly _tag: "element"; readonly element: HTMLStyleElement };

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Ui extends Context.Service<Ui, {
  readonly shadow: ShadowRoot;
  readonly layer: (name: UiLayerName) => Effect.Effect<HTMLElement>;
  /**
   * Put the host back in the document, with the style that we gave it.
   *
   * Call this before an action that makes something visible. It is two cheap
   * reads, and it never suspends, so the key path may reach it.
   */
  readonly ensureAttached: Effect.Effect<void>;
  /**
   * Show one layer to assistive technology while the scope is open.
   *
   * The host is hidden from the accessibility tree while every layer is
   * inactive, because an empty positioning box helps nobody. A layer that
   * holds a dialog, a prompt or the omnibar must ask for attention with this,
   * and the release step hides it again.
   */
  readonly expose: (
    layer: HTMLElement,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Append a stylesheet. */
  readonly addStyle: (css: string) => Effect.Effect<void>;
  /** Install or replace a stylesheet under a key, for anything derived from a live setting. */
  readonly setStyle: (key: string, css: string) => Effect.Effect<void>;
  readonly syncColorScheme: Effect.Effect<void>;
  readonly owns: (target: EventTarget | null) => boolean;
  readonly viewport: Effect.Effect<ViewportRect>;
}>()("vimium/ui/Ui") {
  static readonly layer: Layer.Layer<Ui, never, Dom | Capabilities | Settings> =
    Layer.effect(
      Ui,
      Effect.gen(function*() {
        const dom = yield* Dom;
        const capabilities = yield* Capabilities;
        const settings = yield* Settings;
        const doc = dom.document;
        const win = dom.window;

        // The layer scope, kept so that a stylesheet which arrives later is
        // still owned by this layer. `addStyle` and `setStyle` have no scope of
        // their own, and a stylesheet must live as long as the overlay.
        const layerScope = yield* Scope.Scope;
        const scoped = <A, E>(
          effect: Effect.Effect<A, E, Scope.Scope>,
        ): Effect.Effect<A, E> =>
          Effect.provideService(effect, Scope.Scope, layerScope);

        // ---------------------------------------------------------------
        // The host and the shadow root
        // ---------------------------------------------------------------

        const host = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = doc.createElement("vimium-webkit-overlay");
            for (const [property, value] of HOST_STYLE) {
              // `setProperty`, and not the camel-case accessors: `all` is a
              // shorthand that some engines do not give as an IDL attribute,
              // and only `setProperty` can give a declaration the important
              // priority. The priority is what stops page CSS from hiding us.
              element.style.setProperty(property, value, "important");
            }
            // Assistive technology must not see an empty positioning box. A
            // layer asks for attention with `expose` when it draws something.
            element.setAttribute("aria-hidden", "true");
            return element;
          }),
          (element) =>
            Effect.sync(() => {
              element.remove();
            }),
        );

        // A realm that refuses a shadow root cannot hold the overlay at all.
        // There is no smaller unit to lose, so this is a defect and not a
        // failure that a caller could handle.
        const shadow = yield* Effect.orDie(
          Effect.mapError(
            dom.attempt(
              "Element.attachShadow",
              () => host.attachShadow({ mode: "closed" }),
            ),
            (error) =>
              new UiError({ reason: "unavailable", detail: error.detail }),
          ),
        );

        // ---------------------------------------------------------------
        // Stylesheets
        // ---------------------------------------------------------------

        const adopted = yield* Ref.make<ReadonlyArray<CSSStyleSheet>>([]);
        const keyed = yield* Ref.make<ReadonlyMap<string, StyleTarget>>(
          new Map(),
        );

        const applyAdopted = Effect.gen(function*() {
          const sheets = yield* Ref.get(adopted);
          // Ignored: a realm that refuses the assignment keeps the sheets that
          // it already has, and the fallback path below covers a new one.
          yield* Effect.ignore(
            dom.attempt("ShadowRoot.adoptedStyleSheets", () => {
              shadow.adoptedStyleSheets = [...sheets];
            }),
          );
        });

        /** Build a constructed sheet, or `None` where the engine has none. */
        const makeSheet = (
          css: string,
        ): Effect.Effect<Option.Option<CSSStyleSheet>> =>
          capabilities.adoptedStyleSheets
            ? dom.probeOr(() => {
              const sheet = new CSSStyleSheet();
              sheet.replaceSync(css);
              return Option.some(sheet);
            }, Option.none<CSSStyleSheet>())
            : Effect.succeedNone;

        const installStyle = Effect.fn("Ui.installStyle")(
          function*(css: string) {
            const made = yield* makeSheet(css);
            if (Option.isSome(made)) {
              const sheet = made.value;
              yield* scoped(Effect.acquireRelease(
                Effect.andThen(
                  Ref.update(adopted, (current) => [...current, sheet]),
                  applyAdopted,
                ),
                () =>
                  Effect.andThen(
                    Ref.update(
                      adopted,
                      (current) => current.filter((one) => one !== sheet),
                    ),
                    applyAdopted,
                  ),
              ));
              return { _tag: "sheet", sheet } as const satisfies StyleTarget;
            }

            // One element for each stylesheet, and not one shared element. The
            // shared element could only grow: a keyed sheet that alternates
            // between two values appended both of them again for every change,
            // and both stayed in effect.
            const element = yield* scoped(Effect.acquireRelease(
              Effect.sync(() => {
                const style = doc.createElement("style");
                style.textContent = css;
                shadow.appendChild(style);
                return style;
              }),
              (style) =>
                Effect.sync(() => {
                  style.remove();
                }),
            ));
            return { _tag: "element", element } as const satisfies StyleTarget;
          },
        );

        /** Give an installed stylesheet a new body. */
        const replaceStyle = Effect.fn("Ui.replaceStyle")(
          function*(target: StyleTarget, css: string) {
            if (target._tag === "element") {
              yield* Effect.sync(() => {
                target.element.textContent = css;
              });
              return true;
            }
            return yield* dom.probeOr(() => {
              target.sheet.replaceSync(css);
              return true;
            }, false);
          },
        );

        const addStyle = (css: string): Effect.Effect<void> =>
          Effect.asVoid(installStyle(css));

        /**
         * Install or replace a stylesheet under a key.
         *
         * `addStyle` appends, which is correct for the fixed sheets that go in
         * once at start, and wrong for anything derived from a setting.
         */
        const setStyle = Effect.fn("Ui.setStyle")(
          function*(key: string, css: string) {
            const existing = (yield* Ref.get(keyed)).get(key);
            if (
              existing !== undefined && (yield* replaceStyle(existing, css))
            ) {
              return;
            }
            const target = yield* installStyle(css);
            yield* Ref.update(keyed, (current) => {
              const next = new Map(current);
              next.set(key, target);
              return next;
            });
          },
        );

        yield* addStyle(BASE_CSS);

        // ---------------------------------------------------------------
        // The layers
        // ---------------------------------------------------------------

        const layers = new Map<UiLayerName, HTMLElement>();
        for (const name of LAYER_ORDER) {
          const element = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const div = doc.createElement("div");
              div.className = "vw-layer";
              div.dataset["layer"] = name;
              if (INTERACTIVE_LAYERS.has(name)) {
                div.dataset["interactive"] = "false";
              }
              // Every layer starts outside the accessibility tree. A hint
              // marker and a find highlight are decorations of something that
              // the page already shows, and a screen reader must not read them
              // twice. `expose` opens the layers that hold true controls.
              div.setAttribute("aria-hidden", "true");
              shadow.appendChild(div);
              return div;
            }),
            (div) =>
              Effect.sync(() => {
                div.remove();
              }),
          );
          layers.set(name, element);
        }

        /**
         * Write the host style again, but only where the page changed it.
         *
         * The comparison is what makes this safe to call often, and what stops
         * a page that watches the `style` attribute from fighting us in a
         * loop: an intact style produces no write at all.
         */
        const restoreHostStyle = (): void => {
          const stale = outOfDateHostProperties((property) => [
            host.style.getPropertyValue(property),
            host.style.getPropertyPriority(property),
          ]);
          if (stale.length === 0) return;
          for (const [property, value] of HOST_STYLE) {
            host.style.setProperty(property, value, "important");
          }
        };

        /**
         * Put the host back in the document, with the style that we gave it.
         *
         * This runs at start, on every `layer` call, and before every action
         * that makes something visible. A single-page application replaces
         * `document.body` often, and some replace `documentElement`, which
         * detaches us without a sign. Page script can also delete our style.
         * Both reads are cheap, so paying for them at each access costs less
         * than the failure that they prevent: an interface that keeps the
         * keyboard while the user sees nothing.
         */
        const ensureAttached = Effect.asVoid(dom.probeOr(() => {
          restoreHostStyle();
          if (host.isConnected) return false;
          // At `document-start` there may be no `documentElement` yet. Doing
          // nothing is correct, because the next `layer` call tries again.
          const parent: Element | null = doc.documentElement ?? doc.body ??
            null;
          if (parent === null) return false;
          parent.appendChild(host);
          return true;
        }, false));

        // Attached once here, so that the overlay exists before any feature
        // asks for a layer.
        yield* ensureAttached;

        // ---------------------------------------------------------------
        // The removal guard
        // ---------------------------------------------------------------

        const reattachments = yield* Ref.make(0);

        /**
         * Watch the two places from which the host can disappear.
         *
         * The host is a child of `documentElement`, so a removal is a
         * child-list change there. A replacement of `documentElement` itself
         * is a child-list change on the document. Neither target uses
         * `subtree`, because a subtree observer on a busy page reports every
         * insertion that the page makes.
         */
        const watch = (observer: MutationObserver): void => {
          observer.observe(doc, { childList: true });
          const root: Element | null = doc.documentElement;
          if (root !== null) observer.observe(root, { childList: true });
        };

        /**
         * Put the host back as soon as the page takes it away.
         *
         * The check above answers when we act. This answers while we wait: a
         * page that removes the host between two actions would leave a mode
         * stack that holds the keyboard over an interface that nobody sees.
         */
        yield* Effect.acquireRelease(
          dom.probeOr(() => {
            const observer = new MutationObserver(() => {
              Effect.runSyncExit(Effect.gen(function*() {
                // A new `documentElement` is a different node, so the
                // registration is renewed on each report.
                yield* dom.probeOr(() => {
                  watch(observer);
                  return true;
                }, false);
                if (yield* dom.probeOr(() => host.isConnected, true)) return;
                const count = yield* Ref.updateAndGet(
                  reattachments,
                  (current) => current + 1,
                );
                if (count > REATTACH_LIMIT) {
                  yield* dom.probeOr(() => {
                    observer.disconnect();
                    return true;
                  }, false);
                  return;
                }
                yield* ensureAttached;
              }));
            });
            watch(observer);
            return Option.some(observer);
          }, Option.none<MutationObserver>()),
          (observer) =>
            Effect.sync(() => {
              if (Option.isSome(observer)) observer.value.disconnect();
            }),
        );

        // ---------------------------------------------------------------
        // Exposure to assistive technology
        // ---------------------------------------------------------------

        const holds = yield* Ref.make<ReadonlyMap<HTMLElement, number>>(
          new Map(),
        );

        const setHidden = (element: HTMLElement, hidden: boolean): void => {
          if (hidden) element.setAttribute("aria-hidden", "true");
          else element.removeAttribute("aria-hidden");
        };

        /**
         * Publish the exposure state on the host and on every held layer.
         *
         * The host loses `aria-hidden` as well, because the attribute hides a
         * whole subtree. A dialog under a hidden host is a dialog that a
         * screen reader cannot reach.
         */
        const applyHolds = Effect.gen(function*() {
          const current = yield* Ref.get(holds);
          yield* dom.probeOr(() => {
            for (const [element, count] of current) {
              setHidden(element, count === 0);
            }
            setHidden(host, !anyHeld(current));
            return true;
          }, false);
        });

        const expose = Effect.fn("Ui.expose")(function*(layer: HTMLElement) {
          yield* Effect.acquireRelease(
            Effect.gen(function*() {
              yield* Ref.update(
                holds,
                (current) => shiftHold(current, layer, 1),
              );
              yield* applyHolds;
              yield* ensureAttached;
            }),
            () =>
              Effect.gen(function*() {
                yield* Ref.update(
                  holds,
                  (current) => shiftHold(current, layer, -1),
                );
                yield* applyHolds;
              }),
          );
        });

        const layerOf = Effect.fn("Ui.layer")(function*(name: UiLayerName) {
          yield* ensureAttached;
          const element = layers.get(name);
          if (element !== undefined) return element;
          // `LAYER_ORDER` covers every name, so this cannot happen. A detached
          // element is still better than a failure inside a key handler.
          return yield* Effect.sync(() => {
            const orphan = doc.createElement("div");
            orphan.className = "vw-layer";
            return orphan;
          });
        });

        // ---------------------------------------------------------------
        // The colour scheme
        // ---------------------------------------------------------------

        const schemeQuery = yield* dom.probeOr(
          () =>
            typeof win.matchMedia === "function"
              ? Option.fromNullishOr(
                win.matchMedia("(prefers-color-scheme: dark)"),
              )
              : Option.none<MediaQueryList>(),
          Option.none<MediaQueryList>(),
        );

        const resolveScheme = Effect.fn("Ui.resolveScheme")(function*() {
          const current = yield* settings.current;
          if (current.followPageColorScheme) {
            const page = yield* dom.probeOr(
              () => detectPageScheme(doc),
              Option.none<ColorScheme>(),
            );
            // `None` means that the page has no opinion that we can read. That
            // is not a reason to ignore the opinion of the user agent.
            if (Option.isSome(page)) return page.value;
          }
          const prefersDark = yield* dom.probeOr(
            () => Option.isSome(schemeQuery) && schemeQuery.value.matches,
            false,
          );
          return prefersDark ? "dark" : "light";
        });

        /**
         * Calculate the scheme again and publish it on the host.
         *
         * Run this after anything that can change the answer: a settings
         * change, a change of the system appearance, or a navigation that
         * replaced the theme of the page.
         */
        const syncColorScheme = Effect.gen(function*() {
          const scheme = yield* resolveScheme();
          yield* Effect.sync(() => {
            host.dataset["scheme"] = scheme;
          });
        });

        const schemeFiber = yield* FiberHandle.make<void, never>();

        if (Option.isSome(schemeQuery)) {
          yield* dom.listenOn(
            schemeQuery.value,
            "change",
            // Forked, because the scheme calculation reads a service and this
            // listener is not on the key path. A newer change interrupts the
            // one before it.
            () => Effect.asVoid(FiberHandle.run(schemeFiber, syncColorScheme)),
          );
        }

        // The setting is live. Rebuilding the overlay to read it again would
        // cost far more than one fiber that watches for the change.
        yield* Effect.forkScoped(
          Stream.runForEach(
            Stream.changes(
              Stream.map(
                settings.changes,
                (current) => current.followPageColorScheme,
              ),
            ),
            () => syncColorScheme,
          ),
        );

        yield* syncColorScheme;

        // ---------------------------------------------------------------
        // The visual viewport
        // ---------------------------------------------------------------

        const visualViewport = yield* dom.probeOr(
          () => Option.fromNullishOr(win.visualViewport),
          Option.none<VisualViewport>(),
        );

        /**
         * Move the whole overlay, so that a `position: fixed` child lines up
         * with the *visual* viewport and not the layout viewport.
         *
         * The two move apart under the dynamic toolbar of iOS, and during a
         * pinch zoom.
         */
        const syncViewport = (visual: VisualViewport): Effect.Effect<void> =>
          Effect.asVoid(dom.probeOr(() => {
            const { offsetLeft, offsetTop, scale } = visual;
            // The important priority again, and for two reasons. Page CSS must
            // not move the overlay, and `all: initial !important` above wins
            // over a normal declaration in the same block whatever the order.
            //
            // `none`, and not a removal: a removal would leave the page rule
            // as the only declaration for `transform`, and a page that writes
            // `transform: scale(0) !important` would then win.
            host.style.setProperty(
              "transform",
              offsetLeft === 0 && offsetTop === 0
                ? "none"
                : `translate(${offsetLeft}px, ${offsetTop}px)`,
              "important",
            );
            host.style.setProperty("width", `${visual.width}px`, "important");
            host.style.setProperty("height", `${visual.height}px`, "important");
            host.style.setProperty("--vw-scale", String(scale));
            return true;
          }, false));

        if (Option.isSome(visualViewport)) {
          const visual = visualViewport.value;
          const viewportFiber = yield* FiberHandle.make<void, never>();
          // One write for each animation frame. A resize and a scroll arrive
          // many times inside one frame, and a newer one interrupts the fiber
          // that the one before it started.
          const scheduleSync = Effect.asVoid(FiberHandle.run(
            viewportFiber,
            Effect.andThen(dom.nextFrame, syncViewport(visual)),
          ));
          yield* dom.listenOn(visual, "resize", () => scheduleSync);
          yield* dom.listenOn(visual, "scroll", () => scheduleSync);
          yield* syncViewport(visual);
        }

        const viewport: Effect.Effect<ViewportRect> = Effect.gen(function*() {
          if (Option.isSome(visualViewport)) {
            const visual = visualViewport.value;
            return yield* dom.probeOr(() => ({
              offsetLeft: visual.offsetLeft,
              offsetTop: visual.offsetTop,
              width: visual.width,
              height: visual.height,
              scale: visual.scale,
            }), FALLBACK_VIEWPORT);
          }
          return yield* dom.probeOr(() => ({
            offsetLeft: 0,
            offsetTop: 0,
            width: win.innerWidth,
            height: win.innerHeight,
            scale: 1,
          }), FALLBACK_VIEWPORT);
        });

        // ---------------------------------------------------------------
        // Ownership
        // ---------------------------------------------------------------

        /**
         * Does this event target belong to the overlay?
         *
         * The root is closed, so an event that starts inside it is
         * **retargeted to the host** before any listener on `window` sees it.
         * A comparison against the inner node therefore always fails from
         * outside, and that is how a capture-phase handler comes to swallow
         * the very keystrokes that our own text field had to receive. Both
         * forms are accepted: the host, and the true node as a listener inside
         * the shadow tree sees it.
         */
        const owns = (target: EventTarget | null): boolean => {
          if (target === null) return false;
          if (target === host) return true;
          return target instanceof Node && shadow.contains(target);
        };

        return Ui.of({
          shadow,
          layer: layerOf,
          ensureAttached,
          expose,
          addStyle,
          setStyle,
          syncColorScheme,
          owns,
          viewport,
        });
      }),
    );
}

/** What to answer when even a viewport read is refused. */
const FALLBACK_VIEWPORT: ViewportRect = {
  offsetLeft: 0,
  offsetTop: 0,
  width: 0,
  height: 0,
  scale: 1,
};
