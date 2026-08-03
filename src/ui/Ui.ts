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
 * can therefore name it, and page script can remove it or move it. Two measures
 * answer that: every inline declaration on the host carries the important
 * priority, and a mutation observer puts the host back under `documentElement`
 * when the page takes it away or moves it. See `HOST_STYLE` and the removal
 * guard below.
 *
 * The host cannot escape its own ancestors. Read the two classes of ancestor
 * rule at `outOfDateHostProperties`, and read `SECURITY.md`.
 *
 * **The invariant of this module.** The overlay never holds the keyboard while
 * the user cannot see it. `visibilityFault` measures the host box against the
 * viewport, and it reports the state of the removal guard. A feature that
 * holds the keyboard asks that question, gives the keyboard back when the
 * answer names a fault, and writes the reason in the console.
 *
 * Each layer of the overlay is hidden from assistive technology while it is
 * inactive, and `expose` opens one layer at a time. A hint marker decorates a
 * link that the page already offers, so a screen reader must not read it
 * twice; a dialog, a prompt and the omnibar are true controls, and a screen
 * reader must reach them. The HUD layer holds the host open for the whole
 * session, because its one line is a live region.
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
  Cause,
  Context,
  Effect,
  Exit,
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
  // The insets alone do not hold the size. A page rule of `width: 0
  // !important` wins over them, because a width beats the opposite inset. The
  // visual-viewport sync writes a pixel size over these two values, and it
  // runs only where `window.visualViewport` exists.
  ["width", "100%"],
  ["height", "100%"],
  ["pointer-events", "none"],
  ["z-index", "2147483647"],
  ["display", "block"],
  // Layout containment, so that the host is the containing block of every
  // layer inside it. Each layer is `position: fixed`, and a rule on `html`
  // such as `will-change: transform` makes `html` the containing block of a
  // fixed element. Without this declaration the layers took the size of the
  // whole document while the host itself was correct. A measurement in WebKit
  // gave a dialog of 2257 px inside a host of 800 px. The layers now follow
  // the host, which the sync and `alignHost` keep on the viewport.
  ["contain", "layout"],
  // `all: initial !important` already covers each property below, and a
  // measurement in WebKit confirms it. The true defect was the absent
  // important priority: `master` wrote each declaration with no priority, so
  // any important page rule won. Each property is still written one by one,
  // for two reasons. It is a defence against an engine whose `all` expansion
  // is incomplete, and it gives the guard below a longhand that it can
  // compare, because a shorthand does not serialise back.
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
 * What the host style must hold now.
 *
 * `owned` carries the properties that the visual-viewport sync writes:
 * `transform`, `width` and `height`. The guard compares against these values,
 * and the repair writes them, so a repair cannot undo the last sync.
 */
export const hostDeclarations = (
  owned: ReadonlyMap<string, string>,
): ReadonlyArray<readonly [string, string]> =>
  HOST_STYLE.map(([property, value]) =>
    [property, owned.get(property) ?? value] as const
  );

/**
 * The properties that the engine gave back exactly as we wrote them.
 *
 * The guard compares a value, so it can only watch a property whose
 * serialisation is stable. Two kinds of declaration are not:
 *
 * - A shorthand such as `all`, `margin` or `border`. An engine gives back an
 *   empty string, or a different form, so a comparison would always fail and
 *   the guard would write for ever.
 * - A property that this engine does not know. It keeps nothing, so it reads
 *   back empty.
 *
 * Call this once, on the host, in the same task that wrote the style. The
 * answer is therefore derived from `HOST_STYLE` itself. A second list written
 * by hand is what let `transform`, `clip-path` and `filter` go unwatched.
 */
export const comparableHostProperties = (
  read: (property: string) => readonly [value: string, priority: string],
): ReadonlySet<string> =>
  new Set(
    HOST_STYLE
      .filter(([property, value]) => {
        const [current, priority] = read(property);
        return current === value && priority === "important";
      })
      .map(([property]) => property),
  );

/**
 * Every property that `HOST_STYLE` writes.
 *
 * This is the fallback of the guarded set. A guard that cannot derive its set
 * must do more work, and not less: an empty set answers "nothing is stale" for
 * every property, so one refused read would turn the whole protection off in
 * silence. A property that this engine cannot compare costs one extra write
 * for each check, and that is the safe direction.
 */
