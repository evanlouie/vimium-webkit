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

import { Effect, Option } from "effect";
import type { CapabilityReport } from "~/platform/Capabilities.ts";
import { Dom } from "~/platform/Dom.ts";
import {
  CHUNK_BUDGET_MS,
  type ChunkedOptions,
  mapChunked,
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
  /**
   * The "second-class citizen" of upstream: hinted on a weak signal (a class
   * name, a bare `<span>`, a `tabindex`). It sorts after everything else, so
   * that the good hints get the short strings.
   */
  readonly secondary: boolean;
  /** A suspected false positive. It is filtered against nearby descendants. */
  readonly possibleFalsePositive: boolean;
  readonly linkText: string;
  /** The `showLinkText` of upstream: draw the text beside the marker. */
  readonly showLinkText: boolean;
  /** The absolute URL, when the element navigates. */
  readonly href: Option.Option<string>;
}

export interface DetectOptions {
  readonly window: Window & typeof globalThis;
  readonly document: Document;
  readonly capabilities: CapabilityReport;
  /** From `Ui.viewport`, which comes from `visualViewport` on iOS. */
  readonly viewport: ViewportRect;
  /** Copy-URL and new-tab modes hint only what truly has a URL. */
  readonly requireHref: boolean;
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
const FRAMEWORK_CLICK_ATTRIBUTES: readonly string[] = [
  "ng-click",
  "data-ng-click",
  "x-ng-click",
];

const CLICKABLE_ROLES: ReadonlySet<string> = new Set([
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
]);

const EDITABLE_VALUES: ReadonlySet<string> = new Set([
  "",
  "contenteditable",
  "true",
  "plaintext-only",
]);

export interface Classification {
  readonly kind: HintKind;
  readonly secondary: boolean;
  readonly possibleFalsePositive: boolean;
  /** The `reason` of upstream. It is shown in place of the absent link text. */
  readonly reason: Option.Option<string>;
}

const clickable = (
  kind: HintKind,
  reason: Option.Option<string> = Option.none(),
): Option.Option<Classification> =>
  Option.some({
    kind,
    secondary: false,
    possibleFalsePositive: false,
    reason,
  });

const weaklyClickable = (kind: HintKind): Option.Option<Classification> =>
  Option.some({
    kind,
    secondary: true,
    possibleFalsePositive: true,
    reason: Option.none(),
  });

// ---------------------------------------------------------------------------
// Attribute probes
// ---------------------------------------------------------------------------

/**
 * The `jsaction` attribute of Google: `"eventType:namespace.action"`, separated
 * by a semicolon, with `click` as the default event type.
 *
 * An action of `_` means "no handler", and a namespace of `none` means that the
 * binding is turned off. Both must be excluded, or one half of Google Search
 * becomes hint soup.
 */
const hasJsAction = (element: Element): boolean => {
  const attribute = element.getAttribute("jsaction");
  if (attribute === null) return false;

  for (const rule of attribute.split(";")) {
    const parts = rule.trim().split(":");
    if (parts.length === 0 || parts.length > 2) continue;
    const eventType = parts.length === 1 ? "click" : parts[0]?.trim() ?? "";
    const body = (parts.length === 1 ? parts[0] : parts[1])?.trim() ?? "";
    const [namespace, action = "_"] = body.split(".");
    if (eventType === "click" && namespace !== "none" && action !== "_") {
      return true;
    }
  }
  return false;
};

const isDisabled = (element: Element): boolean =>
  (element as Element & { disabled?: unknown }).disabled === true;

const hrefOf = (element: Element): Option.Option<string> => {
  if (element instanceof HTMLAnchorElement) {
    return element.getAttribute("href") === null
      ? Option.none()
      : Option.some(element.href);
  }
  if (element instanceof HTMLAreaElement) {
    return element.getAttribute("href") === null
      ? Option.none()
      : Option.some(element.href);
  }
  return Option.none();
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const classifyNative = (
  element: Element,
  view: Window,
): Option.Option<Classification> => {
  switch (element.localName) {
    case "a":
      return element.hasAttribute("href") ? clickable("native") : Option.none();

    case "input": {
      if (!(element instanceof HTMLInputElement)) return clickable("native");
      const type = element.type.toLowerCase();
      return type === "hidden" || element.disabled
        ? Option.none()
        : clickable("native");
    }

    case "button":
    case "select":
      return isDisabled(element) ? Option.none() : clickable("native");

    case "textarea":
      return element instanceof HTMLTextAreaElement &&
          (element.disabled || element.readOnly)
        ? Option.none()
        : clickable("native");

    case "object":
    case "embed":
      return clickable("native");

    case "label": {
      if (!(element instanceof HTMLLabelElement)) return Option.none();
      const control = element.control;
      if (control === null || isDisabled(control)) return Option.none();
      // A label earns a hint only when its own control did not. The same
      // checkbox would otherwise get two hints, one on top of the other.
      return Option.isNone(classify(control, view))
        ? clickable("native")
        : Option.none();
    }

    case "details":
      return clickable("native", Option.some("Open."));

    case "img":
      // The inline style only, as upstream does. One `getComputedStyle` call
      // for each image is not worth a rare cursor value.
      return element instanceof HTMLImageElement &&
          (element.style.cursor === "zoom-in" ||
            element.style.cursor === "zoom-out")
        ? clickable("native", Option.some("Zoom."))
        : Option.none();

    case "div":
    case "ol":
    case "ul": {
      // The cheap geometry test must come before the costly style read. This
      // branch runs for every `<div>` on the page.
      if (!(element instanceof HTMLElement)) return Option.none();
      if (element.clientHeight >= element.scrollHeight) return Option.none();
      const overflow = view.getComputedStyle(element).overflowY;
      return overflow === "scroll" || overflow === "auto"
        ? clickable("native", Option.some("Scroll."))
        : Option.none();
    }

    default:
      return Option.none();
  }
};

/**
 * Decide whether `element` deserves a hint, in the priority order of upstream.
 *
 * The order matters two times over: an earlier signal is stronger (an explicit
 * `onclick` beats a `<span>`), and a later, weaker signal is marked as a
 * possible false positive, so that the descendant filter can drop it.
 */
export const classify = (
  element: Element,
  view: Window,
): Option.Option<Classification> => {
  // `aria-disabled` is a hard refusal, before everything else. An element that
  // the page declares inert must never take a hint, however clickable it looks.
  const ariaDisabled = element.getAttribute("aria-disabled")?.toLowerCase();
  if (ariaDisabled === "" || ariaDisabled === "true") return Option.none();

  for (const attribute of FRAMEWORK_CLICK_ATTRIBUTES) {
    if (element.hasAttribute(attribute)) return clickable("framework");
  }
  if (hasJsAction(element)) return clickable("framework");

  if (element.hasAttribute("onclick")) return clickable("onclick");

  const role = element.getAttribute("role")?.toLowerCase();
  if (role !== undefined && CLICKABLE_ROLES.has(role)) return clickable("role");

  const editable = element.getAttribute("contenteditable")?.toLowerCase();
  if (editable !== undefined && EDITABLE_VALUES.has(editable)) {
    return clickable("contenteditable");
  }

  const native = classifyNative(element, view);
  if (Option.isSome(native)) return native;

  // `getAttribute`, and not `className`: on an SVG element `className` is an
  // `SVGAnimatedString`, and not a string.
  const classAttribute = element.getAttribute("class")?.toLowerCase() ?? "";
  if (classAttribute.includes("button") || classAttribute.includes("btn")) {
    return weaklyClickable("class");
  }

  if (element.localName === "span") return weaklyClickable("span");

  const tabIndexAttribute = element.getAttribute("tabindex");
  if (tabIndexAttribute !== null) {
    const tabIndex = tabIndexAttribute === "" ? 0 : Number(tabIndexAttribute);
    if (Number.isFinite(tabIndex) && tabIndex >= 0) {
      return weaklyClickable("tabindex");
    }
  }

  return Option.none();
};

// ---------------------------------------------------------------------------
// Visibility and geometry
// ---------------------------------------------------------------------------

interface VisibilityCheckOptions {
  readonly contentVisibilityAuto?: boolean;
  readonly opacityProperty?: boolean;
  readonly visibilityProperty?: boolean;
}

interface VisibilityCheckable {
  readonly checkVisibility?: (options?: VisibilityCheckOptions) => boolean;
}

/**
 * `Element.checkVisibility` (Safari 17.4 and later), with a
 * `getComputedStyle` fallback.
 *
 * `contentVisibilityAuto` is the reason to prefer it. Inside a
 * `content-visibility: auto` subtree that the engine skipped, the layout is
 * old, and `getBoundingClientRect()` reports a rect that looks correct for
 * something that is not rendered at all.
 */
const isRendered = (
  element: Element,
  capabilities: CapabilityReport,
  view: Window,
): boolean => {
  if (capabilities.checkVisibility) {
    const check = (element as unknown as VisibilityCheckable).checkVisibility;
    if (typeof check === "function") {
      return check.call(element, {
        contentVisibilityAuto: true,
        opacityProperty: true,
        visibilityProperty: true,
      });
    }
  }
  const style = view.getComputedStyle(element);
  return style.display !== "none" && style.visibility === "visible" &&
    style.opacity !== "0";
};

/** The four edges that the crop needs. A `DOMRect` has them all. */
interface EdgeRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Crop to the visible region, as upstream does, but against the viewport rect
 * that the caller gives, and not against `window.innerWidth` and
 * `window.innerHeight`.
 */
const cropRectToVisible = (
  rect: EdgeRect,
  viewport: ViewportRect,
): Option.Option<HintRect> => {
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  if (top >= viewport.height - 4 || left >= viewport.width - 4) {
    return Option.none();
  }
  // Upstream leaves the far edges uncropped. We clamp them, because our
  // markers live in a layer that is fixed to the viewport, and the occlusion
  // probe samples the corners. An unclamped corner falls outside the viewport,
  // where `elementsFromPoint` gives nothing, and the hint would be refused for
  // being *too large*.
  const right = Math.min(rect.right, viewport.width);
  const bottom = Math.min(rect.bottom, viewport.height);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return Option.none();
  return Option.some({ left, top, width, height });
};

const MIN_HINT_SIZE = 3;

const isUsable = (rect: HintRect): boolean =>
  rect.width >= MIN_HINT_SIZE && rect.height >= MIN_HINT_SIZE;

/**
 * The first client rect that is truly visible.
 *
 * The zero-dimension branch comes from upstream, and it carries weight on real
 * sites: a link that wraps only floated or absolutely positioned children
 * measures 0 by 0 itself, and to skip it would lose the hint in silence.
 */
const visibleClientRect = (
  element: Element,
  capabilities: CapabilityReport,
  view: Window,
  viewport: ViewportRect,
): Option.Option<HintRect> => {
  const clientRects = element.getClientRects();

  for (const clientRect of clientRects) {
    if (clientRect.width === 0 || clientRect.height === 0) {
      for (const child of element.children) {
        const childStyle = view.getComputedStyle(child);
        const position = childStyle.position;
        if (
          childStyle.float === "none" &&
          position !== "absolute" && position !== "fixed" &&
          !(clientRect.width === 0 && childStyle.overflowX === "hidden") &&
          !(clientRect.height === 0 && childStyle.overflowY === "hidden")
        ) continue;

        const childRect = visibleClientRect(
          child,
          capabilities,
          view,
          viewport,
        );
        if (Option.isNone(childRect) || !isUsable(childRect.value)) continue;
        return childRect;
      }
      continue;
    }

    if (!isRendered(element, capabilities, view)) continue;

    const cropped = cropRectToVisible(clientRect, viewport);
    if (Option.isNone(cropped) || !isUsable(cropped.value)) continue;
    return cropped;
  }

  return Option.none();
};

// ---------------------------------------------------------------------------
// Image maps
// ---------------------------------------------------------------------------

const parseCoords = (area: HTMLAreaElement): readonly number[] =>
  area.coords.split(",").map((coord) => Number.parseInt(coord.trim(), 10));

/**
 * The map name that a `usemap` attribute holds, without the leading `#`.
 *
 * An empty name names no map. The HTML standard says the same, so an
 * `<img usemap="#">` gets no hint, and the pass goes on.
 */
export const mapNameOf = (usemap: string): Option.Option<string> => {
  const name = usemap.startsWith("#") ? usemap.slice(1) : usemap;
  return name.length === 0 ? Option.none() : Option.some(name);
};

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
 * Iteration and one string comparison work in an engine that has no
 * `CSS.escape`, they need no capability probe, and they cannot throw. No name
 * from the page ever becomes a selector.
 *
 * The first map in tree order wins, as `querySelector` did. The comparison is
 * exact, as an attribute selector is. A name that matches no map gives
 * `Option.none()`, the image gets no hint, and every other element on the page
 * keeps its own.
 */
export const findImageMap = (
  document: Document,
  usemap: string,
): Option.Option<Element> => {
  const name = mapNameOf(usemap);
  if (Option.isNone(name)) return Option.none();
  for (const map of document.getElementsByTagName("map")) {
    if (map.getAttribute("name") === name.value) return Option.some(map);
  }
  return Option.none();
};

/**
 * The rects of the `<area>` elements of an image map.
 *
 * Ported from `DomUtils.getClientRectsForAreas`. A circle is approximated by
 * the square inside it, and a polygon by the box around its first two points.
 * Both are compromises of upstream, and both are acceptable: an image map is
 * very rare, and a marker that is a little off still activates the correct
 * area.
 *
 * `Option.none()` means "this is not an image map". An empty array means "this
 * is an image map with no usable area", and the element gets no hint of its
 * own.
 */
const imageMapHints = (
  element: Element,
  options: DetectOptions,
): Option.Option<readonly LocalHint[]> => {
  if (!(element instanceof HTMLImageElement)) return Option.none();
  const rawName = element.getAttribute("usemap");
  if (rawName === null) return Option.none();

  const imageRect = element.getClientRects()[0];
  if (imageRect === undefined) return Option.some([]);

  const map = findImageMap(options.document, rawName);
  if (Option.isNone(map)) return Option.some([]);
  if (!isRendered(element, options.capabilities, options.window)) {
    return Option.some([]);
  }

  const hints: LocalHint[] = [];
  for (const area of map.value.getElementsByTagName("area")) {
    const coords = parseCoords(area);
    const shape = area.shape.toLowerCase();

    let x1 = coords[0] ?? 0;
    let y1 = coords[1] ?? 0;
    let x2 = coords[2] ?? 0;
    let y2 = coords[3] ?? 0;

    if (shape === "circle" || shape === "circ") {
      const [cx = 0, cy = 0, radius = 0] = coords;
      const inset = radius / Math.SQRT2;
      x1 = cx - inset;
      y1 = cy - inset;
      x2 = cx + inset;
      y2 = cy + inset;
    } else if (shape === "default") {
      x1 = 0;
      y1 = 0;
      x2 = imageRect.width;
      y2 = imageRect.height;
    }

    if (!Number.isFinite(x1) || !Number.isFinite(y1)) continue;

    const left = Math.min(x1, x2) + imageRect.left;
    const top = Math.min(y1, y2) + imageRect.top;
    const rect = cropRectToVisible({
      left,
      top,
      right: left + Math.abs(x2 - x1),
      bottom: top + Math.abs(y2 - y1),
    }, options.viewport);
    if (Option.isNone(rect) || !isUsable(rect.value)) continue;

    const href = hrefOf(area);
    if (options.requireHref && Option.isNone(href)) continue;

    const { text, show } = linkTextFor(area, Option.none());
    hints.push({
      element: area,
      hitTarget: Option.some(element),
      rect: rect.value,
      kind: "area",
      secondary: false,
      possibleFalsePositive: false,
      linkText: text,
      showLinkText: show,
      href,
    });
  }
  return Option.some(hints);
};

// ---------------------------------------------------------------------------
// Link text
// ---------------------------------------------------------------------------

/**
 * The text that filter mode matches against.
 *
 * Ported from `LinkHints.getLinkText`, with one addition: where the derived
 * text is empty, `aria-label` and `title` are used instead. A button with an
 * icon and no text is now usual, and without the fallback it cannot be reached
 * in filter mode.
 */
export const linkTextFor = (
  element: Element,
  reason: Option.Option<string>,
): { readonly text: string; readonly show: boolean } => {
  const fallback = (): { text: string; show: boolean } => {
    const label = element.getAttribute("aria-label") ??
      element.getAttribute("title") ?? "";
    return { text: label.trim(), show: label.trim().length > 0 };
  };

  if (element instanceof HTMLInputElement) {
    const labels = element.labels;
    const firstLabel = labels === null ? undefined : labels[0];
    if (firstLabel !== undefined) {
      let text = (firstLabel.textContent ?? "").trim();
      if (text.endsWith(":")) text = text.slice(0, -1);
      if (text.length > 0) return { text, show: false };
      return fallback();
    }
    const type = element.type.toLowerCase();
    if (type === "file") return { text: "Choose File", show: false };
    // `element.value` is never read, and that is deliberate.
    //
    // Only `type="password"` used to be excluded, so every other input gave its
    // *contents* as the label of the hint. That label travels word for word
    // across a frame boundary in the wire descriptor. A payment frame (Stripe
    // Elements, Braintree, Adyen) draws a card number in a `type="text"` input
    // with an `aria-label` and no `<label>`, which is exactly this branch. A
    // one-time code and an email address have the same shape.
    //
    // The page writes `placeholder`, and the user does not type it, so it is
    // safe. For filter matching it is usually the better label as well.
    const text = element.placeholder;
    return text.length > 0 ? { text, show: false } : fallback();
  }

  if (element instanceof HTMLAnchorElement) {
    if ((element.textContent ?? "").trim().length === 0) {
      const child = element.firstElementChild;
      if (child instanceof HTMLImageElement) {
        const text = child.alt || child.title;
        if (text.length > 0) return { text, show: true };
      }
    }
  }

  if (Option.isSome(reason)) return { text: reason.value, show: true };

  const text = (element.textContent ?? "").slice(0, 256).trim();
  return text.length > 0 ? { text, show: false } : fallback();
};

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Does this look like the host of a shadow root that we cannot see?
 *
 * There is no API for "has a closed shadow root", so this is a heuristic: a
 * custom element that was upgraded, that has no light-DOM child at all, and
 * that still occupies a box, must draw its content from somewhere that we
 * cannot reach. A false positive costs one HUD line. A false negative costs the
 * user a silent gap in the hints, which is worse.
 */
const looksLikeClosedShadowHost = (element: Element): boolean => {
  if (element.shadowRoot !== null) return false;
  if (!element.localName.includes("-")) return false;
  if (element.childNodes.length > 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width >= MIN_HINT_SIZE && rect.height >= MIN_HINT_SIZE;
};

/** What one walk of the tree found. */
export interface Collected {
  readonly elements: Element[];
  unreachableHosts: number;
}

/**
 * Discovery, and how it gives the main thread back.
 *
 * Discovery walks the whole document. The walk used to run to the end in one
 * synchronous call, before the first slice of any other work. On a large page
 * the user waited for that walk, and Escape arrived only after it.
 *
 * **How the work is divided.** The walk is a state machine, and not a
 * recursion. `ElementWalk` holds a stack of the elements that are not yet
 * visited. `stepWalk` visits at most `count` of them and gives back. The
 * caller reads the clock after each step, and it starts a new slice when the
 * budget of 8 ms is gone.
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
 * **The result does not change.** A divided walk finds the same elements, in
 * the same order, as the walk that it replaces. `test/unit/hint-detect_test.ts`
 * compares the two on a large tree, and it compares slice sizes of 1, 7 and
 * 5000 against each other.
 *
 * **The measurement.** Playwright WebKit, one machine, five rounds. On
 * `test/fixtures/link-dense.html` (2414 elements) the walk took 0–1 ms before
 * the change, and it takes 0–1 ms after it, in one slice. On
 * `test/fixtures/dom-huge.html` (120 036 elements) the walk took 6–19 ms
 * before, in one block that nothing could interrupt. It now takes 6–24 ms in
 * one to four slices, and the longest single piece of work is 8 ms. The gain
 * is not the total. The gain is that the longest piece no longer grows with
 * the document.
 */
export interface ElementWalk {
  /** The elements that are not visited yet. The last entry is visited next. */
  readonly pending: Element[];
  readonly collected: Collected;
}

/** Stack the element children of `parent`, so that the first one pops first. */
const pushChildren = (pending: Element[], parent: ParentNode): void => {
  // The sibling pointers, and not `parent.children`. A collection costs one
  // allocation for each element that the walk visits, and that is measurable:
  // on a document of 120 000 elements the collection walk takes 15 ms, and
  // this one takes 6 ms, which is the time of the walk that it replaces.
  let child = parent.lastElementChild;
  while (child !== null) {
    pending.push(child);
    child = child.previousElementSibling;
  }
};

/** A walk of `root` that has visited nothing yet. */
export const startWalk = (root: ParentNode): ElementWalk => {
  const walk: ElementWalk = {
    pending: [],
    collected: { elements: [], unreachableHosts: 0 },
  };
  pushChildren(walk.pending, root);
  return walk;
};

/**
 * Visit at most `count` elements. It gives `true` while work is left.
 *
 * The order is document order, and it goes down into every *open* shadow root.
 * A slotted light-DOM child is already under its host, so it is not visited two
 * times.
 */
export const stepWalk = (walk: ElementWalk, count: number): boolean => {
  for (let visited = 0; visited < count; visited += 1) {
    const element = walk.pending.pop();
    if (element === undefined) break;
    walk.collected.elements.push(element);
    const shadow = element.shadowRoot;
    // The light children go on the stack first, so the shadow children pop
    // before them. The order is the host, then its whole shadow tree, then its
    // light tree. That is the order of the recursive walk that this replaces.
    pushChildren(walk.pending, element);
    if (shadow !== null) pushChildren(walk.pending, shadow);
    else if (looksLikeClosedShadowHost(element)) {
      walk.collected.unreachableHosts += 1;
    }
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
export const collectElements = (
  root: ParentNode,
  options: ChunkedOptions,
): Effect.Effect<Collected, never, Dom> =>
  Effect.gen(function*() {
    const dom = yield* Dom;
    const budget = options.budgetMs ?? CHUNK_BUDGET_MS;
    const checkEvery = options.checkEvery ?? WALK_CHECK_EVERY;
    const walk = startWalk(root);

    let more = true;
    while (more) {
      const sliceStart = yield* dom.now;
      for (;;) {
        more = stepWalk(walk, checkEvery);
        if (!more) break;
        if ((yield* dom.now) - sliceStart >= budget) break;
      }
      // Sequential by design. The browser gets a turn between two slices, and
      // an interruption of this fiber takes effect here.
      if (more) yield* dom.yieldToBrowser;
    }

    return walk.collected;
  });

// ---------------------------------------------------------------------------
// Occlusion
// ---------------------------------------------------------------------------

/** The chain of shadow hosts between `element` and the document. */
const shadowHostChain = (element: Element): readonly Element[] => {
  const chain: Element[] = [];
  let node: Node = element;
  for (;;) {
    const root = node.getRootNode();
    if (!(root instanceof ShadowRoot)) break;
    chain.push(root.host);
    node = root.host;
  }
  return chain;
};

/**
 * Does `ancestor` contain `node`, across an open shadow boundary?
 *
 * `Node.contains` stops at a shadow root. A hit on a *descendant inside the own
 * open shadow root of the element* therefore looked like an unrelated element
 * that was painted on top, and every clickable custom element lost its hint.
 */
const containsDeep = (ancestor: Element, node: Element): boolean => {
  let current: Node | null = node;
  for (;;) {
    if (current === null) return false;
    if (ancestor.contains(current)) return true;
    const root = current.getRootNode();
    if (!(root instanceof ShadowRoot)) return false;
    current = root.host;
  }
};

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
const hitsAtPoint = (
  element: Element,
  hosts: readonly Element[],
  x: number,
  y: number,
  options: DetectOptions,
): boolean => {
  for (const candidate of options.document.elementsFromPoint(x, y)) {
    if (
      Option.isSome(options.overlayHost) &&
      candidate === options.overlayHost.value
    ) continue;
    if (candidate === element) return true;
    if (containsDeep(element, candidate)) return true;
    if (hosts.includes(candidate)) return true;
    // An ancestor. The point is inside our box, and the thing that is painted
    // on top of it is above us in the tree, which means that we do not paint at
    // this point at all.
    return false;
  }
  return false;
};

/** A hair inside the edge: on the boundary itself the hit test is ambiguous. */
const EDGE_NUDGE = 0.1;

const isHintVisible = (hint: LocalHint, options: DetectOptions): boolean => {
  const { left, top, width, height } = hint.rect;
  const near = { x: left + EDGE_NUDGE, y: top + EDGE_NUDGE };
  const far = { x: left + width - EDGE_NUDGE, y: top + height - EDGE_NUDGE };
  const target = Option.getOrElse(hint.hitTarget, () => hint.element);
  const hosts = shadowHostChain(target);
  const hits = (x: number, y: number): boolean =>
    hitsAtPoint(target, hosts, x, y, options);

  // The centre first: it is the point that succeeds most often, and every hit
  // test forces a layout flush.
  return hits(left + width / 2, top + height / 2) ||
    hits(near.x, near.y) || hits(far.x, near.y) ||
    hits(near.x, far.y) || hits(far.x, far.y);
};

// ---------------------------------------------------------------------------
// False positives
// ---------------------------------------------------------------------------

/** How far back to look for a clickable descendant. The number of upstream. */
const FALSE_POSITIVE_WINDOW = 6;
/** How many `parentElement` steps count as "near". The number of upstream. */
const FALSE_POSITIVE_DEPTH = 3;

/**
 * Drop a weakly hinted element that only wraps something that is hinted.
 *
 * `hints` must be in *reverse* document order, so that a descendant is always
 * at a lower index than its ancestor. False positives sit close together in the
 * DOM, which is why a window of six elements is enough, and why a full walk of
 * the ancestors is not necessary.
 */
export const dropFalsePositives = (
  hints: readonly LocalHint[],
): readonly LocalHint[] =>
  hints.filter((hint, position) => {
    if (!hint.possibleFalsePositive) return true;

    for (
      let index = Math.max(0, position - FALSE_POSITIVE_WINDOW);
      index < position;
      index++
    ) {
      let candidate: Element | null = hints[index]?.element ?? null;
      for (let depth = 0; depth < FALSE_POSITIVE_DEPTH; depth++) {
        candidate = candidate?.parentElement ?? null;
        if (candidate === null) break;
        if (candidate === hint.element) return false;
      }
    }
    return true;
  });

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

const buildHints = (
  element: Element,
  options: DetectOptions,
): Option.Option<readonly LocalHint[]> => {
  // Image maps first, exactly as upstream does: an `<img usemap>` gives hints
  // for its areas, and never for itself.
  const areas = imageMapHints(element, options);
  if (Option.isSome(areas)) {
    return areas.value.length > 0 ? areas : Option.none();
  }

  const classification = classify(element, options.window);
  if (Option.isNone(classification)) return Option.none();

  const href = hrefOf(element);
  if (options.requireHref && Option.isNone(href)) return Option.none();

  const rect = visibleClientRect(
    element,
    options.capabilities,
    options.window,
    options.viewport,
  );
  if (Option.isNone(rect)) return Option.none();

  const { text, show } = linkTextFor(element, classification.value.reason);
  return Option.some([{
    element,
    hitTarget: Option.none(),
    rect: rect.value,
    kind: classification.value.kind,
    secondary: classification.value.secondary,
    possibleFalsePositive: classification.value.possibleFalsePositive,
    linkText: text,
    showLinkText: show,
    href,
  }]);
};

/**
 * Run the whole detection pipeline.
 *
 * Three chunked passes, and not one: discovery walks the tree, classification
 * touches every element that it found, and the occlusion test is one forced
 * hit test for each surviving hint. To interleave them would put a hit test in
 * the middle of a loop that reads styles, which is the worst pattern for
 * layout thrash.
 */
export const detectHints = (
  options: DetectOptions,
): Effect.Effect<DetectionResult, never, Dom> =>
  Effect.gen(function*() {
    const chunk = { budgetMs: CHUNK_BUDGET_MS };

    const collected = yield* collectElements(options.document, chunk);

    const groups = yield* mapChunked(
      collected.elements,
      (element) => buildHints(element, options),
      chunk,
    );

    // Descendants before ancestors, so that a later element paints above an
    // earlier one, and the false-positive window looks the correct way.
    const reversed = groups.flat().reverse();
    const filtered = dropFalsePositives(reversed);

    const visible = yield* mapChunked(
      filtered,
      (hint) =>
        isHintVisible(hint, options) ? Option.some(hint) : Option.none(),
      chunk,
    );

    const inOrder = [...visible].reverse();

    // A stable partition: the second-class citizens go last, so that they never
    // take a short hint string away from a true link.
    const hints = [
      ...inOrder.filter((hint) => !hint.secondary),
      ...inOrder.filter((hint) => hint.secondary),
    ];

    return { hints, unreachableHosts: collected.unreachableHosts };
  });
