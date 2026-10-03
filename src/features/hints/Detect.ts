/**
 * Element detection.
 *
 * Ported from the Vimium `content_scripts/link_hints.js`
 * (`LocalHints.getLocalHints`, `getVisibleClickable`) and `lib/dom_utils.js`
 * (`getVisibleClientRect`, `cropRectToVisible`, `getClientRectsForAreas`), MIT.
 *
 * The shape of the pipeline is the shape of upstream, and it does not depend on
 * the engine. What is *not* upstream, and what this file exists to get right:
 *
 * - the whole pass runs in time-boxed slices, because Safari has no
 *   `requestIdleCallback`, and a synchronous walk over a document of five
 *   thousand nodes drops frames; the walk of the tree is one of those slices,
 *   and `mapChunked` carries the two passes over what the walk found;
 * - visibility goes through `Element.checkVisibility` where it exists, because
 *   `content-visibility: auto` (Safari 18) makes `getBoundingClientRect()`
 *   report old geometry inside a subtree that the engine skipped;
 * - geometry is cropped against the *visual* viewport, and not against
 *   `window.innerHeight`, because the two differ on iOS under the dynamic
 *   toolbar;
 * - occlusion uses `document.elementsFromPoint`, because the singular form
 *   gives the retargeted shadow host by specification, and would then refuse
 *   every hint inside a web component.
 *
 * The pass is interruptible from its first slice. Each slice gives control
 * back to the browser, and that point is where interruption takes effect. A
 * second `f`, or Escape, therefore stops the detection that runs. Read the
 * comment above `ElementWalk` for the division of the work.
 */

import {
  Array,
  Boolean,
  Data,
  Effect,
  Match,
  Option,
  Predicate,
  Record,
  String as Str,
  flow,
  pipe,
} from "effect";
import { constTrue } from "effect/Function";
import type { CapabilityReport } from "~/platform/Capabilities.ts";
import type { Dom } from "~/platform/Dom.ts";
import { containsDeep, shadowHostChain } from "~/platform/Elements.ts";
import {
  CHUNK_BUDGET_MS,
  type ChunkedOptions,
  mapChunked,
  repeatInSlices,
} from "~/platform/Scheduler.ts";
import type { ViewportRect } from "~/ui/Ui.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HintRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Why an element was hinted. It drives activation and the filter-mode label. */
export type HintKind =
  | "area"
  | "framework"
  | "onclick"
  | "role"
  | "contenteditable"
  | "native"
  | "class"
  | "span"
  | "tabindex";

/** A variant with no fields. The type `{}` would mean any value that is not nullish. */
type NoFields = Record.ReadonlyRecord<never, never>;

/**
 * How strong the signal was that earned a hint.
 *
 * `Secondary` is the "second-class citizen" of upstream: hinted on a weak
 * signal (a class name, a bare `<span>`, a `tabindex`). It sorts after
 * everything else, so that the good hints get the short strings, and it is a
 * suspected false positive, which is filtered against nearby descendants.
 */
export type HintRank = Data.TaggedEnum<{
  Primary: NoFields;
  Secondary: NoFields;
}>;

export const HintRank = Data.taggedEnum<HintRank>();

/** Is this a second-class hint? */
export const isSecondary = (hint: LocalHint): boolean => HintRank.$is("Secondary")(hint.rank);

/**
 * Which elements a detection pass hints.
 *
 * `Linked` keeps only an element that truly has a URL. The new-tab, copy-URL
 * and omnibar modes act on the URL, so a hint without one would do nothing.
 */
export type HintTargets = Data.TaggedEnum<{
  Clickable: NoFields;
  Linked: NoFields;
}>;

export const HintTargets = Data.taggedEnum<HintTargets>();

export interface LocalHint {
  /** For an image map this is the `<area>`, and not the `<img>`. */
  readonly element: Element;
  /**
   * The element that the occlusion test must accept, when it is not `element`.
   *
   * Only an image map needs this. An `<area>` lives inside a `<map>` that is
   * not laid out, so `elementsFromPoint` gives the `<img>`, which neither
   * contains the area nor is contained by it. Every hint would then be dropped
   * as occluded. The test must still *run*, because an area under a fixed
   * overlay is truly unreachable. It is only evaluated against the image.
   */
  readonly hitTarget: Option.Option<Element>;
  /** Layout-viewport coordinates, cropped to the visible region. */
  readonly rect: HintRect;
  readonly kind: HintKind;
  readonly rank: HintRank;
  /** The text that filter mode matches, that a copy mode copies, and that the wire carries. */
  readonly linkText: string;
  /**
   * The text that filter mode draws beside the marker. The `showLinkText` of
   * upstream: it is the link text of an element that shows no text of its own.
   */
  readonly label: Option.Option<string>;
  /** The absolute URL, when the element navigates. */
  readonly href: Option.Option<string>;
}

export interface DetectOptions {
  readonly window: Window & typeof globalThis;
  readonly document: Document;
  readonly capabilities: CapabilityReport;
  /** From `Ui.viewport`, which comes from `visualViewport` on iOS. */
  readonly viewport: ViewportRect;
  readonly targets: HintTargets;
  /**
   * Our own overlay host, which the hit test skips.
   *
   * The host is `pointer-events: none`, so it must never be hit. This is the
   * second guard, because one stray hit would refuse every hint on the page,
   * and the failure would look like "hints stopped working".
   */
  readonly overlayHost: Option.Option<Element>;
}

export interface DetectionResult {
  readonly hints: readonly LocalHint[];
  /** True when the safety limit stopped discovery before the tree ended. */
  readonly truncated: boolean;
  /**
   * How many elements look like the host of a closed shadow root.
   *
   * Their content cannot be reached: `element.shadowRoot` is `null` by design,
   * and a patch of `attachShadow` needs a reliable `document-start` that WebKit
   * does not give a userscript. The only honest answer is to tell the user.
   */
  readonly unreachableHosts: number;
}

// ---------------------------------------------------------------------------
// Classification tables
// ---------------------------------------------------------------------------

/** The several spellings of Angular. Each one implies a click listener. */
const FRAMEWORK_CLICK_ATTRIBUTES: ReadonlyArray<string> = [
  "ng-click",
  "data-ng-click",
  "x-ng-click",
];

const CLICKABLE_ROLES: ReadonlyArray<string> = [
  "button",
  "link",
  "checkbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "radio",
  "tab",
  "option",
  "switch",
  "treeitem",
  "combobox",
];

