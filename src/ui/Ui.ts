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
 * **The invariant of this module.** A dialog never holds the keyboard while
 * the measured overlay is not visible. `visibilityFault` asks where the host
 * is and whether its ancestors paint it. A feature that holds the keyboard
 * must ask that question. Issue #62 records the three features that do not ask
 * yet.
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
  Array,
  Boolean,
  Cause,
  Context,
  Data,
  Effect,
  Equal,
  Exit,
  FiberHandle,
  flow,
  Function,
  Iterable,
  Layer,
  Match,
  Option,
  Predicate,
  Record,
  Ref,
  Schema,
  Scope,
  Stream,
  pipe,
  Struct,
} from "effect";
import { Settings } from "~/core/Settings.ts";
import { Capabilities } from "~/platform/Capabilities.ts";
import { Dom } from "~/platform/Dom.ts";
import { BASE_CSS, type ColorScheme, detectPageScheme, schemeOf } from "~/ui/Styles.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UiError extends Schema.TaggedError<UiError>()("UiError", {
  reason: Schema.Literals(["unavailable"]),
  detail: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Layers of the overlay
// ---------------------------------------------------------------------------

export type UiLayerName = "hud" | "hints" | "find" | "dialog" | "omnibar";

/**
 * How a layer starts with respect to the pointer.
 *
 * An `interactive` layer holds a true control, and it can take pointer events
 * while it holds content. A `passive` layer holds decorations, or a control
 * that asks for the pointer only while it is open.
 */
type LayerPointer = "interactive" | "passive";

/**
 * The `data-interactive` attribute that a layer starts with.
 *
 * An interactive layer starts with `false`, so the page keeps every click
 * until a modal takes them. A passive layer starts with no attribute.
 */
const pointerAttribute = (pointer: LayerPointer): Option.Option<string> =>
  pipe(
    Match.value(pointer),
    Match.when("interactive", () => Option.some("false")),
    Match.when("passive", () => Option.none()),
    Match.exhaustive,
  );

/** Every layer, in stacking order, lowest first. */
const LAYERS: Record.ReadonlyRecord<UiLayerName, LayerPointer> = {
  hints: "passive",
  find: "passive",
  hud: "passive",
  omnibar: "interactive",
  dialog: "interactive",
};

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
export const acceptPointerEvents = (layer: HTMLElement): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      layer.dataset["interactive"] = "true";
    }),
    () =>
      Effect.sync(() => {
        layer.dataset["interactive"] = "false";
      }),
  );

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
  // This application custom property is outside `all`. Keep it in the derived
  // guard, so page script cannot remove or replace it without a repair.
  ["--vw-scale", "1"],
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

/** One property of the host as the engine gives it back. */
type HostRead = (property: string) => readonly [value: string, priority: string];

/** Does one declaration read back as we wrote it, with the important priority? */
const readsBack = ([current, priority]: readonly [string, string], value: string): boolean =>
  current === value && priority === "important";

/**
 * What the host style must hold now.
 *
 * `owned` carries the four properties that the visual-viewport sync writes.
 * They are `--vw-scale`, `transform`, `width` and `height`. The guard compares
 * these values, so a repair cannot undo the last sync.
 */