export const allHostProperties = (): ReadonlySet<string> =>
  new Set(HOST_STYLE.map(([property]) => property));

/**
 * Must the guard put the host back?
 *
 * A connection test is not enough. Page script can move the host into a
 * container of its own, and give that container `opacity: 0`. The host stays
 * connected, so a guard that asked `isConnected` reported nothing, and the page
 * owned the visibility of an interface that still held the keyboard. The page
 * keeps its own visibility, because it chose the container.
 *
 * Test the parent instead. `parent` is the element that must hold the host, and
 * `current` is the node that holds it now. A `parent` of `null` means that the
 * document has no element yet, and then there is nothing to do.
 */
export const hostNeedsAttachment = (
  parent: Node | null,
  current: Node | null,
): boolean => parent !== null && current !== parent;

/**
 * The host properties that no longer hold the value that we wrote.
 *
 * Page script owns the host, because the host is in the light DOM. It can
 * write over the whole `style` attribute, and one call of
 * `style.removeProperty("clip-path")` is enough to let an important page rule
 * win for ever. A property with no important priority is therefore stale as
 * well, because a removed declaration reads back with an empty priority.
 *
 * The guard compares first and writes only when something changed. A write for
 * each check would make a page that watches the attribute fight us in a loop.
 *
 * **Limit.** This defends the host, and the host only. A page that writes a
 * rule on an *ancestor* of the host still reaches the overlay, because CSS
 * gives a descendant no way out of its ancestors. The removal guard keeps the
 * host a child of `documentElement`, so `html` is the only ancestor left.
 * There are exactly two classes of such rule, and the class decides both the
 * result and the answer.
 *
 * **Class 1: a rule that makes `html` the containing block of a fixed
 * descendant.** The overlay then holds a place in the document, and not in the
 * viewport, so it scrolls away with the page. The page itself is untouched and
 * fully readable. Example: `html { will-change: transform }`. The property is
 * not the definition; the effect is. Every property that gives an element a
 * transform, a containment, a filter or a perspective belongs to this class —
 * `transform`, `translate`, `rotate`, `scale`, `will-change`, `contain`,
 * `container-type`, `perspective`, `filter` and `backdrop-filter` — and so
 * does any future property with the same effect. `alignHost` answers this
 * class: it measures the host box and moves the host back on to the viewport.
 *
 * **Class 2: a rule that makes `html` paint nothing.** The overlay disappears,
 * and the page disappears with it, so the user sees a blank page and not a
 * hidden interface. Example: `html { opacity: 0 }`. `display: none`,
 * `visibility: hidden`, `content-visibility: hidden`, `filter: opacity(0)` and
 * `transform: scale(0)` belong here as well. No measure inside the script
 * answers this class, because a rule of our own on `html` would break every
 * honest page that fades or animates its root element.
 *
 * Class 1 leaves the page readable, and it is therefore the dangerous one.
 * `visibilityFault` measures what is left after `alignHost`, so an ancestor
 * that our correction cannot answer takes the keyboard away from the overlay.
 * `SECURITY.md` names both classes.
 *
 * `read` gives the current value and the current priority of one property, and
 * `guarded` names the properties that this engine can compare. Both are
 * parameters, so this function stays pure and a test needs no DOM.
 */
export const outOfDateHostProperties = (
  guarded: ReadonlySet<string>,
  read: (property: string) => readonly [value: string, priority: string],
  owned: ReadonlyMap<string, string>,
): readonly string[] =>
  hostDeclarations(owned)
    .filter(([property, value]) => {
      if (!guarded.has(property)) return false;
      const [current, priority] = read(property);
      return current !== value || priority !== "important";
    })
    .map(([property]) => property);

/**
 * How many times the guard puts the host back for each quiet second.
 *
 * A page that removes the host inside its own mutation observer would fight us
 * in a loop of microtasks, and that loop would starve the page. The loop needs
 * *our* write, so the guard stops writing after the cap. It keeps observing,
 * and it says that it stopped: see `guardYielded`.
 */
const REATTACH_LIMIT = 32;

/**
 * How long the host must stay attached before the count goes back to zero.
 *
 * The cap protects against a loop, and a loop happens inside one task. A
 * single-page application that replaces `documentElement` on each route is not
 * a loop, and a lifetime cap would take the guard away from it after 32
 * routes. One quiet second ends the loop, gives the count back, and repairs
 * the host again.
 */