const EDITABLE_VALUES: ReadonlyArray<string> = ["", "contenteditable", "true", "plaintext-only"];

/** The values of `aria-disabled` that declare an element inert. */
const DISABLED_VALUES: ReadonlyArray<string> = ["", "true"];

/** The kinds that a weak signal gives. */
type WeakKind = Extract<HintKind, "class" | "span" | "tabindex">;

/**
 * Why an element deserves a hint, and how strong the signal is.
 *
 * The strength decides two things at once. A weak signal sorts after every
 * strong one, and it is a suspected false positive.
 */
export type Classification = Data.TaggedEnum<{
  Clickable: {
    readonly kind: Exclude<HintKind, WeakKind | "area">;
    /** The `reason` of upstream. It is shown in place of the absent link text. */
    readonly reason: Option.Option<string>;
  };
  /**
   * The "second-class citizen" of upstream: hinted on a weak signal (a class
   * name, a bare `<span>`, a `tabindex`).
   */
  WeaklyClickable: { readonly kind: WeakKind };
}>;

export const Classification = Data.taggedEnum<Classification>();

const NATIVE = Classification.Clickable({ kind: "native", reason: Option.none() });
const OPENS = Classification.Clickable({ kind: "native", reason: Option.some("Open.") });
const ZOOMS = Classification.Clickable({ kind: "native", reason: Option.some("Zoom.") });
const SCROLLS = Classification.Clickable({ kind: "native", reason: Option.some("Scroll.") });
const FRAMEWORK = Classification.Clickable({ kind: "framework", reason: Option.none() });
const ONCLICK = Classification.Clickable({ kind: "onclick", reason: Option.none() });
const ROLE = Classification.Clickable({ kind: "role", reason: Option.none() });
const EDITABLE = Classification.Clickable({ kind: "contenteditable", reason: Option.none() });
const CLASS = Classification.WeaklyClickable({ kind: "class" });
const SPAN = Classification.WeaklyClickable({ kind: "span" });
const TABINDEX = Classification.WeaklyClickable({ kind: "tabindex" });

const PRIMARY = HintRank.Primary();
const SECONDARY = HintRank.Secondary();

/** What a hint keeps of the classification that earned it. */
interface Traits {
  readonly kind: HintKind;
  readonly reason: Option.Option<string>;
  readonly rank: HintRank;
}

const traitsOf: (classification: Classification) => Traits = Classification.$match({
  Clickable: ({ kind, reason }) => ({ kind, reason, rank: PRIMARY }),
  WeaklyClickable: ({ kind }) => ({ kind, reason: Option.none(), rank: SECONDARY }),
});

// ---------------------------------------------------------------------------
// Element narrowing
// ---------------------------------------------------------------------------

const isHtmlElement = (element: Element): element is HTMLElement => element instanceof HTMLElement;

const isInput = (element: Element): element is HTMLInputElement =>
  element instanceof HTMLInputElement;

const isAnchor = (element: Element): element is HTMLAnchorElement =>
  element instanceof HTMLAnchorElement;

const isImage = (element: Element): element is HTMLImageElement =>
  element instanceof HTMLImageElement;

const isLabel = (element: Element): element is HTMLLabelElement =>
  element instanceof HTMLLabelElement;

const isLink = (element: Element): element is HTMLAnchorElement | HTMLAreaElement =>
  element instanceof HTMLAnchorElement || element instanceof HTMLAreaElement;

// ---------------------------------------------------------------------------
// Attribute probes
// ---------------------------------------------------------------------------

// Classification runs these for every element of the page. Each stage that
// does not depend on the element is built once, here, and not for each call.

const attributeOf = (element: Element, name: string): Option.Option<string> =>
  Option.fromNullishOr(element.getAttribute(name));

const hasAttribute =
  (name: string) =>
  (element: Element): boolean =>
    element.hasAttribute(name);

/** Does the attribute, in lower case, hold one of `values`? */
const attributeIn = (
  name: string,
  values: ReadonlyArray<string>,
): ((element: Element) => boolean) => {
  const holdsOne = Option.exists<string>((value) =>
    pipe(values, Array.contains(value.toLowerCase())),
  );
  return (element) => holdsOne(attributeOf(element, name));
};

/** One rule of a `jsaction` attribute, taken apart. */
interface JsActionBinding {
  readonly eventType: string;
  readonly namespace: string;
  readonly action: string;
}

/**
 * Parse one rule, `"eventType:namespace.action"`.
 *
 * A rule without an event type binds `click`, and a rule without an action
 * binds `_`. A rule with more than one colon is not a binding.
 */
const jsActionBinding = (rule: string): Option.Option<JsActionBinding> =>
  pipe(
    rule.trim(),
    Str.split(":"),
    Option.liftPredicate((parts: ReadonlyArray<string>) => parts.length <= 2),
    Option.map((parts) => {
      const body = pipe(Array.lastNonEmpty(parts), Str.trim, Str.split("."));
      return {
        eventType: pipe(
          Array.initNonEmpty(parts),
          Array.head,
          Option.map(Str.trim),
          Option.getOrElse(() => "click"),
        ),
        namespace: Array.headNonEmpty(body),
        action: pipe(
          body,
          Array.get(1),
          Option.getOrElse(() => "_"),
        ),
      };
    }),
  );

/**
 * An action of `_` means "no handler", and a namespace of `none` means that
 * the binding is turned off. Both must be excluded, or one half of Google
 * Search becomes hint soup.
 */
const isClickBinding = ({ eventType, namespace, action }: JsActionBinding): boolean =>
  eventType === "click" && namespace !== "none" && action !== "_";

const isClickRule = flow(jsActionBinding, Option.exists(isClickBinding));

const bindsClick = Option.exists<string>(flow(Str.split(";"), Array.some(isClickRule)));

/**
 * The `jsaction` attribute of Google: `"eventType:namespace.action"`, separated
 * by a semicolon, with `click` as the default event type.
 */
const hasJsAction = (element: Element): boolean => bindsClick(attributeOf(element, "jsaction"));

const isDisabled = (element: Element): boolean =>
  "disabled" in element && element.disabled === true;

const isEnabled = Predicate.not(isDisabled);

const hrefOf: (element: Element) => Option.Option<string> = flow(
  Option.liftPredicate(isLink),
  Option.filter((link) => link.hasAttribute("href")),
  Option.map((link) => link.href),
);

