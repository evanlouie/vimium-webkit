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
 */
const HOST_STYLE: ReadonlyArray<readonly [string, string]> = [
  ["all", "initial"],
  ["position", "fixed"],
  ["inset", "0"],
  ["pointer-events", "none"],
  ["z-index", "2147483647"],
  ["display", "block"],
  ["margin", "0"],
  ["padding", "0"],
  ["border", "0"],
];

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
              // `setProperty`, and not the camel-case accessors: `all` and
              // `inset` are shorthands that some engines do not give as IDL
              // attributes.
              element.style.setProperty(property, value);
            }
            // Assistive technology must not see an empty positioning box. A
            // layer asks for attention again when it draws something.
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
         * Put the host back in the document.
         *
         * This runs at start, and again on every `layer` call. A single-page
         * application replaces `document.body` often, and some replace
         * `documentElement`, which detaches us without a sign. An
         * `isConnected` read is one bit, so paying it for each access costs
         * less than any observer would.
         */
        const attach = Effect.asVoid(dom.probeOr(() => {
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
        yield* attach;

        const layerOf = Effect.fn("Ui.layer")(function*(name: UiLayerName) {
          yield* attach;
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
            host.style.transform = offsetLeft === 0 && offsetTop === 0
              ? ""
              : `translate(${offsetLeft}px, ${offsetTop}px)`;
            host.style.width = `${visual.width}px`;
            host.style.height = `${visual.height}px`;
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