const REATTACH_RESET_MS = 1000;

// ---------------------------------------------------------------------------
// What the user can see
// ---------------------------------------------------------------------------

/**
 * Why the user cannot see the overlay.
 *
 * - `misplaced` — the page holds the host somewhere else, and the guard has
 *   spent its repair budget for this second.
 * - `displaced` — the host box does not lie on the viewport, and `alignHost`
 *   could not correct it.
 *
 * A feature that holds the keyboard must give it back while a fault stands.
 * An interface that nobody can see must not take the keys of the user.
 */
export type OverlayFault = "misplaced" | "displaced";

/** The border box of the host, in the coordinates of the layout viewport. */
export interface HostBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** How far the host may sit from the viewport origin, in CSS pixels. */
const ORIGIN_TOLERANCE = 2;

/** How far the host must move before the correction writes anything. */
const SHIFT_TOLERANCE = 1;

/** The correction that keeps the host on the viewport. */
export interface HostShift {
  readonly dx: number;
  readonly dy: number;
}

/** No correction: the host lies where `position: fixed` promises. */
export const NO_SHIFT: HostShift = { dx: 0, dy: 0 };

/**
 * The `transform` value that puts the host on the visible viewport.
 *
 * `none`, and not a removal, for a zero offset: a removal would leave the page
 * rule as the only declaration for `transform`.
 */
export const hostTranslate = (x: number, y: number): string =>
  x === 0 && y === 0 ? "none" : `translate(${x}px, ${y}px)`;

/**
 * The declarations that the viewport sync owns.
 *
 * The guard compares against these values and the repair writes them, so a
 * repair can never undo the last sync.
 */
export const ownedDeclarations = (
  view: ViewportRect,
  shift: HostShift,
): ReadonlyMap<string, string> =>
  new Map<string, string>([
    [
      "transform",
      hostTranslate(view.offsetLeft + shift.dx, view.offsetTop + shift.dy),
    ],
    ["width", `${view.width}px`],
    ["height", `${view.height}px`],
  ]);

/**
 * How far the host is from the place that it must hold.
 *
 * `None` means that it lines up. A rule on `html` of class 1 makes `html` the
 * containing block of our fixed host, so the host holds a place in the
 * document instead of the viewport. The error is then the scroll offset, and
 * it is a pure translation, so one correction answers it.
 */
export const alignError = (
  box: HostBox,
  view: ViewportRect,
): Option.Option<HostShift> => {
  const dx = view.offsetLeft - box.left;
  const dy = view.offsetTop - box.top;
  return Math.abs(dx) < SHIFT_TOLERANCE && Math.abs(dy) < SHIFT_TOLERANCE
    ? Option.none()
    : Option.some({ dx, dy });
};

/**
 * Does the host box disagree with the visible viewport?
 *
 * This is a measurement, and not a list of CSS properties. A list written by
 * hand was incomplete three times. The origin says that an ancestor moved the
 * host, and the size says that an ancestor or a page rule made it small. Half
 * the viewport is the bound for the size, because a scrollbar and a rounding
 * both cost a few pixels and neither one hides an interface.
 */
export const hostIsDisplaced = (
  box: HostBox,
  view: ViewportRect,
): boolean =>
  Math.abs(box.left - view.offsetLeft) > ORIGIN_TOLERANCE ||
  Math.abs(box.top - view.offsetTop) > ORIGIN_TOLERANCE ||
  box.width < view.width / 2 ||
  box.height < view.height / 2;

/** What each fault says to the user, in the console. */
const FAULT_REASON: Readonly<Record<OverlayFault, string>> = {
  misplaced: "the page holds the overlay outside the document element",
  displaced: "a rule of the page takes the overlay out of the viewport",
};

/**
 * May the guard give the focus back to the node that held it?
 *
 * Only while nothing else holds the focus. `shadowActive` is the focused node
 * inside our closed root, and `documentActive` is the focused node of the
 * page, which is our host while the overlay holds the focus. A user who moved
 * the focus to the page keeps it, because the page then owns a node that is
 * neither `null` nor the body.
 */