/** A pass that hints linked elements admits only what truly has a URL. */
const admitsHref =
  ({ targets }: DetectOptions) =>
  (href: Option.Option<string>): boolean =>
    pipe(
      targets,
      HintTargets.$match({
        Clickable: constTrue,
        Linked: () => Option.isSome(href),
      }),
    );

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Any `<input>` but a hidden or disabled one. Another kind of `<input>` is not checked. */
const isActiveInput = (element: Element): boolean =>
  !isInput(element) || (element.type.toLowerCase() !== "hidden" && !element.disabled);

const isWritableTextArea = (element: Element): boolean =>
  !(element instanceof HTMLTextAreaElement && (element.disabled || element.readOnly));

/**
 * A label earns a hint only when its own control did not. The same checkbox
 * would otherwise get two hints, one on top of the other.
 */
const labelsUnhintedControl = (element: Element, view: Window): boolean =>
  pipe(
    element,
    Option.liftPredicate(isLabel),
    Option.flatMapNullishOr((label) => label.control),
    Option.exists((control) => isEnabled(control) && Option.isNone(classify(control, view))),
  );

const ZOOM_CURSORS: ReadonlyArray<string> = ["zoom-in", "zoom-out"];

/**
 * The inline style only, as upstream does. One `getComputedStyle` call for
 * each image is not worth a rare cursor value.
 */
const isZoomable = (element: Element): boolean =>
  isImage(element) && pipe(ZOOM_CURSORS, Array.contains(element.style.cursor));

const SCROLLING_OVERFLOW: ReadonlyArray<string> = ["scroll", "auto"];

/**
 * A box that scrolls by itself.
 *
 * The cheap geometry test must come before the costly style read. This test
 * runs for every `<div>` on the page.
 */
const scrollsByItself = (element: Element, view: Window): boolean =>
  isHtmlElement(element) &&
  element.clientHeight < element.scrollHeight &&
  pipe(SCROLLING_OVERFLOW, Array.contains(view.getComputedStyle(element).overflowY));

const namesButton = Option.exists<string>((value) => {
  const name = value.toLowerCase();
  return name.includes("button") || name.includes("btn");
});

/** `getAttribute`, and not `className`: on an SVG element `className` is an `SVGAnimatedString`. */
const hasButtonClass = (element: Element): boolean => namesButton(attributeOf(element, "class"));

/** A `tabindex` of zero or more. `Number("")` is `0`, so an empty value counts. */
const isTabIndex = Option.exists<string>((value) => {
  const index = Number(value);
  return Number.isFinite(index) && index >= 0;
});

const hasTabIndex = (element: Element): boolean => isTabIndex(attributeOf(element, "tabindex"));

/**
 * One signal of a click target, and the verdict that it gives when it holds.
 *
 * Each test is a plain predicate, because classification runs it for every
 * element of the page.
 */
interface Signal {
  readonly holds: (element: Element, view: Window) => boolean;
  /** `Option.none()` refuses the hint. */
  readonly verdict: Option.Option<Classification>;
}

const refuses = (holds: (element: Element) => boolean): Signal => ({
  holds,
  verdict: Option.none(),
});

const gives = (
  classification: Classification,
  holds: (element: Element, view: Window) => boolean,
): Signal => ({ holds, verdict: Option.some(classification) });

/** The signals that any element can give, strongest first. */
const ATTRIBUTE_SIGNALS: ReadonlyArray<Signal> = [
  // `aria-disabled` is a hard refusal, before everything else. An element that
  // the page declares inert must never take a hint, however clickable it looks.
  refuses(attributeIn("aria-disabled", DISABLED_VALUES)),
  ...pipe(
    FRAMEWORK_CLICK_ATTRIBUTES,
    Array.map((name) => gives(FRAMEWORK, hasAttribute(name))),
  ),
  gives(FRAMEWORK, hasJsAction),
  gives(ONCLICK, hasAttribute("onclick")),
  gives(ROLE, attributeIn("role", CLICKABLE_ROLES)),
  gives(EDITABLE, attributeIn("contenteditable", EDITABLE_VALUES)),
];

/** The signal of each native element, by `localName`. It comes after the attributes. */
const NATIVE_SIGNALS: Record.ReadonlyRecord<string, Signal> = {
  a: gives(NATIVE, hasAttribute("href")),
  input: gives(NATIVE, isActiveInput),
  button: gives(NATIVE, isEnabled),
  select: gives(NATIVE, isEnabled),
  textarea: gives(NATIVE, isWritableTextArea),
  object: gives(NATIVE, constTrue),
  embed: gives(NATIVE, constTrue),
  label: gives(NATIVE, labelsUnhintedControl),
  details: gives(OPENS, constTrue),
  img: gives(ZOOMS, isZoomable),
  div: gives(SCROLLS, scrollsByItself),
  ol: gives(SCROLLS, scrollsByItself),
  ul: gives(SCROLLS, scrollsByItself),
};

/** The weak signals, last of all. */
const WEAK_SIGNALS: ReadonlyArray<Signal> = [
  gives(CLASS, hasButtonClass),
  gives(SPAN, (element) => element.localName === "span"),
  gives(TABINDEX, hasTabIndex),
];

/** Every signal, strongest first, with the signals of one kind of element in their place. */
const signalsWith = (native: ReadonlyArray<Signal>): ReadonlyArray<Signal> =>
  pipe(ATTRIBUTE_SIGNALS, Array.appendAll(native), Array.appendAll(WEAK_SIGNALS));

/**
 * The signals that an element can give, by `localName`.
 *
 * The lists are built once, so that one element reads only the signals that
 * its kind can give.
 */
const SIGNALS_BY_NAME: Record.ReadonlyRecord<string, ReadonlyArray<Signal>> = pipe(
  NATIVE_SIGNALS,
  Record.map((signal) => signalsWith([signal])),
);

/** The signals of an element that is not one of the native kinds. */
const COMMON_SIGNALS = signalsWith([]);

const orCommonSignals = Option.getOrElse(() => COMMON_SIGNALS);

const toVerdict = Option.flatMap((signal: Signal) => signal.verdict);

/**
 * Decide whether `element` deserves a hint, in the priority order of upstream.
 *
 * The order matters two times over: an earlier signal is stronger (an explicit
 * `onclick` beats a `<span>`), and a later, weaker signal is marked as a
 * possible false positive, so that the descendant filter can drop it.
 */
export const classify = (element: Element, view: Window): Option.Option<Classification> =>
  pipe(
    SIGNALS_BY_NAME,
    Record.get(element.localName),
    orCommonSignals,
    Array.findFirst((signal) => signal.holds(element, view)),
    toVerdict,
  );