export const hostDeclarations = (
  owned: Record.ReadonlyRecord<string, string>,
): ReadonlyArray<readonly [string, string]> =>
  pipe(
    HOST_STYLE,
    Array.map(
      ([property, value]) =>
        [
          property,
          pipe(
            owned,
            Record.get(property),
            Option.getOrElse(() => value),
          ),
        ] as const,
    ),
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
export const comparableHostProperties = (read: HostRead): ReadonlySet<string> =>
  pipe(
    HOST_STYLE,
    Array.filter(([property, value]) => readsBack(read(property), value)),
    Array.map(([property]) => property),
    (properties) => new Set(properties),
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
  pipe(
    HOST_STYLE,
    Array.map(([property]) => property),
    (properties) => new Set(properties),
  );

/**
 * The element that must take the host back, if the host is not in it.
 *
 * A connection test is not enough. Page script can move the host into a
 * container of its own, and give that container `opacity: 0`. The host stays
 * connected, so a guard that asked `isConnected` reported nothing, and the page
 * owned the visibility of an interface that still held the keyboard. The page
 * keeps its own visibility, because it chose the container.
 *
 * Test the parent instead. `parent` is the element that must hold the host, and
 * `current` is the node that holds it now. A `parent` of `None` means that the
 * document has no element yet, and then there is nothing to do.
 */
export const reattachTo = <N>(parent: Option.Option<N>, current: unknown): Option.Option<N> =>
  pipe(
    parent,
    Option.filter((element) => element !== current),
  );

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
 * **Class 2: a rule that prevents `html` from painting.** The overlay and the
 * page disappear together. Example: `html { opacity: 0 }`. The visibility
 * check reads the computed paint properties of the host and its ancestors.
 * It detects hidden display, visibility, content visibility, zero opacity,
 * zero filter opacity and a full inset clip. This is an effect list, and not a
 * complete property list.
 *
 * Class 1 leaves the page readable, and it is therefore the dangerous one.
 * `visibilityFault` measures what is left after `alignHost`, and it also asks
 * whether the ancestor chain can paint. `SECURITY.md` names both classes.
 *
 * `read` gives the current value and the current priority of one property, and
 * `guarded` names the properties that this engine can compare. Both are
 * parameters, so this function stays pure and a test needs no DOM. A property
 * outside `guarded` is never read.
 */
export const outOfDateHostProperties = (
  guarded: ReadonlySet<string>,
  read: HostRead,
  owned: Record.ReadonlyRecord<string, string>,
): ReadonlyArray<string> =>
  pipe(
    hostDeclarations(owned),
    Array.filter(([property, value]) => guarded.has(property) && !readsBack(read(property), value)),
    Array.map(([property]) => property),
  );

/**
 * How many times the guard puts the host back for each quiet second.
 *
 * A page that removes the host inside its own mutation observer would fight us
 * in a loop of microtasks, and that loop would starve the page. The loop needs
 * *our* write, so the guard stops writing after the cap. It keeps observing,
 * and it says that it stopped: see `GuardState`.
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

/** The removal guard, between two quiet seconds. */
type GuardState = Data.TaggedEnum<{
  /** The guard puts the host back. `repairs` counts the repairs of this second. */
  Repairing: { readonly repairs: number };
  /**
   * The guard spent its repair budget for this second, so the page holds the
   * host and the overlay is not visible.
   */
  Yielded: Record.ReadonlyRecord<never, never>;
}>;
const GuardState = Data.taggedEnum<GuardState>();

/** The guard at the start, and after each quiet second. */
const FRESH_GUARD: GuardState = GuardState.Repairing({ repairs: 0 });

/**
 * The page took the host away once more.
 *
 * The budget for this second can run out here. The guard then stops writing,
 * because the loop needs our write, but it **keeps observing** and it says
 * what happened. A guard that disconnected here stayed silent for the rest of
 * the session, and the page then held an invisible interface that still took
 * every key.
 */
const afterRemoval: (guard: GuardState) => GuardState = GuardState.$match({
  Repairing: ({ repairs }) =>
    pipe(
      repairs + 1 > REATTACH_LIMIT,
      Boolean.match({
        onFalse: () => GuardState.Repairing({ repairs: repairs + 1 }),
        onTrue: () => GuardState.Yielded(),
      }),
    ),
  Yielded: () => GuardState.Yielded(),
});

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
 * - `hidden` — a computed paint property of the host or an ancestor hides it.
 *
 * A feature that holds the keyboard must give it back while a fault stands.
 * An interface that nobody can see must not take the keys of the user.
 */
export type OverlayFault = "misplaced" | "displaced" | "hidden";

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
  pipe(
    x === 0 && y === 0,
    Boolean.match({
      onFalse: () => `translate(${x}px, ${y}px)`,
      onTrue: () => "none",
    }),
  );

/**
 * The declarations that the viewport sync owns.
 *
 * The guard compares against these values and the repair writes them, so a
 * repair can never undo the last sync.
 */
export const ownedDeclarations = (
  view: ViewportRect,
  shift: HostShift,
): Record.ReadonlyRecord<string, string> => ({
  "--vw-scale": String(view.scale),
  transform: hostTranslate(view.offsetLeft + shift.dx, view.offsetTop + shift.dy),
  width: `${view.width}px`,
  height: `${view.height}px`,
});

/** Is a correction too small to write? A rounding of the engine is not an attack. */
const withinTolerance = ({ dx, dy }: HostShift): boolean =>
  Math.abs(dx) < SHIFT_TOLERANCE && Math.abs(dy) < SHIFT_TOLERANCE;

/**
 * How far the host is from the place that it must hold.
 *
 * `None` means that it lines up. A rule on `html` of class 1 makes `html` the
 * containing block of our fixed host, so the host holds a place in the
 * document instead of the viewport. The error is then the scroll offset, and
 * it is a pure translation, so one correction answers it.
 */
export const alignError = (box: HostBox, view: ViewportRect): Option.Option<HostShift> =>
  pipe(
    { dx: view.offsetLeft - box.left, dy: view.offsetTop - box.top },
    Option.liftPredicate(Predicate.not(withinTolerance)),
  );

/**
 * Does the host box disagree with the visible viewport?
 *
 * This is a measurement, and not a list of CSS properties. A list written by
 * hand was incomplete three times. The origin says that an ancestor moved the
 * host, and the size says that an ancestor or a page rule made it small. Half
 * the viewport is the bound for the size, because a scrollbar and a rounding
 * both cost a few pixels and neither one hides an interface.
 */
export const hostIsDisplaced = (box: HostBox, view: ViewportRect): boolean =>
  Math.abs(box.left - view.offsetLeft) > ORIGIN_TOLERANCE ||
  Math.abs(box.top - view.offsetTop) > ORIGIN_TOLERANCE ||
  box.width < view.width / 2 ||
  box.height < view.height / 2;

/** The computed properties that can prevent an element from painting. */
export interface PaintStyle {
  readonly display: string;
  readonly visibility: string;
  readonly opacity: string;
  readonly contentVisibility: string;
  readonly filter: string;
  readonly clipPath: string;
}

const INSET_CLIP = /^inset\(\s*([^)]*?)(?:\s+round\s+[^)]*)?\s*\)$/i;
const PERCENT = /^(\d+(?:\.\d+)?)%$/;
const FILTER_OPACITY = /opacity\(\s*(\d+(?:\.\d+)?)\s*(%)?\s*\)/gi;

/** A percentage, or `None` for any other length. */
const percentOf = (value: string): Option.Option<number> =>
  pipe(PERCENT.exec(value), Option.fromNullishOr, Option.flatMap(Array.get(1)), Option.map(Number));

/**
 * The one to four percentages of an `inset()` clip.
 *
 * `None` for any other clip, and for an inset that holds a length other than
 * a percentage.
 */
const insetPercents = (clipPath: string): Option.Option<Array.NonEmptyReadonlyArray<number>> =>
  pipe(
    INSET_CLIP.exec(clipPath),
    Option.fromNullishOr,
    Option.flatMap(Array.get(1)),
    Option.map((body) => pipe(body.trim().split(/\s+/), Array.map(percentOf))),
    Option.flatMap(Option.all),
    Option.filter(Array.isReadonlyArrayNonEmpty<number>),
    Option.filter((values) => values.length <= 4),
  );