export const focusIsFree = (
  shadowActive: Node | null,
  documentActive: Node | null,
  body: Node | null,
): boolean =>
  shadowActive === null &&
  (documentActive === null || documentActive === body);

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
   * Call this before an action that makes something visible. It is a small
   * number of cheap reads, and it never suspends, so the key path may reach
   * it.
   */
  readonly ensureAttached: Effect.Effect<void>;
  /**
   * Why the user cannot see the overlay, measured now.
   *
   * `None` means that the host lies on the viewport and that the removal guard
   * still repairs it. The call first repairs what it can: the style, the
   * place, and the offset of an ancestor that made `html` a containing block.
   * What is left is a fault that no measure of ours answers.
   *
   * **Every feature that holds the keyboard must ask this.** A mode that keeps
   * taking keys over an interface that nobody can see is the failure that this
   * module exists to prevent. Give the keyboard back, and write the reason in
   * the console: the HUD is inside the overlay, so it cannot carry the
   * message.
   */
  readonly visibilityFault: Effect.Effect<Option.Option<OverlayFault>>;
  /**
   * Show one layer to assistive technology while the scope is open.
   *
   * Every layer starts hidden from the accessibility tree, because a hint
   * marker and a find highlight decorate what the page already offers. A layer
   * that holds a dialog, a prompt or the omnibar must ask for attention with
   * this, and the release step hides it again. The host itself stays in the
   * tree while any layer holds it, and the HUD holds it for the whole session.
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
            // The HUD layer opens the host with `expose` as soon as it is
            // built. Until then the overlay is an empty positioning box, and
            // assistive technology must not see it.
            element.setAttribute("aria-hidden", "true");
            return element;
          }),
          (element) =>
            Effect.sync(() => {
              element.remove();
            }),
        );

        /** How the guard reads one property of the host. */
        const readHostProperty = (
          property: string,
        ): readonly [value: string, priority: string] => [
          host.style.getPropertyValue(property),
          host.style.getPropertyPriority(property),
        ];

        // Which properties this engine can compare, asked once and asked of
        // the engine itself. Page script cannot have run between the write
        // above and this read, because both are in the same task.
        const derivedProperties = yield* dom.probeOr(
          () => Option.some(comparableHostProperties(readHostProperty)),
          Option.none<ReadonlySet<string>>(),
        );
        // A safety mechanism must fail closed. An empty set would answer
        // "nothing is stale" for every property, so one refused read would
        // turn the whole protection off in silence. Compare everything
        // instead, and say so.
        if (Option.isNone(derivedProperties)) {
          yield* Effect.logWarning(
            "the overlay guard could not read the host style; " +
              "it now compares every property",
          );
        }
        const guardedProperties = Option.getOrElse(
          derivedProperties,
          allHostProperties,
        );

        // The values that the visual-viewport sync last wrote. The guard
        // compares against these, and the repair writes them again, so a
        // repair cannot put the overlay out of line with the visual viewport.
        const viewportOwned = yield* Ref.make<ReadonlyMap<string, string>>(
          new Map(),
        );

        // The node inside the overlay that last had the focus. A removal and a
        // move both take the focus away before the guard runs, so the guard
        // cannot read it at that moment. `focusin` remembers it.
        const lastFocused = yield* Ref.make<Option.Option<HTMLElement>>(
          Option.none(),
        );

        // How far the host must move to lie on the viewport. A rule on `html`
        // that makes it a containing block for a fixed child gives our host a
        // place in the document, and `alignHost` measures the error.
        const alignment = yield* Ref.make<HostShift>(NO_SHIFT);

        // Has the removal guard spent its repair budget for this second? While
        // this is true the page holds the host, so the overlay is not visible.
        const guardYielded = yield* Ref.make(false);

        // The fault that we reported last. One line for each change, and not
        // one line for each check.
        const lastFault = yield* Ref.make<Option.Option<OverlayFault>>(
          Option.none(),
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
        const restoreHostStyle = (owned: ReadonlyMap<string, string>): void => {
          const stale = outOfDateHostProperties(
            guardedProperties,
            readHostProperty,
            owned,
          );
          if (stale.length === 0) return;
          for (const [property, value] of hostDeclarations(owned)) {
            host.style.setProperty(property, value, "important");
          }
        };

        /**
         * Remember the node inside the overlay that has the focus.
         *
         * A removal takes the focus away at once, so the guard finds
         * `shadow.activeElement` empty when it runs. `focusin` is composed and
         * it bubbles, so one listener on the root sees every control.
         */
        yield* dom.listenOn(shadow, "focusin", (event) =>
          Ref.set(
            lastFocused,
            event.target instanceof HTMLElement
              ? Option.some(event.target)
              : Option.none(),
          ));

        /**
         * Give the focus back to the node that held it before a move.
         *
         * Only while nothing else holds the focus. `focusIsFree` holds that
         * rule, and it holds the promise of this comment: a user who moved the
         * focus to the page in the meantime keeps it.
         */
        const restoreFocus = (previous: Option.Option<HTMLElement>): void => {
          if (Option.isNone(previous)) return;
          const element = previous.value;
          if (!element.isConnected) return;
          if (!focusIsFree(shadow.activeElement, doc.activeElement, doc.body)) {
            return;
          }
          // `preventScroll`, because this is a repair and not an action of the
          // user. Nothing on the page may move.
          element.focus({ preventScroll: true });
        };

        /** The element that must hold the host, or `null` before it exists. */
        const hostParent = (): Element | null =>
          doc.documentElement ?? doc.body ?? null;

        /**
         * Put the host back in the document, with the style that we gave it.
         *
         * This runs at start, on every `layer` call, and before every action
         * that makes something visible. A single-page application replaces
         * `document.body` often, and some replace `documentElement`, which
         * detaches us without a sign. Page script can also delete our style,
         * or move the host into a container that it hides. The reads are
         * cheap, so paying for them at each access costs less than the failure
         * that they prevent: an interface that keeps the keyboard while the
         * user sees nothing.
         */
        const ensureAttached: Effect.Effect<void> = Effect.gen(function*() {
          const owned = yield* Ref.get(viewportOwned);
          const focused = yield* Ref.get(lastFocused);
          const keep = yield* dom.probeOr(() => {
            restoreHostStyle(owned);
            // At `document-start` there may be no `documentElement` yet. Doing
            // nothing is correct, because the next `layer` call tries again.
            const parent = hostParent();
            if (
              parent !== null && hostNeedsAttachment(parent, host.parentNode)
            ) {
              parent.appendChild(host);
              // A move takes the focus off every node inside the host. An open
              // dialog would otherwise keep the keyboard while the focus sits
              // on the body of the page.
              restoreFocus(focused);
            }
            // A control that left the document holds its whole dialog, with
            // every other control in it. Release it as soon as we see it.
            return Option.isSome(focused) && !focused.value.isConnected
              ? Option.none<HTMLElement>()
              : focused;
          }, focused);
          if (Option.isNone(keep) && Option.isSome(focused)) {
            yield* Ref.set(lastFocused, Option.none());
          }
        });

        // Attached once here, so that the overlay exists before any feature
        // asks for a layer.
        yield* ensureAttached;

        // ---------------------------------------------------------------
        // The removal guard
        // ---------------------------------------------------------------

        /**
         * Publish the reason why the user cannot see the overlay.
         *
         * One line for each change of the answer, and not one line for each
         * check. The console is the only channel that is left, because the HUD
         * is inside the overlay that the fault hides. The application installs
         * a console logger with a minimum level of `Warn`, so this line
         * reaches the developer and the user.
         */
        const publishFault = (
          next: Option.Option<OverlayFault>,
        ): Effect.Effect<Option.Option<OverlayFault>> =>
          Effect.gen(function*() {
            const previous = yield* Ref.getAndSet(lastFault, next);
            const same = Option.isNone(next)
              ? Option.isNone(previous)
              : Option.isSome(previous) && previous.value === next.value;
            if (same) return next;
            yield* Effect.logWarning(
              Option.isSome(next)
                ? `the overlay is not visible, so it gives the keyboard back: ${
                  FAULT_REASON[next.value]
                }`
                : "the overlay is visible again, and it takes its keys again",
            );
            return next;
          });

        const reattachments = yield* Ref.make(0);
        // One quiet second puts the count back to zero. A new reattachment
        // interrupts the fiber that the one before it started.
        const reattachReset = yield* FiberHandle.make<void, never>();

        /**
         * Repair the host again after one quiet second.
         *
         * This gives back the count **and** the repair. A cap that only
         * counted down would leave a page that spent the budget with the host
         * for the rest of the session.
         */
        const resumeGuard = Effect.gen(function*() {
          yield* Ref.set(reattachments, 0);
          const yielded = yield* Ref.getAndSet(guardYielded, false);
          yield* ensureAttached;
          if (yielded) yield* publishFault(Option.none());
        });

        /** Start the quiet second again. A newer report replaces an older one. */
        const armReset = Effect.asVoid(FiberHandle.run(
          reattachReset,
          Effect.andThen(Effect.sleep(REATTACH_RESET_MS), resumeGuard),
        ));

        // The services of this layer, for the observer callback. The callback
        // is an imperative caller, and `runSyncExitWith` is the bridge that
        // `ARCHITECTURE.md` section 3 names. `platform/Dom.ts` uses the same
        // helper for a listener.
        const services = yield* Effect.context<never>();
        const runGuard = Effect.runSyncExitWith(services);

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
         * Put the host back as soon as the page takes it away or moves it.
         *
         * The check above answers when we act. This answers while we wait: a
         * page that removes the host between two actions would leave a mode
         * stack that holds the keyboard over an interface that nobody sees.
         */
        yield* Effect.acquireRelease(
          dom.probeOr(() => {
            const observer = new MutationObserver(() => {
              const exit = runGuard(Effect.gen(function*() {
                // A new `documentElement` is a different node, so the
                // registration is renewed on each report.
                yield* dom.probeOr(() => {
                  watch(observer);
                  return true;
                }, false);
                // The parent, and not the connection. A host that the page
                // moved into a container of its own is still connected, and
                // the page then owns the visibility of the overlay.
                const misplaced = yield* dom.probeOr(
                  () => hostNeedsAttachment(hostParent(), host.parentNode),
                  false,
                );
                if (!misplaced) return;
                const count = yield* Ref.updateAndGet(
                  reattachments,
                  (current) => current + 1,
                );
                if (count > REATTACH_LIMIT) {
                  // The budget for this second is gone. Stop writing, because
                  // the loop needs our write, but **keep observing** and say
                  // what happened. A guard that disconnected here stayed
                  // silent for the rest of the session, and the page then held
                  // an invisible interface that still took every key.
                  yield* Ref.set(guardYielded, true);
                  yield* publishFault(Option.some("misplaced"));
                  yield* armReset;
                  return;
                }
                yield* Ref.set(guardYielded, false);
                yield* ensureAttached;
                yield* armReset;
              }));
              // A defect inside the guard must not disappear. The overlay is
              // gone at this moment, so a silent failure looks like a page
              // that won.
              if (Exit.isFailure(exit)) reportGuardFailure(exit.cause);
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
         * screen reader cannot reach. The HUD holds the host open for the
         * whole session, so in practice the host keeps the attribute off, and
         * each inactive layer stays hidden on its own.
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
        // The visual viewport, and the place of the host in it
        // ---------------------------------------------------------------

        const visualViewport = yield* dom.probeOr(
          () => Option.fromNullishOr(win.visualViewport),
          Option.none<VisualViewport>(),
        );

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

        /** Where the host lies now, or `None` when the read is refused. */
        const measureHost: Effect.Effect<Option.Option<HostBox>> = dom.probeOr(
          () => {
            const rect = host.getBoundingClientRect();
            return Option.some<HostBox>({
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            });
          },
          Option.none<HostBox>(),
        );

        /**
         * Write the declarations that the sync owns.
         *
         * They move the whole overlay, so that a `position: fixed` child lines
         * up with the *visual* viewport and not the layout viewport. The two
         * move apart under the dynamic toolbar of iOS, and during a pinch
         * zoom. `alignment` adds the correction of `alignHost`.
         */
        const applyOwned: Effect.Effect<void> = Effect.gen(function*() {
          const view = yield* viewport;
          const shift = yield* Ref.get(alignment);
          const owned = ownedDeclarations(view, shift);
          // The guard reads this, so it must agree with the style before the
          // next check. A repair then writes the viewport values again
          // instead of the constant `none` of `HOST_STYLE`.
          yield* Ref.set(viewportOwned, owned);
          yield* dom.probeOr(() => {
            // The important priority again, and for two reasons. Page CSS
            // must not move the overlay, and `all: initial !important` above
            // wins over a normal declaration in the same block whatever the
            // order.
            for (const [property, value] of owned) {
              host.style.setProperty(property, value, "important");
            }
            host.style.setProperty("--vw-scale", String(view.scale));
            return true;
          }, false);
        });

        /**
         * Put the host back on the viewport when an ancestor moved it.
         *
         * A rule on `html` such as `will-change: transform`, `contain: paint`
         * or `perspective: 1px` makes `html` the containing block of our fixed
         * host. The host then holds a place in the document, so it scrolls
         * away with the page while the page stays fully readable. A
         * measurement in WebKit shows it: with the page at 2759 px the dialog
         * box sat at -2711, and one translation of the measured error put it
         * back at 48.
         *
         * The error is a pure translation, so one correction answers it. When
         * a second measurement says that it did not, the ancestor does
         * something that we cannot undo, for example a scale. The correction
         * then goes back to nothing, and `visibilityFault` takes the keyboard
         * away from the overlay instead of fighting for the geometry.
         *
         * A page that does not do this pays one box read, and no write at all.
         */
        const alignHost: Effect.Effect<void> = Effect.gen(function*() {
          const view = yield* viewport;
          const before = yield* measureHost;
          if (Option.isNone(before)) return;
          const error = alignError(before.value, view);
          if (Option.isNone(error)) return;
          yield* Ref.update(alignment, (current) => ({
            dx: current.dx + error.value.dx,
            dy: current.dy + error.value.dy,
          }));
          yield* applyOwned;
          const after = yield* measureHost;
          if (Option.isNone(after)) return;
          if (Option.isNone(alignError(after.value, view))) return;
          yield* Ref.set(alignment, NO_SHIFT);
          yield* applyOwned;
        });

        const viewportFiber = yield* FiberHandle.make<void, never>();
        // One pass for each animation frame. A resize and a scroll arrive many
        // times inside one frame, and a newer one interrupts the fiber that
        // the one before it started.
        const scheduleSync = Effect.asVoid(FiberHandle.run(
          viewportFiber,
          Effect.andThen(
            dom.nextFrame,
            Option.isSome(visualViewport)
              ? Effect.andThen(applyOwned, alignHost)
              : alignHost,
          ),
        ));

        if (Option.isSome(visualViewport)) {
          const visual = visualViewport.value;
          yield* dom.listenOn(visual, "resize", () => scheduleSync);
          yield* dom.listenOn(visual, "scroll", () => scheduleSync);
          yield* applyOwned;
        }

        // The page scroll, because a host under a containing block of class 1
        // moves with the document. A page that does not have such an ancestor
        // pays one box read for each frame that it scrolls, and no write.
        yield* dom.listenOn(win, "scroll", () => scheduleSync, {
          passive: true,
        });
        yield* alignHost;

        /**
         * Why the user cannot see the overlay, measured now.
         *
         * The order is repair first, and judge afterwards: the style, the
         * place, and then the offset of an ancestor. What is left is a fault
         * that no measure of ours answers, and the caller must then give the
         * keyboard back to the page.
         */
        const visibilityFault: Effect.Effect<Option.Option<OverlayFault>> =
          Effect.gen(function*() {
            if (yield* Ref.get(guardYielded)) {
              return yield* publishFault(Option.some("misplaced"));
            }
            yield* ensureAttached;
            yield* alignHost;
            const box = yield* measureHost;
            // A realm that refuses the read tells us nothing. Claiming a fault
            // there would take the keyboard away for no measured reason.
            if (Option.isNone(box)) return yield* publishFault(Option.none());
            const view = yield* viewport;
            return yield* publishFault(
              hostIsDisplaced(box.value, view)
                ? Option.some("displaced")
                : Option.none(),
            );
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
          visibilityFault,
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

/**
 * Say that the removal guard failed.
 *
 * `console.error` and not a logger, for the same reason as in
 * `platform/Dom.ts`: this runs inside a callback of the browser, where a
 * throw would go nowhere and silence is the worse outcome.
 */
const reportGuardFailure = (cause: Cause.Cause<never>): void => {
  console.error(
    "[vimium-webkit] the overlay removal guard failed",
    Cause.pretty(cause),
  );
};