// ---------------------------------------------------------------------------
// Visibility and geometry
// ---------------------------------------------------------------------------

const VISIBILITY_CHECK: CheckVisibilityOptions = {
  contentVisibilityAuto: true,
  opacityProperty: true,
  visibilityProperty: true,
};

const isStyledVisible = (style: CSSStyleDeclaration): boolean =>
  style.display !== "none" && style.visibility === "visible" && style.opacity !== "0";

/**
 * `Element.checkVisibility` (Safari 17.4 and later), with a
 * `getComputedStyle` fallback.
 *
 * `contentVisibilityAuto` is the reason to prefer it. Inside a
 * `content-visibility: auto` subtree that the engine skipped, the layout is
 * old, and `getBoundingClientRect()` reports a rect that looks correct for
 * something that is not rendered at all.
 */
const isRendered = (element: Element, options: DetectOptions): boolean =>
  pipe(
    options.capabilities.checkVisibility && typeof element.checkVisibility === "function",
    Boolean.match({
      onFalse: () => isStyledVisible(options.window.getComputedStyle(element)),
      onTrue: () => element.checkVisibility(VISIBILITY_CHECK),
    }),
  );

/** The four edges that the crop needs. A `DOMRect` has them all. */
interface EdgeRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A crop that leaves no box, or that starts within 4 pixels of the far edges. */
const isCroppedAway =
  (viewport: ViewportRect) =>
  ({ left, top, width, height }: HintRect): boolean =>
    top >= viewport.height - 4 || left >= viewport.width - 4 || width <= 0 || height <= 0;

/**
 * Crop to the visible region, as upstream does, but against the viewport rect
 * that the caller gives, and not against `window.innerWidth` and
 * `window.innerHeight`.
 */
const cropRectToVisible = (rect: EdgeRect, viewport: ViewportRect): Option.Option<HintRect> => {
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  // Upstream leaves the far edges uncropped. We clamp them, because our
  // markers live in a layer that is fixed to the viewport, and the occlusion
  // probe samples the corners. An unclamped corner falls outside the viewport,
  // where `elementsFromPoint` gives nothing, and the hint would be refused for
  // being *too large*.
  return pipe(
    {
      left,
      top,
      width: Math.min(rect.right, viewport.width) - left,
      height: Math.min(rect.bottom, viewport.height) - top,
    },
    Option.liftPredicate(Predicate.not(isCroppedAway(viewport))),
  );
};

const MIN_HINT_SIZE = 3;

interface Size {
  readonly width: number;
  readonly height: number;
}

const isUsable = (rect: Size): boolean =>
  rect.width >= MIN_HINT_SIZE && rect.height >= MIN_HINT_SIZE;

/**
 * Can this child draw the box of a parent that measures zero?
 *
 * A floated or positioned child is outside the flow of its parent, and so is a
 * child that hides its overflow along the axis where the parent measures zero.
 */
const carriesCollapsedBox = (box: DOMRectReadOnly, style: CSSStyleDeclaration): boolean =>
  style.float !== "none" ||
  style.position === "absolute" ||
  style.position === "fixed" ||
  (box.width === 0 && style.overflowX === "hidden") ||
  (box.height === 0 && style.overflowY === "hidden");

/** A client rect with a box of its own: rendered, cropped, and large enough. */
const ownRect = (
  element: Element,
  clientRect: DOMRectReadOnly,
  options: DetectOptions,
): Option.Option<HintRect> =>
  pipe(
    clientRect,
    Option.liftPredicate(() => isRendered(element, options)),
    Option.flatMap((rect) => cropRectToVisible(rect, options.viewport)),
    Option.filter(isUsable),
  );

/** The visible rect of a child that carries the box of a parent that measures zero. */
const carriedRect =
  (collapsed: DOMRectReadOnly, options: DetectOptions) =>
  (child: Element): Option.Option<HintRect> =>
    pipe(
      carriesCollapsedBox(collapsed, options.window.getComputedStyle(child)),
      Boolean.match({
        onFalse: () => Option.none(),
        onTrue: () => pipe(visibleClientRect(child, options), Option.filter(isUsable)),
      }),
    );

/** The visible rect that one client rect of `element` gives. */
const clientRectHint =
  (element: Element, options: DetectOptions) =>
  (clientRect: DOMRectReadOnly): Option.Option<HintRect> =>
    pipe(
      clientRect.width === 0 || clientRect.height === 0,
      Boolean.match({
        onFalse: () => ownRect(element, clientRect, options),
        onTrue: () => pipe(element.children, Array.findFirst(carriedRect(clientRect, options))),
      }),
    );

/**
 * The first client rect that is truly visible.
 *
 * The zero-dimension branch comes from upstream, and it carries weight on real
 * sites: a link that wraps only floated or absolutely positioned children
 * measures 0 by 0 itself, and to skip it would lose the hint in silence.
 */
const visibleClientRect = (element: Element, options: DetectOptions): Option.Option<HintRect> =>
  pipe(element.getClientRects(), Array.findFirst(clientRectHint(element, options)));

// ---------------------------------------------------------------------------
// Image maps
// ---------------------------------------------------------------------------

const parseCoords = (area: HTMLAreaElement): ReadonlyArray<number> =>
  pipe(
    area.coords,
    Str.split(","),
    Array.map((coord) => Number.parseInt(coord.trim(), 10)),
  );