/**
 * Do the insets of a clip collapse one axis of its box?
 *
 * The values follow the order of CSS: top, right, bottom and left. A missing
 * bottom takes the top, a missing right takes the top, and a missing left
 * takes the right.
 */
const insetsCollapse = (values: Array.NonEmptyReadonlyArray<number>): boolean => {
  const top = Array.headNonEmpty(values);
  const right = pipe(
    values,
    Array.get(1),
    Option.getOrElse(() => top),
  );
  const bottom = pipe(
    values,
    Array.get(2),
    Option.getOrElse(() => top),
  );
  const left = pipe(
    values,
    Array.get(3),
    Option.getOrElse(() => right),
  );
  return top + bottom >= 100 || right + left >= 100;
};

/** Does an `inset()` clip collapse one axis of its box? */
const insetClipsAll = (clipPath: string): boolean =>
  pipe(insetPercents(clipPath), Option.exists(insetsCollapse));

/** Does one `opacity()` of a filter hold zero? */
const zeroFilterMatch: (match: RegExpExecArray) => boolean = flow(
  Array.get(1),
  Option.map(Number),
  Option.exists((value) => Number.isFinite(value) && value <= 0),
);

/** Does a filter hold an `opacity()` of zero? */
const zeroFilterOpacity = (filter: string): boolean =>
  pipe(filter.matchAll(FILTER_OPACITY), Iterable.some(zeroFilterMatch));

/** Is an opacity of zero or less? Text that is not a number says nothing. */
const zeroOpacity = (opacity: string): boolean => {
  const value = Number.parseFloat(opacity);
  return Number.isFinite(value) && value <= 0;
};

/** Does one computed style prevent the overlay from painting? */
export const preventsOverlayPaint = (style: PaintStyle): boolean =>
  style.display === "none" ||
  style.visibility === "hidden" ||
  style.visibility === "collapse" ||
  style.contentVisibility === "hidden" ||
  zeroOpacity(style.opacity) ||
  zeroFilterOpacity(style.filter) ||
  insetClipsAll(style.clipPath);

/** What each fault says to the user, in the console. */
const FAULT_REASON: Record.ReadonlyRecord<OverlayFault, string> = {
  misplaced: "the page holds the overlay outside the document element",
  displaced: "a rule of the page takes the overlay out of the viewport",
  hidden: "a rule of the page prevents the overlay from painting",
};

/** The console line for a change of the answer. */
const faultMessage: (fault: Option.Option<OverlayFault>) => string = Option.match({
  onNone: () => "the overlay is visible again, and it takes its keys again",
  onSome: (fault: OverlayFault) =>
    `the overlay is not visible, so it gives the keyboard back: ${pipe(FAULT_REASON, Struct.get(fault))}`,
});

/**
 * May the guard give the focus back to the node that held it?
 *
 * Only while nothing else holds the focus. `shadowActive` is the focused node
 * inside our closed root, and `documentActive` is the focused node of the
 * page, which is our host while the overlay holds the focus. A user who moved
 * the focus to the page keeps it, because the page then owns a node that is
 * neither `null` nor the body.
 */
export const focusIsFree = <N>(
  shadowActive: N | null,
  documentActive: N | null,
  body: N | null,
): boolean => shadowActive === null && (documentActive === null || documentActive === body);

// ---------------------------------------------------------------------------
// Exposure to assistive technology
// ---------------------------------------------------------------------------

/**
 * Add `delta` to the number of holds on one layer.
 *
 * A hold is one open modal. Two nested holds on the same layer are normal: the
 * settings dialog opens over the help dialog, and the help dialog closes
 * afterwards. The layer stays exposed until the last hold goes.
 *
 * The map is keyed by the layer element itself, which no record can key.
 */
export const shiftHold = <K>(
  holds: ReadonlyMap<K, number>,
  key: K,
  delta: number,
): ReadonlyMap<K, number> => {
  const count = pipe(
    holds.get(key),
    Option.fromNullishOr,
    Option.getOrElse(() => 0),
  );
  return new Map(holds).set(key, Math.max(0, count + delta));
};

/** Does any layer hold the accessibility tree open? */
export const anyHeld = <K>(holds: ReadonlyMap<K, number>): boolean =>
  pipe(
    holds.values(),
    Iterable.some((count: number) => count > 0),
  );

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
type StyleTarget = Data.TaggedEnum<{
  Sheet: { readonly sheet: CSSStyleSheet };
  StyleElement: { readonly element: HTMLStyleElement };
}>;
const StyleTarget = Data.taggedEnum<StyleTarget>();

/** Write declarations on an element, each one with the important priority. */
const writeImportant = (
  element: HTMLElement,
): ((declarations: Iterable<readonly [string, string]>) => void) =>
  Iterable.forEach(([property, value]: readonly [string, string]) =>
    element.style.setProperty(property, value, "important"),
  );

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Ui extends Context.Service<
  Ui,
  {
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
     * `None` means that the host lies on the viewport and its ancestor chain can
     * paint. The call first repairs the style, the parent and the position. It
     * then reads the host box and the computed paint properties.
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
    readonly expose: (layer: HTMLElement) => Effect.Effect<void, never, Scope.Scope>;
    /** Append a stylesheet. */
    readonly addStyle: (css: string) => Effect.Effect<void>;
    /** Install or replace a stylesheet under a key, for anything derived from a live setting. */
    readonly setStyle: (key: string, css: string) => Effect.Effect<void>;
    readonly syncColorScheme: Effect.Effect<void>;
    readonly owns: (target: EventTarget | null) => boolean;
    readonly viewport: Effect.Effect<ViewportRect>;
  }