/** The corners of an area, relative to its image. */
interface Corners {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** A coordinate that the area gives, or `0` when it gives fewer. */
const coordAt = (coords: ReadonlyArray<number>, index: number): number =>
  pipe(
    coords,
    Array.get(index),
    Option.getOrElse(() => 0),
  );

/**
 * The corners of one area. A circle gives the square inside it, `default`
 * gives the whole image, and every other shape gives its first two points.
 */
const cornersOf = (area: HTMLAreaElement, image: DOMRectReadOnly): Corners => {
  const coords = parseCoords(area);
  return pipe(
    Match.value(area.shape.toLowerCase()),
    Match.whenOr("circle", "circ", (): Corners => {
      const inset = coordAt(coords, 2) / Math.SQRT2;
      const x = coordAt(coords, 0);
      const y = coordAt(coords, 1);
      return { x1: x - inset, y1: y - inset, x2: x + inset, y2: y + inset };
    }),
    Match.when("default", (): Corners => ({ x1: 0, y1: 0, x2: image.width, y2: image.height })),
    Match.orElse((): Corners => ({
      x1: coordAt(coords, 0),
      y1: coordAt(coords, 1),
      x2: coordAt(coords, 2),
      y2: coordAt(coords, 3),
    })),
  );
};

/**
 * Parse a `usemap` value as an HTML hash-name reference.
 *
 * The first `#` is the separator. An absent or final separator names no map.
 * The suffix stays exact. The parser folds no case and normalizes no Unicode.
 */
export const mapNameOf = (usemap: string): Option.Option<string> =>
  pipe(
    usemap,
    Str.indexOf("#"),
    Option.map((separator) => usemap.slice(separator + 1)),
    Option.filter(Str.isNonEmpty),
  );

/** What the lookup reads from the image: the root of the tree that holds it. */
interface InTree {
  getRootNode(): object;
}

/**
 * A root that can be searched.
 *
 * The root of an element is a document, a shadow root, or the top element of a
 * detached tree. Each one is a `ParentNode`, and `querySelectorAll` is the
 * part of it that says so.
 */
const isParentNode = (root: object): root is ParentNode => "querySelectorAll" in root;

/**
 * The `<map>` that `usemap` names, found by iteration.
 *
 * The name comes from the page. It can hold a quotation mark, a backslash, a
 * bracket, a colon, a space, an emoji or a control character. A selector that
 * is built by joining strings then throws a `SyntaxError`, or it matches the
 * wrong element. `map[name="a\\"]` is unterminated, and `map[name="a\b"]`
 * reads `\b` as a hexadecimal escape. One such name used to stop the whole
 * hint pass, and the page lost every hint, not only this one.
 *
 * `CSS.escape` exists in every engine that this application supports, and it
 * would repair the escaping. A selector is still not necessary here.
 * Iteration and two exact comparisons work in an engine without `CSS.escape`.
 * They need no capability probe, and they cannot throw. Page text never becomes
 * a selector.
 *
 * The search uses the document or shadow tree that contains the image. The
 * first map with an equal `id` or `name` wins. A missing map gives
 * `Option.none()`. The image gets no hint, and other elements keep their hints.
 */
export const findImageMap = (context: InTree, usemap: string): Option.Option<Element> =>
  Option.gen(function* () {
    const name = yield* mapNameOf(usemap);
    const root = yield* pipe(context.getRootNode(), Option.liftPredicate(isParentNode));
    // The fixed selector does not contain page text, so malformed names
    // cannot change or break it.
    return yield* pipe(
      root.querySelectorAll("map"),
      Array.findFirst(
        (map) => map.getAttribute("id") === name || map.getAttribute("name") === name,
      ),
    );
  });

/** An `<img usemap>`. It gives hints for its areas, and never for itself. */
interface ImageMap {
  readonly image: HTMLImageElement;
  readonly usemap: string;
}

const imageMapOf: (element: Element) => Option.Option<ImageMap> = flow(
  Option.liftPredicate(isImage),
  Option.flatMap((image) =>
    pipe(
      attributeOf(image, "usemap"),
      Option.map((usemap) => ({ image, usemap })),
    ),
  ),
);

/** The hint of one `<area>`, placed on the rect of its image. */
const areaHint =
  (image: HTMLImageElement, imageRect: DOMRectReadOnly, options: DetectOptions) =>
  (area: HTMLAreaElement): Option.Option<LocalHint> =>
    Option.gen(function* () {
      const { x1, y1, x2, y2 } = yield* pipe(
        cornersOf(area, imageRect),
        Option.liftPredicate(
          (corners) => Number.isFinite(corners.x1) && Number.isFinite(corners.y1),
        ),
      );
      const left = Math.min(x1, x2) + imageRect.left;
      const top = Math.min(y1, y2) + imageRect.top;
      const rect = yield* pipe(
        cropRectToVisible(
          { left, top, right: left + Math.abs(x2 - x1), bottom: top + Math.abs(y2 - y1) },
          options.viewport,
        ),
        Option.filter(isUsable),
      );
      const href = yield* pipe(hrefOf(area), Option.liftPredicate(admitsHref(options)));
      const { text, label } = linkTextFor(area, Option.none());
      const hint: LocalHint = {
        element: area,
        hitTarget: Option.some(image),
        rect,
        kind: "area",
        rank: PRIMARY,
        linkText: text,
        label,
        href,
      };
      return hint;
    });

/**
 * The hints of the `<area>` elements of an image map.
 *
 * Ported from `DomUtils.getClientRectsForAreas`. A circle is approximated by
 * the square inside it, and a polygon by the box around its first two points.
 * Both are compromises of upstream, and both are acceptable: an image map is
 * very rare, and a marker that is a little off still activates the correct
 * area.
 *
 * An empty result means "this is an image map with no usable area", and the
 * element gets no hint of its own.
 */
const areaHints = ({ image, usemap }: ImageMap, options: DetectOptions): ReadonlyArray<LocalHint> =>
  pipe(
    Option.gen(function* () {
      const imageRect = yield* pipe(image.getClientRects().item(0), Option.fromNullishOr);
      const map = yield* findImageMap(image, usemap);
      yield* pipe(
        image,
        Option.liftPredicate((rendered) => isRendered(rendered, options)),
      );
      return pipe(
        map.getElementsByTagName("area"),
        Array.fromIterable,
        Array.map(areaHint(image, imageRect, options)),
        Array.getSomes,
      );
    }),
    Option.getOrElse(() => Array.empty<LocalHint>()),
  );

// ---------------------------------------------------------------------------
// Link text
// ---------------------------------------------------------------------------

/** The text that filter mode matches, and the label that the marker draws, if any. */
interface LinkText {
  readonly text: string;
  readonly label: Option.Option<string>;
}

const quiet = (text: string): LinkText => ({ text, label: Option.none() });

const shown = (text: string): LinkText => ({ text, label: Option.some(text) });

const textOf = (node: Node): string => node.textContent ?? "";

/** `aria-label`, or else `title`, drawn beside the marker when it is not empty. */
const labelText = (element: Element): LinkText =>
  pipe(
    attributeOf(element, "aria-label"),
    Option.orElse(() => attributeOf(element, "title")),
    Option.map(Str.trim),
    Option.getOrElse(() => ""),
    (text) => ({ text, label: pipe(text, Option.liftPredicate(Str.isNonEmpty)) }),
  );

/** `text` when it is not empty, and the label of `element` otherwise. */
const textOrLabel = (element: Element, text: string): LinkText =>
  pipe(
    text,
    Option.liftPredicate(Str.isNonEmpty),
    Option.map(quiet),
    Option.getOrElse(() => labelText(element)),
  );

/** The text of a `<label>`, without the colon that often ends it. */
const labelledText = (label: HTMLLabelElement): string =>
  pipe(textOf(label), Str.trim, Str.replace(/:$/, ""));

const inputText = (input: HTMLInputElement): LinkText =>
  pipe(
    input.labels,
    Option.fromNullishOr,
    Option.flatMapNullishOr((labels) => labels.item(0)),
    Option.match({
      onSome: (label) => textOrLabel(input, labelledText(label)),
      onNone: () =>
        pipe(
          input.type.toLowerCase() === "file",
          Boolean.match({
            onTrue: () => quiet("Choose File"),
            // `element.value` is never read, and that is deliberate.
            //
            // Only `type="password"` used to be excluded, so every other input
            // gave its *contents* as the label of the hint. That label travels
            // word for word across a frame boundary in the wire descriptor. A
            // payment frame (Stripe Elements, Braintree, Adyen) draws a card
            // number in a `type="text"` input with an `aria-label` and no
            // `<label>`, which is exactly this branch. A one-time code and an
            // email address have the same shape.
            //
            // The page writes `placeholder`, and the user does not type it, so
            // it is safe. For filter matching it is usually the better label as
            // well.
            onFalse: () => textOrLabel(input, input.placeholder),
          }),
        ),
    }),
  );

/** The `alt`, or else the `title`, of the image that a link without text wraps. */
const wrappedImageText = (anchor: HTMLAnchorElement): Option.Option<LinkText> =>
  pipe(
    anchor.firstElementChild,
    Option.fromNullishOr,
    Option.filter(isImage),
    // The cheap test first. `textContent` reads the whole subtree.
    Option.filter(() => Str.isEmpty(textOf(anchor).trim())),
    Option.map((image) => image.alt || image.title),
    Option.filter(Str.isNonEmpty),
    Option.map(shown),
  );

/** The first 256 characters of the text of an element, trimmed. */
const ownText = (element: Element): string => textOf(element).slice(0, 256).trim();

/** The text of an element that is not an `<input>`. */
const textOfOther = (element: Element, reason: Option.Option<string>): LinkText =>
  pipe(
    element,
    Option.liftPredicate(isAnchor),
    Option.flatMap(wrappedImageText),
    Option.orElse(() => pipe(reason, Option.map(shown))),
    Option.getOrElse(() => textOrLabel(element, ownText(element))),
  );

/**
 * The text that filter mode matches against.
 *
 * Ported from `LinkHints.getLinkText`, with one addition: where the derived
 * text is empty, `aria-label` and `title` are used instead. A button with an
 * icon and no text is now usual, and without the fallback it cannot be reached
 * in filter mode.
 */
export const linkTextFor = (element: Element, reason: Option.Option<string>): LinkText =>
  pipe(
    element,
    Option.liftPredicate(isInput),
    Option.match({ onSome: inputText, onNone: () => textOfOther(element, reason) }),
  );

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * What the walk reads from a parent: a document, a shadow root, or an element.
 *
 * The walk is generic in the element that it walks. A DOM `Element` is one,
 * and so is the fake node of a unit test, which gives only what the walk reads.
 */
export interface WalkParent<E> {
  readonly firstElementChild: E | null;
  readonly lastElementChild: E | null;
}

/** What the walk reads from an element. */
export interface WalkElement<E> extends WalkParent<E> {
  readonly localName: string;
  readonly nextElementSibling: E | null;
  readonly shadowRoot: WalkParent<E> | null;
  readonly childNodes: { readonly length: number };
  getBoundingClientRect(): Size;
}

/**
 * Does this look like the host of a shadow root that we cannot see?
 *
 * There is no API for "has a closed shadow root", so this is a heuristic: a
 * custom element that was upgraded, that has no light-DOM child at all, and
 * that still occupies a box, must draw its content from somewhere that we
 * cannot reach. A false positive costs one HUD line. A false negative costs the
 * user a silent gap in the hints, which is worse.
 */
const looksLikeClosedShadowHost = <E>(element: WalkElement<E>): boolean =>
  element.shadowRoot === null &&
  element.localName.includes("-") &&
  element.childNodes.length === 0 &&
  isUsable(element.getBoundingClientRect());

/** What one walk of the tree found. */
export interface Collected<E> {
  readonly elements: ReadonlyArray<E>;
  readonly unreachableHosts: number;
  /** True when the work limit stopped this walk. */
  readonly truncated: boolean;
}

/**
 * Discovery, and how it gives the main thread back.
 *
 * Discovery walks the whole document. The walk used to run to the end in one
 * synchronous call, before the first slice of any other work. On a large page
 * the user waited for that walk, and Escape arrived only after it.
 *
 * **How the work is divided.** The walk is a state machine, and not a
 * recursion. Each stack frame holds one next sibling and one final sibling.
 * `stepWalk` examines at most `count` elements. It never enumerates one whole
 * sibling list. `repeatInSlices` reads the clock after each step. It starts a
 * new slice when the budget of 8 ms is gone.
 *
 * **Where the thread goes back.** `Dom.yieldToBrowser` runs between two
 * slices. It posts through a `MessageChannel`, so the browser runs its own
 * work, and every timer of the page keeps its turn.
 *
 * **What cancels a walk.** The walk is one effect in the fiber of the round.
 * Interruption of that fiber stops the walk at the next yield. `Hints.ts`
 * interrupts it when the user presses Escape, when a new round starts, when
 * the mode exits, and when the runtime scope closes on a page change.
 *
 * **What a cancelled walk leaves.** Nothing. The walk holds no listener, no
 * timer and no child fiber. It writes into one array that it owns, and the
 * garbage collector takes that array with the fiber. It draws no marker,
 * because a marker is drawn only from the result that it never returns.
 *
 * **The result on a static tree.** A divided walk finds the same elements, in
 * the same order, as the old walk. The unit test compares several step sizes.
 *
 * **The result on a changing tree.** Each parent captures its final child when
 * the parent is visited. Children appended after that point are excluded.
 * Children inserted before that boundary can appear. A removed next child stays
 * pending. A later removed sibling can disappear. Moved elements appear once.
 *
 * **The completion limit.** The walk examines at most 250,000 elements. This
 * includes elements that a mutation makes it examine again. The result reports
 * truncation, and detection writes a warning. Thus, page growth cannot keep a
 * walk alive without end.
 *
 * **The measurement.** WebKit, one machine, ten warm rounds. On a page of 2,415
 * elements, both walks took 0–1 ms. On a page of 120,037 elements, the old walk
 * took 7 ms.
 * The divided walk took 11–27 ms. Its longest slice stays near 8 ms.
 *
 * One 64-element step took less than 1 ms with one million siblings. Each step
 * now reads at most 64 siblings, so document width cannot enlarge one step.
 */
interface WalkFrame<E> {
  /** The next child to examine. A frame leaves the stack when none is left. */
  next: E;
  readonly boundary: E;
}

export interface ElementWalk<E> {
  /** The child lists that still have elements. The last frame runs next. */
  readonly pending: Array<WalkFrame<E>>;
  /** The elements produced so far, in document order. */
  readonly elements: Array<E>;
  /** Elements already produced. A moved element cannot be produced again. */
  readonly produced: Set<E>;
  /** Work includes duplicate elements that mutations put in the walk again. */
  examined: number;
  unreachableHosts: number;
  /** True when the work limit stopped this walk. */
  truncated: boolean;
  readonly limit: number;
}

/** The maximum examined elements of one hint discovery walk. */
export const WALK_ELEMENT_LIMIT = 250_000;

/** Capture the current first and final child of one parent. `startWalk` uses it for the root. */
const childFrame = <E>(parent: WalkParent<E>): Option.Option<WalkFrame<E>> =>
  pipe(
    parent.firstElementChild,
    Option.fromNullishOr,
    Option.flatMap((next) =>
      pipe(
        parent.lastElementChild,
        Option.fromNullishOr,
        Option.map((boundary): WalkFrame<E> => ({ next, boundary })),
      ),
    ),
  );

/** A walk of `root` that has visited nothing yet. */
export const startWalk = <E extends WalkElement<E>>(
  root: WalkParent<E>,
  limit = WALK_ELEMENT_LIMIT,
): ElementWalk<E> => ({
  pending: pipe(childFrame(root), Option.toArray),
  elements: [],
  produced: new Set(),
  examined: 0,
  unreachableHosts: 0,
  truncated: false,
  limit,
});

/**
 * Examine at most `count` elements. It gives `true` while work is left.
 *
 * The order is document order, and it enters every open shadow root. A slotted
 * light-DOM child is under its host, so the walk does not visit it two times.
 *
 * This is the one loop of the module, and it stays a loop on purpose: it runs
 * once for each element of the page. A throwaway benchmark (Node 26, a fake
 * tree of 120,037 elements, steps of 64, the median of ten warm runs) measured
 * this loop at about 14 ms, as fast as the loop before it. A walk without the
 * loop, over immutable state (a persistent stack, a `HashSet` and a `Chunk`),
 * took about 205 ms. The same loop with an `Option` for each child frame took
 * about 18 ms, so the loop captures a child frame with two `null` checks, and
 * `childFrame` serves only the root.
 */
export const stepWalk = <E extends WalkElement<E>>(
  walk: ElementWalk<E>,
  count: number,
): boolean => {
  const pushChildren = (parent: WalkParent<E>): void => {
    const next = parent.firstElementChild;
    const boundary = parent.lastElementChild;
    if (next !== null && boundary !== null) walk.pending.push({ next, boundary });
  };

  for (let step = 0; step < count; step += 1) {
    const frame = walk.pending.pop();
    if (frame === undefined) return false;
    if (walk.examined >= walk.limit) {
      walk.truncated = true;
      walk.pending.length = 0;
      return false;
    }

    const element = frame.next;
    if (element !== frame.boundary) {
      const sibling = element.nextElementSibling;
      if (sibling !== null) {
        frame.next = sibling;
        walk.pending.push(frame);
      }
    }
    walk.examined += 1;
    if (walk.produced.has(element)) continue;

    walk.produced.add(element);
    walk.elements.push(element);
    // Push light children first. Shadow children then run before light children.
    pushChildren(element);
    const shadow = element.shadowRoot;
    if (shadow !== null) pushChildren(shadow);
    else if (looksLikeClosedShadowHost(element)) walk.unreachableHosts += 1;
  }
  return walk.pending.length > 0;
};

/**
 * How many elements one step visits before the clock is read again.
 *
 * `performance.now()` is itself measurable when a walk of ten thousand
 * elements reads it for each one.
 */
const WALK_CHECK_EVERY = 64;

/** Walk `root` in time-boxed slices. Interruption stops it at a slice edge. */
export const collectElements = Effect.fnUntraced(function* <E extends WalkElement<E>>(
  root: WalkParent<E>,
  options: ChunkedOptions,
): Effect.fn.Return<Collected<E>, never, Dom> {
  const walk = startWalk(root);
  const checkEvery = options.checkEvery ?? WALK_CHECK_EVERY;
  yield* repeatInSlices(
    Effect.sync(() => stepWalk(walk, checkEvery)),
    options.budgetMs ?? CHUNK_BUDGET_MS,
  );
  yield* pipe(
    walk.truncated,
    Boolean.match({
      onFalse: () => Effect.void,
      onTrue: () =>
        Effect.logWarning(`hint discovery stopped after ${walk.limit} examined elements`),
    }),
  );
  const collected: Collected<E> = {
    elements: walk.elements,
    unreachableHosts: walk.unreachableHosts,
    truncated: walk.truncated,
  };
  return collected;
});

// ---------------------------------------------------------------------------
// Occlusion
// ---------------------------------------------------------------------------

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Is `element` what the user would hit at this point?
 *
 * `document.elementsFromPoint`, and not `elementFromPoint`: the singular form
 * gives the retargeted shadow *host*, so a hint inside any web component would
 * look occluded for ever. A walk of the front-to-back list lets us accept the
 * host, an ancestor, or a descendant.
 *
 * The two directions are *not* symmetric, and to treat them as one is what made
 * this wrong in both directions:
 *
 * - A hit on something inside our own subtree, including inside our own open
 *   shadow root, is us. Accept it.
 * - A hit on an *ancestor* is us only when nothing else is painted in between.
 *   To accept any ancestor gave a hint, and a true synthetic click, to a
 *   `pointer-events: none` overlay, to content that a `clip-path` hides, and to
 *   a `height: 0; overflow: hidden` box, because the hit test gave their
 *   containing block.
 */
const hitsAtPoint =
  (element: Element, hosts: ReadonlyArray<Element>, options: DetectOptions) =>
  ({ x, y }: Point): boolean =>
    pipe(
      options.document.elementsFromPoint(x, y),
      Array.findFirst(
        (candidate) =>
          !pipe(
            options.overlayHost,
            Option.exists((host) => host === candidate),
          ),
      ),
      // Anything else, an ancestor too, decides against us. The point is
      // inside our box, and the thing that is painted on top of it is above
      // us in the tree, which means that we do not paint at this point at all.
      Option.exists(
        (candidate) =>
          candidate === element ||
          containsDeep(element, candidate) ||
          pipe(
            hosts,
            Array.some((host) => host === candidate),
          ),
      ),
    );

/** A hair inside the edge: on the boundary itself the hit test is ambiguous. */
const EDGE_NUDGE = 0.1;

/**
 * The points that the occlusion test samples, in order.
 *
 * The centre first: it is the point that succeeds most often, and every hit
 * test forces a layout flush.
 */
const probePoints = ({ left, top, width, height }: HintRect): ReadonlyArray<Point> => {
  const near = { x: left + EDGE_NUDGE, y: top + EDGE_NUDGE };
  const far = { x: left + width - EDGE_NUDGE, y: top + height - EDGE_NUDGE };
  return [
    { x: left + width / 2, y: top + height / 2 },
    near,
    { x: far.x, y: near.y },
    { x: near.x, y: far.y },
    far,
  ];
};

const isHintVisible =
  (options: DetectOptions) =>
  (hint: LocalHint): boolean => {
    const target = pipe(
      hint.hitTarget,
      Option.getOrElse(() => hint.element),
    );
    return pipe(
      probePoints(hint.rect),
      Array.some(hitsAtPoint(target, shadowHostChain(target), options)),
    );
  };

// ---------------------------------------------------------------------------
// False positives
// ---------------------------------------------------------------------------

/** How far back to look for a clickable descendant. The number of upstream. */
const FALSE_POSITIVE_WINDOW = 6;
/** How many `parentElement` steps count as "near". The number of upstream. */
const FALSE_POSITIVE_DEPTH = 3;

/** Is `ancestor` at most `depth` parent steps above `element`? */
const isNearAncestor = (ancestor: Element, element: Element, depth: number): boolean =>
  depth > 0 &&
  pipe(
    element.parentElement,
    Option.fromNullishOr,
    Option.exists((parent) => parent === ancestor || isNearAncestor(ancestor, parent, depth - 1)),
  );

/** Does a hint in the window before `position` sit near below `hint`? */
const wrapsNearbyHint = (
  hints: ReadonlyArray<LocalHint>,
  hint: LocalHint,
  position: number,
): boolean =>
  pipe(
    hints.slice(Math.max(0, position - FALSE_POSITIVE_WINDOW), position),
    Array.some((near) => isNearAncestor(hint.element, near.element, FALSE_POSITIVE_DEPTH)),
  );

/**
 * Drop a weakly hinted element that only wraps something that is hinted.
 *
 * `hints` must be in *reverse* document order, so that a descendant is always
 * at a lower index than its ancestor. False positives sit close together in the
 * DOM, which is why a window of six elements is enough, and why a full walk of
 * the ancestors is not necessary.
 */
export const dropFalsePositives = (hints: ReadonlyArray<LocalHint>): ReadonlyArray<LocalHint> =>
  pipe(
    hints,
    Array.filter((hint, position) =>
      pipe(
        hint.rank,
        HintRank.$match({
          Primary: constTrue,
          Secondary: () => !wrapsNearbyHint(hints, hint, position),
        }),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/** The hint of an element that `classify` accepted. */
const elementHint =
  (element: Element, options: DetectOptions) =>
  (classification: Classification): Option.Option<LocalHint> =>
    Option.gen(function* () {
      const href = yield* pipe(hrefOf(element), Option.liftPredicate(admitsHref(options)));
      const rect = yield* visibleClientRect(element, options);
      const { kind, reason, rank } = traitsOf(classification);
      const { text, label } = linkTextFor(element, reason);
      const hint: LocalHint = {
        element,
        hitTarget: Option.none(),
        rect,
        kind,
        rank,
        linkText: text,
        label,
        href,
      };
      return hint;
    });

/** The hints that one element gives. */
const buildHints =
  (options: DetectOptions) =>
  (element: Element): Option.Option<ReadonlyArray<LocalHint>> =>
    pipe(
      imageMapOf(element),
      Option.match({
        // Image maps first, exactly as upstream does: an `<img usemap>` gives
        // hints for its areas, and never for itself.
        onSome: (map) =>
          pipe(areaHints(map, options), Option.liftPredicate(Array.isReadonlyArrayNonEmpty)),
        onNone: () =>
          pipe(
            classify(element, options.window),
            Option.flatMap(elementHint(element, options)),
            Option.map(Array.of),
          ),
      }),
    );

/**
 * A stable partition: the second-class citizens go last, so that they never
 * take a short hint string away from a true link.
 */
const secondaryLast = (hints: ReadonlyArray<LocalHint>): ReadonlyArray<LocalHint> => {
  const secondary = pipe(hints, Array.filter(isSecondary));
  return pipe(hints, Array.filter(Predicate.not(isSecondary)), Array.appendAll(secondary));
};

const SLICES: ChunkedOptions = { budgetMs: CHUNK_BUDGET_MS };

/**
 * Run the whole detection pipeline.
 *
 * Three chunked passes, and not one: discovery walks the tree, classification
 * touches every element that it found, and the occlusion test is one forced
 * hit test for each surviving hint. To interleave them would put a hit test in
 * the middle of a loop that reads styles, which is the worst pattern for
 * layout thrash.
 */
export const detectHints = Effect.fnUntraced(function* (
  options: DetectOptions,
): Effect.fn.Return<DetectionResult, never, Dom> {
  const collected = yield* collectElements(options.document, SLICES);
  const groups = yield* pipe(collected.elements, mapChunked(buildHints(options), SLICES));
  // Descendants before ancestors, so that a later element paints above an
  // earlier one, and the false-positive window looks the correct way.
  const candidates = pipe(groups, Array.flatten, Array.reverse, dropFalsePositives);
  const visible = yield* pipe(
    candidates,
    mapChunked(Option.liftPredicate(isHintVisible(options)), SLICES),
  );
  return {
    hints: pipe(visible, Array.reverse, secondaryLast),
    unreachableHosts: collected.unreachableHosts,
    truncated: collected.truncated,
  };
});