>()("vimium/ui/Ui") {
  static readonly layer: Layer.Layer<Ui, never, Dom | Capabilities | Settings> = Layer.effect(
    Ui,
    Effect.gen(function* () {
      const dom = yield* Dom;
      const capabilities = yield* Capabilities;
      const settings = yield* Settings;
      const doc = dom.document;
      const win = dom.window;

      // The layer scope, kept so that a stylesheet which arrives later is
      // still owned by this layer. `addStyle` and `setStyle` have no scope of
      // their own, and a stylesheet must live as long as the overlay.
      const layerScope = yield* Scope.Scope;

      // ---------------------------------------------------------------
      // The host and the shadow root
      // ---------------------------------------------------------------

      const host = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const element = doc.createElement("vimium-webkit-overlay");
          // `setProperty`, and not the camel-case accessors: `all` is a
          // shorthand that some engines do not give as an IDL attribute, and
          // only `setProperty` can give a declaration the important priority.
          // The priority is what stops page CSS from hiding us.
          writeImportant(element)(HOST_STYLE);
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
      const readHostProperty: HostRead = (property) => [
        host.style.getPropertyValue(property),
        host.style.getPropertyPriority(property),
      ];

      // Which properties this engine can compare, asked once and asked of
      // the engine itself. Page script cannot have run between the write
      // above and this read, because both are in the same task.
      const derivedProperties = yield* dom.probeOrElse(
        () => Option.some(comparableHostProperties(readHostProperty)),
        Option.none,
      );
      // A safety mechanism must fail closed. An empty set would answer
      // "nothing is stale" for every property, so one refused read would
      // turn the whole protection off in silence. Compare everything
      // instead, and say so.
      const guardedProperties = yield* pipe(
        derivedProperties,
        Option.match({
          onSome: (properties) => Effect.succeed(properties),
          onNone: () =>
            pipe(
              Effect.logWarning(
                "the overlay guard could not read the host style; " +
                  "it now compares every property",
              ),
              Effect.as(allHostProperties()),
            ),
        }),
      );

      // The values that the visual-viewport sync last wrote. The guard
      // compares against these, and the repair writes them again, so a
      // repair cannot put the overlay out of line with the visual viewport.
      const viewportOwned = yield* Ref.make<Record.ReadonlyRecord<string, string>>(Record.empty());

      // The node inside the overlay that last had the focus. A removal and a
      // move both take the focus away before the guard runs, so the guard
      // cannot read it at that moment. `focusin` remembers it.
      const lastFocused = yield* Ref.make<Option.Option<HTMLElement>>(Option.none());

      // How far the host must move to lie on the viewport. A rule on `html`
      // that makes it a containing block for a fixed child gives our host a
      // place in the document, and `alignHost` measures the error.
      const alignment = yield* Ref.make<HostShift>(NO_SHIFT);

      // The removal guard. While it has yielded, the page holds the host, so
      // the overlay is not visible.
      const guard = yield* Ref.make<GuardState>(FRESH_GUARD);

      // The fault that we reported last. One line for each change, and not
      // one line for each check.
      const lastFault = yield* Ref.make<Option.Option<OverlayFault>>(Option.none());

      // A realm that refuses a shadow root cannot hold the overlay at all.
      // There is no smaller unit to lose, so this is a defect and not a
      // failure that a caller could handle.
      const shadow = yield* pipe(
        dom.attempt("Element.attachShadow", () => host.attachShadow({ mode: "closed" })),
        Effect.mapError((error) => new UiError({ reason: "unavailable", detail: error.detail })),
        Effect.orDie,
      );

      // ---------------------------------------------------------------
      // Stylesheets
      // ---------------------------------------------------------------

      const adopted = yield* Ref.make<ReadonlyArray<CSSStyleSheet>>([]);
      const keyed = yield* Ref.make<Record.ReadonlyRecord<string, StyleTarget>>(Record.empty());

      const applyAdopted = Effect.gen(function* () {
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
      const makeSheet = (css: string): Effect.Effect<Option.Option<CSSStyleSheet>> =>
        pipe(
          capabilities.adoptedStyleSheets,
          Boolean.match({
            onFalse: () => Effect.succeedNone,
            onTrue: () =>
              dom.probeOrElse(() => {
                const sheet = new CSSStyleSheet();
                sheet.replaceSync(css);
                return Option.some(sheet);
              }, Option.none),
          }),
        );

      /** Adopt a constructed sheet for as long as the overlay lives. */
      const adoptSheet = (sheet: CSSStyleSheet): Effect.Effect<StyleTarget> => {
        const adopt = pipe(
          adopted,
          Ref.update<ReadonlyArray<CSSStyleSheet>>(Array.append(sheet)),
          Effect.andThen(applyAdopted),
        );
        const release = pipe(
          adopted,
          Ref.update<ReadonlyArray<CSSStyleSheet>>(Array.filter((one) => one !== sheet)),
          Effect.andThen(applyAdopted),
        );
        return pipe(
          Effect.acquireRelease(adopt, () => release),
          Effect.as(StyleTarget.Sheet({ sheet })),
          Scope.provide(layerScope),
        );
      };

      /**
       * Append a `<style>` element for as long as the overlay lives.
       *
       * One element for each stylesheet, and not one shared element. The
       * shared element could only grow: a keyed sheet that alternates between
       * two values appended both of them again for every change, and both
       * stayed in effect.
       */
      const appendStyleElement = (css: string): Effect.Effect<StyleTarget> =>
        pipe(
          Effect.acquireRelease(
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
          ),
          Effect.map((element) => StyleTarget.StyleElement({ element })),
          Scope.provide(layerScope),
        );

      const installStyle = Effect.fn("Ui.installStyle")(function* (css: string) {
        const made = yield* makeSheet(css);
        return yield* pipe(
          made,
          Option.match({
            onSome: adoptSheet,
            onNone: () => appendStyleElement(css),
          }),
        );
      });

      /** Give an installed stylesheet a new body. `false` when the engine refused it. */
      const replaceStyle = Effect.fn("Ui.replaceStyle")(function* (
        target: StyleTarget,
        css: string,
      ) {
        return yield* pipe(
          target,
          StyleTarget.$match({
            StyleElement: ({ element }) =>
              Effect.sync(() => {
                element.textContent = css;
                return true;
              }),
            Sheet: ({ sheet }) =>
              dom.probeOrElse(() => {
                sheet.replaceSync(css);
                return true;
              }, Function.constFalse),
          }),
        );
      });

      const addStyle = (css: string): Effect.Effect<void> => Effect.asVoid(installStyle(css));

      /** Install a stylesheet, and keep it under its key. */
      const installKeyed = (key: string, css: string): Effect.Effect<void> =>
        pipe(
          installStyle(css),
          Effect.flatMap((target) =>
            pipe(
              keyed,
              Ref.update<Record.ReadonlyRecord<string, StyleTarget>>(Record.set(key, target)),
            ),
          ),
        );

      /**
       * Install or replace a stylesheet under a key.
       *
       * `addStyle` appends, which is correct for the fixed sheets that go in
       * once at start, and wrong for anything derived from a setting.
       */
      const setStyle = Effect.fn("Ui.setStyle")(function* (key: string, css: string) {
        const existing = pipe(yield* Ref.get(keyed), Record.get(key));
        const replaced = yield* pipe(
          existing,
          Option.match({
            onNone: () => Effect.succeed(false),
            onSome: (target) => replaceStyle(target, css),
          }),
        );
        yield* pipe(
          replaced,
          Boolean.match({
            onFalse: () => installKeyed(key, css),
            onTrue: () => Effect.void,
          }),
        );
      });

      yield* addStyle(BASE_CSS);

      // ---------------------------------------------------------------
      // The layers
      // ---------------------------------------------------------------

      const makeLayer = (
        name: UiLayerName,
        pointer: LayerPointer,
      ): Effect.Effect<HTMLElement, never, Scope.Scope> =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const div = doc.createElement("div");
            div.className = "vw-layer";
            div.dataset["layer"] = name;
            pipe(
              pointerAttribute(pointer),
              Option.match({
                onNone: Function.constVoid,
                onSome: (value) => {
                  div.dataset["interactive"] = value;
                },
              }),
            );
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

      // One element for each name, appended in the stacking order of
      // `LAYERS`. `Effect.all` runs a record in the order of its keys.
      const layers = yield* pipe(
        LAYERS,
        Record.map((pointer, name) => makeLayer(name, pointer)),
        Effect.all,
      );

      /**
       * Write the host style again, but only where the page changed it.
       *
       * The comparison is what makes this safe to call often, and what stops
       * a page that watches the `style` attribute from fighting us in a
       * loop: an intact style produces no write at all.
       */
      const restoreHostStyle = (owned: Record.ReadonlyRecord<string, string>): void =>
        pipe(
          outOfDateHostProperties(guardedProperties, readHostProperty, owned),
          Array.match({
            onEmpty: Function.constVoid,
            onNonEmpty: () => writeImportant(host)(hostDeclarations(owned)),
          }),
        );

      const isHtmlElement = (target: EventTarget | null): target is HTMLElement =>
        target instanceof HTMLElement;

      /** Remember the node inside the overlay that has the focus, or that none has it. */
      const rememberFocus = (focused: Option.Option<HTMLElement>): Effect.Effect<void> =>
        pipe(lastFocused, Ref.set(focused));

      /**
       * Remember the node inside the overlay that has the focus.
       *
       * A removal takes the focus away at once, so the guard finds
       * `shadow.activeElement` empty when it runs. `focusin` is composed and
       * it bubbles, so one listener on the root sees every control.
       */
      yield* dom.listenOn(shadow, "focusin", (event) =>
        pipe(event.target, Option.liftPredicate(isHtmlElement), rememberFocus),
      );

      /**
       * Give the focus back to the node that held it before a move.
       *
       * Only while nothing else holds the focus. `focusIsFree` holds that
       * rule, and it holds the promise of this comment: a user who moved the
       * focus to the page in the meantime keeps it.
       */
      const restoreFocus: (previous: Option.Option<HTMLElement>) => void = flow(
        Option.filter(
          (element: HTMLElement) =>
            element.isConnected && focusIsFree(shadow.activeElement, doc.activeElement, doc.body),
        ),
        Option.match({
          onNone: Function.constVoid,
          // `preventScroll`, because this is a repair and not an action of
          // the user. Nothing on the page may move.
          onSome: (element) => element.focus({ preventScroll: true }),
        }),
      );

      /** The element that must hold the host, or `None` before it exists. */
      const hostParent = (): Option.Option<Element> =>
        pipe(
          Option.fromNullishOr<Element | null>(doc.documentElement),
          Option.orElse(() => Option.fromNullishOr<Element | null>(doc.body)),
        );

      /** Forget the node that had the focus. */
      const forgetFocus = rememberFocus(Option.none());

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
      const repairHost: Effect.Effect<void> = Effect.gen(function* () {
        const owned = yield* Ref.get(viewportOwned);
        const focused = yield* Ref.get(lastFocused);
        const departed = yield* dom.probeOrElse(() => {
          restoreHostStyle(owned);
          // At `document-start` there may be no `documentElement` yet. Doing
          // nothing is correct, because the next `layer` call tries again.
          pipe(
            reattachTo(hostParent(), host.parentNode),
            Option.match({
              onNone: Function.constVoid,
              onSome: (parent) => {
                parent.appendChild(host);
                // A move takes the focus off every node inside the host. An
                // open dialog would otherwise keep the keyboard while the
                // focus sits on the body of the page.
                restoreFocus(focused);
              },
            }),
          );
          return pipe(
            focused,
            Option.filter((element) => !element.isConnected),
          );
        }, Option.none);
        // A control that left the document holds its whole dialog, with
        // every other control in it. Release it as soon as we see it.
        yield* pipe(
          departed,
          Option.match({
            onNone: () => Effect.void,
            onSome: () => forgetFocus,
          }),
        );
      });

      // A visible action must measure again. This drops an old correction
      // when an honest page removes `will-change` after its animation.
      const ensureAttached = pipe(repairHost, Effect.andThen(Effect.suspend(() => alignHost)));

      // Attached once here, so that the overlay exists before any feature
      // asks for a layer.
      yield* repairHost;

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
        pipe(
          lastFault,
          Ref.getAndSet(next),
          Effect.flatMap((previous) =>
            pipe(
              Equal.equals(previous, next),
              Boolean.match({
                onFalse: () => Effect.logWarning(faultMessage(next)),
                onTrue: () => Effect.void,
              }),
            ),
          ),
          Effect.as(next),
        );

      // One quiet second resets the guard. A new reattachment interrupts the
      // fiber that the one before it started.
      const reattachReset = yield* FiberHandle.make<void, never>();

      /**
       * Repair the host again after one quiet second.
       *
       * This gives back the count **and** the repair. A cap that only
       * counted down would leave a page that spent the budget with the host
       * for the rest of the session.
       */
      const resumeGuard = Effect.gen(function* () {
        const previous = yield* pipe(guard, Ref.getAndSet(FRESH_GUARD));
        yield* repairHost;
        yield* pipe(
          previous,
          GuardState.$match({
            Repairing: () => Effect.void,
            Yielded: () => publishFault(Option.none()),
          }),
        );
      });

      /** Start the quiet second again. A newer report replaces an older one. */
      const armReset = pipe(
        Effect.sleep(REATTACH_RESET_MS),
        Effect.andThen(resumeGuard),
        FiberHandle.run(reattachReset),
        Effect.asVoid,
      );

      /** Answer one report that the page holds the host somewhere else. */
      const answerRemoval = Effect.gen(function* () {
        const state = yield* pipe(guard, Ref.updateAndGet(afterRemoval));
        yield* pipe(
          state,
          GuardState.$match({
            Repairing: () => repairHost,
            Yielded: () => publishFault(Option.some("misplaced")),
          }),
        );
        yield* armReset;
      });

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
        pipe(
          Option.fromNullishOr<Element | null>(doc.documentElement),
          Option.match({
            onNone: Function.constVoid,
            onSome: (root) => observer.observe(root, { childList: true }),
          }),
        );
      };

      /** One report of the observer. */
      const guardReport = (observer: MutationObserver): Effect.Effect<void> =>
        Effect.gen(function* () {
          // A new `documentElement` is a different node, so the
          // registration is renewed on each report.
          yield* dom.probeOrElse(() => watch(observer), Function.constVoid);
          // The parent, and not the connection. A host that the page moved
          // into a container of its own is still connected, and the page
          // then owns the visibility of the overlay.
          const misplaced = yield* dom.probeOrElse(
            () => reattachTo(hostParent(), host.parentNode),
            Option.none,
          );
          yield* pipe(
            misplaced,
            Option.match({
              onNone: () => Effect.void,
              onSome: () => answerRemoval,
            }),
          );
        });

      /**
       * Put the host back as soon as the page takes it away or moves it.
       *
       * The check above answers when we act. This answers while we wait: a
       * page that removes the host between two actions would leave a mode
       * stack that holds the keyboard over an interface that nobody sees.
       */
      yield* Effect.acquireRelease(
        dom.probeOrElse(() => {
          const observer = new MutationObserver(() =>
            pipe(
              runGuard(guardReport(observer)),
              // A defect inside the guard must not disappear. The overlay is
              // gone at this moment, so a silent failure looks like a page
              // that won.
              Exit.match({
                onFailure: reportGuardFailure,
                onSuccess: Function.constVoid,
              }),
            ),
          );
          watch(observer);
          return Option.some(observer);
        }, Option.none),
        (observer) =>
          Effect.sync(() =>
            pipe(
              observer,
              Option.match({
                onNone: Function.constVoid,
                onSome: (one) => one.disconnect(),
              }),
            ),
          ),
      );

      // ---------------------------------------------------------------
      // Exposure to assistive technology
      // ---------------------------------------------------------------

      const holds = yield* Ref.make<ReadonlyMap<HTMLElement, number>>(new Map());

      const setHidden = (element: HTMLElement, hidden: boolean): void =>
        pipe(
          hidden,
          Boolean.match({
            onFalse: () => element.removeAttribute("aria-hidden"),
            onTrue: () => element.setAttribute("aria-hidden", "true"),
          }),
        );

      /**
       * Publish the exposure state on the host and on every held layer.
       *
       * The host loses `aria-hidden` as well, because the attribute hides a
       * whole subtree. A dialog under a hidden host is a dialog that a
       * screen reader cannot reach. The HUD holds the host open for the
       * whole session, so in practice the host keeps the attribute off, and
       * each inactive layer stays hidden on its own.
       */
      const applyHolds = Effect.gen(function* () {
        const current = yield* Ref.get(holds);
        yield* dom.probeOrElse(() => {
          pipe(
            current,
            Iterable.forEach(([element, count]: readonly [HTMLElement, number]) =>
              setHidden(element, count === 0),
            ),
          );
          setHidden(host, !anyHeld(current));
        }, Function.constVoid);
      });

      const expose = Effect.fn("Ui.expose")(function* (layer: HTMLElement) {
        yield* Effect.acquireRelease(
          Effect.gen(function* () {
            yield* pipe(
              holds,
              Ref.update((current) => shiftHold(current, layer, 1)),
            );
            yield* applyHolds;
            yield* ensureAttached;
          }),
          () =>
            Effect.gen(function* () {
              yield* pipe(
                holds,
                Ref.update((current) => shiftHold(current, layer, -1)),
              );
              yield* applyHolds;
            }),
        );
      });

      const layerOf = Effect.fn("Ui.layer")(function* (name: UiLayerName) {
        yield* ensureAttached;
        return pipe(layers, Struct.get(name));
      });

      // ---------------------------------------------------------------
      // The colour scheme
      // ---------------------------------------------------------------

      const schemeQuery = yield* dom.probeOrElse(
        () =>
          pipe(
            win,
            Option.liftPredicate((view) => typeof view.matchMedia === "function"),
            Option.flatMap((view) =>
              Option.fromNullishOr(view.matchMedia("(prefers-color-scheme: dark)")),
            ),
          ),
        Option.none,
      );

      /**
       * The scheme of the page, when the setting asks for it.
       *
       * `None` also means that the page has no opinion that we can read. That
       * is not a reason to ignore the opinion of the user agent.
       */
      const pageScheme: (follow: boolean) => Effect.Effect<Option.Option<ColorScheme>> =
        Boolean.match({
          onFalse: () => Effect.succeedNone,
          onTrue: () => dom.probeOrElse(() => detectPageScheme(doc), Option.none),
        });

      /** The scheme of the user agent. */
      const agentScheme: Effect.Effect<ColorScheme> = pipe(
        dom.probeOrElse(
          () =>
            pipe(
              schemeQuery,
              Option.exists((query) => query.matches),
            ),
          Function.constFalse,
        ),
        Effect.map(schemeOf),
      );

      const resolveScheme = Effect.fn("Ui.resolveScheme")(function* () {
        const current = yield* settings.current;
        const page = yield* pageScheme(current.followPageColorScheme);
        return yield* pipe(
          page,
          Option.match({
            onNone: () => agentScheme,
            onSome: (scheme) => Effect.succeed(scheme),
          }),
        );
      });

      /**
       * Calculate the scheme again and publish it on the host.
       *
       * Run this after anything that can change the answer: a settings
       * change, a change of the system appearance, or a navigation that
       * replaced the theme of the page.
       */
      const syncColorScheme = Effect.gen(function* () {
        const scheme = yield* resolveScheme();
        yield* Effect.sync(() => {
          host.dataset["scheme"] = scheme;
        });
      });

      const schemeFiber = yield* FiberHandle.make<void, never>();

      yield* pipe(
        schemeQuery,
        Option.match({
          onNone: () => Effect.void,
          onSome: (query) =>
            dom.listenOn(
              query,
              "change",
              // Forked, because the scheme calculation reads a service and this
              // listener is not on the key path. A newer change interrupts the
              // one before it.
              () => pipe(syncColorScheme, FiberHandle.run(schemeFiber), Effect.asVoid),
            ),
        }),
      );

      // The setting is live. Rebuilding the overlay to read it again would
      // cost far more than one fiber that watches for the change.
      yield* pipe(
        settings.changes,
        Stream.map((current) => current.followPageColorScheme),
        Stream.changes,
        Stream.runForEach(() => syncColorScheme),
        Effect.forkScoped,
      );

      yield* syncColorScheme;

      // ---------------------------------------------------------------
      // The visual viewport, and the place of the host in it
      // ---------------------------------------------------------------

      const visualViewport = yield* dom.probeOrElse(
        () => Option.fromNullishOr(win.visualViewport),
        Option.none,
      );

      const viewport: Effect.Effect<ViewportRect> = pipe(
        visualViewport,
        Option.match({
          onSome: (visual) =>
            dom.probeOrElse(
              () => ({
                offsetLeft: visual.offsetLeft,
                offsetTop: visual.offsetTop,
                width: visual.width,
                height: visual.height,
                scale: visual.scale,
              }),
              () => FALLBACK_VIEWPORT,
            ),
          onNone: () =>
            dom.probeOrElse(
              () => ({
                offsetLeft: 0,
                offsetTop: 0,
                width: win.innerWidth,
                height: win.innerHeight,
                scale: 1,
              }),
              () => FALLBACK_VIEWPORT,
            ),
        }),
      );

      /** Where the host lies now, or `None` when the read is refused. */
      const measureHost: Effect.Effect<Option.Option<HostBox>> = dom.probeOrElse(() => {
        const rect = host.getBoundingClientRect();
        return Option.some<HostBox>({
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        });
      }, Option.none);

      /** How far the host is from the viewport now. `None` when it lines up or the read is refused. */
      const hostError = (view: ViewportRect): Effect.Effect<Option.Option<HostShift>> =>
        pipe(measureHost, Effect.map(Option.flatMap((box) => alignError(box, view))));

      /**
       * Write the declarations that the sync owns.
       *
       * They move the whole overlay, so that a `position: fixed` child lines
       * up with the *visual* viewport and not the layout viewport. The two
       * move apart under the dynamic toolbar of iOS, and during a pinch
       * zoom. They also publish the scale. `alignment` adds the correction
       * of `alignHost`.
       */
      const applyOwned: Effect.Effect<void> = Effect.gen(function* () {
        const view = yield* viewport;
        const shift = yield* Ref.get(alignment);
        const owned = ownedDeclarations(view, shift);
        // The guard reads this, so it must agree with the style before the
        // next check. A repair then writes the viewport values again
        // instead of the constant `none` of `HOST_STYLE`.
        yield* pipe(viewportOwned, Ref.set(owned));
        // The important priority again, and for two reasons. Page CSS must
        // not move the overlay, and `all: initial !important` above wins
        // over a normal declaration in the same block whatever the order.
        yield* dom.probeOrElse(
          () => writeImportant(host)(Record.toEntries(owned)),
          Function.constVoid,
        );
      });

      /**
       * The correction did not hold, so the ancestor does something that we
       * cannot undo. Give the correction up.
       */
      const dropAlignment = pipe(alignment, Ref.set(NO_SHIFT), Effect.andThen(applyOwned));

      /** Move the host by the measured error, and measure again. */
      const correctBy = (error: HostShift, view: ViewportRect): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* pipe(
            alignment,
            Ref.update((current) => ({ dx: current.dx + error.dx, dy: current.dy + error.dy })),
          );
          yield* applyOwned;
          const residual = yield* hostError(view);
          yield* pipe(
            residual,
            Option.match({
              onNone: () => Effect.void,
              onSome: () => dropAlignment,
            }),
          );
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
      const alignHost: Effect.Effect<void> = Effect.gen(function* () {
        const view = yield* viewport;
        const error = yield* hostError(view);
        yield* pipe(
          error,
          Option.match({
            onNone: () => Effect.void,
            onSome: (shift) => correctBy(shift, view),
          }),
        );
      });

      /** One pass of the sync. The owned declarations need a visual viewport. */
      const syncPass: Effect.Effect<void> = pipe(
        visualViewport,
        Option.match({
          onNone: () => alignHost,
          onSome: () => pipe(applyOwned, Effect.andThen(alignHost)),
        }),
      );

      const viewportFiber = yield* FiberHandle.make<void, never>();
      // One pass for each animation frame. A resize and a scroll arrive many
      // times inside one frame, and a newer one interrupts the fiber that
      // the one before it started.
      const scheduleSync = pipe(
        dom.nextFrame,
        Effect.andThen(syncPass),
        FiberHandle.run(viewportFiber),
        Effect.asVoid,
      );

      /** Follow the visual viewport, where the engine has one. */
      const followVisualViewport = (visual: VisualViewport) =>
        Effect.gen(function* () {
          yield* dom.listenOn(visual, "resize", () => scheduleSync);
          yield* dom.listenOn(visual, "scroll", () => scheduleSync);
          yield* applyOwned;
        });

      yield* pipe(
        visualViewport,
        Option.match({
          onNone: () => Effect.void,
          onSome: followVisualViewport,
        }),
      );

      // The page scroll, because a host under a containing block of class 1
      // moves with the document. A page that does not have such an ancestor
      // pays one box read for each frame that it scrolls, and no write.
      yield* dom.listenOn(win, "scroll", () => scheduleSync, {
        passive: true,
      });
      yield* alignHost;

      /** The host and every element above it, nearest first. */
      const ancestry = (element: Element): Iterable<Element> =>
        Iterable.unfold(
          Option.some(element),
          Option.map((one: Element) => [one, Option.fromNullishOr(one.parentElement)] as const),
        );

      /**
       * The first element of the ancestor chain that does not paint.
       *
       * The chain is walked lazily, so a page pays one computed style for
       * each element up to the first that hides the host.
       */
      const hidingAncestor: Effect.Effect<Option.Option<Element>> = dom.probeOrElse(
        () =>
          pipe(
            ancestry(host),
            Iterable.findFirst((element: Element) =>
              preventsOverlayPaint(win.getComputedStyle(element)),
            ),
          ),
        Option.none,
      );

      /** The fault of a host box that the engine gave us. */
      const faultOfBox = (box: HostBox): Effect.Effect<Option.Option<OverlayFault>> =>
        Effect.gen(function* () {
          const view = yield* viewport;
          return yield* pipe(
            hostIsDisplaced(box, view),
            Boolean.match({
              onFalse: () => pipe(hidingAncestor, Effect.map(Option.as<OverlayFault>("hidden"))),
              onTrue: () => Effect.succeedSome<OverlayFault>("displaced"),
            }),
          );
        });

      /**
       * Measure the fault while the guard holds the host.
       *
       * The order is repair first, and judge afterwards. Repair the style,
       * the parent and the position. Then measure the box and ask whether
       * the ancestor chain can paint. The caller gives the keyboard back for
       * either fault.
       */
      const measureFault: Effect.Effect<Option.Option<OverlayFault>> = pipe(
        ensureAttached,
        Effect.andThen(measureHost),
        Effect.flatMap(
          Option.match({
            // A realm that refuses the read tells us nothing. Claiming a fault
            // there would take the keyboard away for no measured reason.
            onNone: () => Effect.succeedNone,
            onSome: faultOfBox,
          }),
        ),
      );

      /** Why the user cannot see the overlay, measured now. */
      const visibilityFault: Effect.Effect<Option.Option<OverlayFault>> = pipe(
        Ref.get(guard),
        Effect.flatMap(
          GuardState.$match({
            Repairing: () => measureFault,
            Yielded: () => Effect.succeedSome<OverlayFault>("misplaced"),
          }),
        ),
        Effect.flatMap(publishFault),
      );

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
      const owns = (target: EventTarget | null): boolean =>
        target === host || (target instanceof Node && shadow.contains(target));

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
  console.error("[vimium-webkit] the overlay removal guard failed", Cause.pretty(cause));
};
