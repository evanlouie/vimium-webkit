/**
 * Element detection.
 *
 * Ported from Vimium's `content_scripts/link_hints.js` (`LocalHints.getLocalHints`,
 * `getVisibleClickable`) and `lib/dom_utils.js` (`getVisibleClientRect`,
 * `cropRectToVisible`, `getClientRectsForAreas`), MIT.
 *
 * The pipeline shape is upstream's and is engine-neutral. What is *not*
 * upstream's, and what this file exists to get right:
 *
 * - the whole pass is chunked through `mapChunked`, because Safari has no
 *   `requestIdleCallback` and a synchronous walk over a five-thousand-node
 *   document drops frames;
 * - visibility goes through `Element.checkVisibility` where it exists, because
 *   `content-visibility: auto` (Safari 18) makes `getBoundingClientRect()`
 *   report stale geometry inside skipped subtrees;
 * - geometry is cropped against the *visual* viewport, not `window.innerHeight`,
 *   which diverges on iOS under the dynamic toolbar;
 * - occlusion uses `document.elementsFromPoint`, because the singular form
 *   returns the retargeted shadow host by spec and would reject every hint
 *   inside a web component.
 */

import type { ViewportRect } from "~/core/context.ts";
import type { Capabilities } from "~/platform/capabilities.ts";
import { CHUNK_BUDGET_MS, mapChunked } from "~/platform/scheduler.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HintRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Why an element was hinted. Drives activation and the filter-mode label. */
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
  /** For an image map this is the `<area>`, not the `<img>`. */
  readonly element: Element;
  /**
   * The element the occlusion hit test should accept, when it differs from
   * `element`.
   *
   * Only image maps need this. An `<area>` lives inside a detached `<map>`, so
   * `elementsFromPoint` returns the `<img>` — which neither contains the area
   * nor is contained by it, and every hint would be discarded as occluded. We
   * still want the test to *run*, because an area underneath a fixed overlay
   * genuinely is unreachable; we just want it evaluated against the image.
   */
  readonly hitTarget?: Element;
  /** Layout-viewport coordinates, cropped to the visible region. */
  readonly rect: HintRect;
  readonly kind: HintKind;
  /**
   * Upstream's "second-class citizen": hinted on a weak signal (a class name,
   * a bare `<span>`, a `tabindex`). Sorted after everything else so the good
   * hints get the short strings.
   */
  readonly secondary: boolean;
  /** Suspected false positive; filtered against nearby descendants. */
  readonly possibleFalsePositive: boolean;
  readonly linkText: string;
  /** Upstream's `showLinkText`: render the text beside the hint marker. */
  readonly showLinkText: boolean;
  /** Absolute URL when the element navigates, else `null`. */
  readonly href: string | null;
}

export interface DetectOptions {
  readonly caps: Capabilities;
  /** From `app.ui.viewport()` — `visualViewport`-derived on iOS. */
  readonly viewport: ViewportRect;
  /** Copy-URL and new-tab modes only hint things that actually have a URL. */
  readonly requireHref?: boolean;
  readonly signal?: AbortSignal;
  readonly root?: Document | ShadowRoot;
  /**
   * Our own overlay host, skipped during hit testing.
   *
   * It is `pointer-events: none` so it should never be hit anyway; this is
   * belt-and-braces, because a single stray hit would reject every hint on the
   * page and the failure would look like "hints just stopped working".
   */
  readonly overlayHost?: Element | null;
}

export interface DetectionResult {
  readonly hints: readonly LocalHint[];
  /**
   * Count of elements that look like closed-shadow-root hosts.
   *
   * Their contents are unreachable — `element.shadowRoot` is `null` by design
   * and `attachShadow` patching needs a reliable `document-start` that WebKit
   * does not give a userscript. The only honest response is to tell the user.
   */
  readonly unreachableHosts: number;
}

// ---------------------------------------------------------------------------
// Classification tables
// ---------------------------------------------------------------------------

/** Angular's several spellings, all of which imply a click listener. */
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

interface Classification {
  readonly kind: HintKind;
  readonly secondary: boolean;
  readonly possibleFalsePositive: boolean;
  /** Upstream's `reason`: shown instead of the (absent) link text. */
  readonly reason: string | null;
}

const clickable = (
  kind: HintKind,
  reason: string | null = null,
): Classification => ({
  kind,
  secondary: false,
  possibleFalsePositive: false,
  reason,
});

const weaklyClickable = (kind: HintKind): Classification => ({
  kind,
  secondary: true,
  possibleFalsePositive: true,
  reason: null,
});

// ---------------------------------------------------------------------------
// Attribute probes
// ---------------------------------------------------------------------------

/**
 * Google's `jsaction` attribute: `"eventType:namespace.action"`, semicolon
 * separated, with the event type defaulting to `click`.
 *
 * An action of `_` means "no handler" and a namespace of `none` means the
 * binding is explicitly disabled, so both have to be excluded or half of
 * Google Search becomes hint soup.
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

const hrefOf = (element: Element): string | null => {
  if (element instanceof HTMLAnchorElement) {
    return element.getAttribute("href") === null ? null : element.href;
  }
  if (element instanceof HTMLAreaElement) {
    return element.getAttribute("href") === null ? null : element.href;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const classifyNative = (element: Element): Classification | null => {
  switch (element.localName) {
    case "a":
      return element.hasAttribute("href") ? clickable("native") : null;

    case "input": {
      if (!(element instanceof HTMLInputElement)) return clickable("native");
      const type = element.type.toLowerCase();
      return type === "hidden" || element.disabled ? null : clickable("native");
    }

    case "button":
    case "select":
      return isDisabled(element) ? null : clickable("native");

    case "textarea":
      return element instanceof HTMLTextAreaElement &&
          (element.disabled || element.readOnly)
        ? null
        : clickable("native");

    case "object":
    case "embed":
      return clickable("native");

    case "label": {
      if (!(element instanceof HTMLLabelElement)) return null;
      const control = element.control;
      if (control === null || isDisabled(control)) return null;
      // A label only earns a hint when its own control did not: otherwise the
      // same checkbox gets two, stacked on top of each other.
      return classify(control) === null ? clickable("native") : null;
    }

    case "details":
      return clickable("native", "Open.");

    case "img":
      // Inline style only, as upstream: a `getComputedStyle` call per image is
      // not worth it for a rare cursor value.
      return element instanceof HTMLImageElement &&
          (element.style.cursor === "zoom-in" ||
            element.style.cursor === "zoom-out")
        ? clickable("native", "Zoom.")
        : null;

    case "div":
    case "ol":
    case "ul": {
      // The cheap geometry test must short-circuit the expensive style read:
      // this branch runs for every `<div>` on the page.
      if (!(element instanceof HTMLElement)) return null;
      if (element.clientHeight >= element.scrollHeight) return null;
      const overflow = getComputedStyle(element).overflowY;
      return overflow === "scroll" || overflow === "auto"
        ? clickable("native", "Scroll.")
        : null;
    }

    default:
      return null;
  }
};

/**
 * Decide whether `element` deserves a hint, in upstream's priority order.
 *
 * Order matters twice over: earlier signals are stronger (an explicit `onclick`
 * beats a `<span>`), and the later, weaker signals are flagged as possible
 * false positives so the descendant filter can drop them.
 */
export const classify = (element: Element): Classification | null => {
  // `aria-disabled` is a hard reject, ahead of everything: an element the page
  // has declared inert must never take a hint, however clickable it looks.
  const ariaDisabled = element.getAttribute("aria-disabled")?.toLowerCase();
  if (ariaDisabled === "" || ariaDisabled === "true") return null;

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

  const native = classifyNative(element);
  if (native !== null) return native;

  // `getAttribute`, not `className`: on SVG elements `className` is an
  // `SVGAnimatedString`, not a string.
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

  return null;
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
 * `Element.checkVisibility` (Safari 17.4+) with a `getComputedStyle` fallback.
 *
 * `contentVisibilityAuto` is the reason to prefer it: inside a
 * `content-visibility: auto` subtree that the engine has skipped, layout is
 * stale and `getBoundingClientRect()` cheerfully reports a plausible-looking
 * rect for something that is not rendered at all.
 */
const isRendered = (element: Element, caps: Capabilities): boolean => {
  if (caps.checkVisibility) {
    const check = (element as unknown as VisibilityCheckable).checkVisibility;
    if (typeof check === "function") {
      return check.call(element, {
        contentVisibilityAuto: true,
        opacityProperty: true,
        visibilityProperty: true,
      });
    }
  }
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility === "visible" &&
    style.opacity !== "0";
};

/**
 * Crop to the visible region, as upstream, but against the viewport rect handed
 * to us rather than `window.innerWidth/Height`.
 */
const cropRectToVisible = (
  rect: DOMRect,
  viewport: ViewportRect,
): HintRect | null => {
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  if (top >= viewport.height - 4 || left >= viewport.width - 4) return null;
  // Upstream leaves the far edges uncropped. We clamp them because our markers
  // live in a viewport-fixed layer and the occlusion probe samples the corners:
  // an unclamped corner falls outside the viewport, where `elementsFromPoint`
  // returns nothing and the hint would be rejected for being *too big*.
  const right = Math.min(rect.right, viewport.width);
  const bottom = Math.min(rect.bottom, viewport.height);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
};

const MIN_HINT_SIZE = 3;

/**
 * The first client rect that is actually visible, or `null`.
 *
 * The zero-dimension branch is upstream's and is load-bearing on real sites: a
 * link that wraps only floated or absolutely positioned children measures
 * 0×0 itself, and skipping it would silently lose the hint.
 */
const visibleClientRect = (
  element: Element,
  caps: Capabilities,
  viewport: ViewportRect,
): HintRect | null => {
  const clientRects = element.getClientRects();

  for (const clientRect of clientRects) {
    if (clientRect.width === 0 || clientRect.height === 0) {
      for (const child of element.children) {
        const childStyle = getComputedStyle(child);
        const position = childStyle.position;
        if (
          childStyle.float === "none" &&
          position !== "absolute" && position !== "fixed" &&
          !(clientRect.width === 0 && childStyle.overflowX === "hidden") &&
          !(clientRect.height === 0 && childStyle.overflowY === "hidden")
        ) continue;

        const childRect = visibleClientRect(child, caps, viewport);
        if (
          childRect === null || childRect.width < MIN_HINT_SIZE ||
          childRect.height < MIN_HINT_SIZE
        ) continue;
        return childRect;
      }
      continue;
    }

    if (!isRendered(element, caps)) continue;

    const cropped = cropRectToVisible(clientRect, viewport);
    if (
      cropped === null || cropped.width < MIN_HINT_SIZE ||
      cropped.height < MIN_HINT_SIZE
    ) continue;
    return cropped;
  }

  return null;
};

// ---------------------------------------------------------------------------
// Image maps
// ---------------------------------------------------------------------------

const parseCoords = (area: HTMLAreaElement): readonly number[] =>
  area.coords.split(",").map((coord) => Number.parseInt(coord.trim(), 10));

/**
 * Rects for an image map's `<area>` elements.
 *
 * Ported from `DomUtils.getClientRectsForAreas`. A circle is approximated by
 * its inscribed square and a polygon by the box around its first two points —
 * both upstream compromises, both fine, because image maps are vanishingly
 * rare and a slightly-off hint marker still activates the right area.
 */
const imageMapHints = (
  element: Element,
  caps: Capabilities,
  viewport: ViewportRect,
  requireHref: boolean,
): LocalHint[] | null => {
  if (!(element instanceof HTMLImageElement)) return null;
  const rawName = element.getAttribute("usemap");
  if (rawName === null) return null;

  const imageRect = element.getClientRects()[0];
  if (imageRect === undefined) return [];

  const name = rawName.replace(/^#/, "").replaceAll('"', '\\"');
  const map = document.querySelector(`map[name="${name}"]`);
  if (map === null) return [];
  if (!isRendered(element, caps)) return [];

  const hints: LocalHint[] = [];
  for (const area of map.getElementsByTagName("area")) {
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

    const translated = new DOMRect(
      Math.min(x1, x2) + imageRect.left,
      Math.min(y1, y2) + imageRect.top,
      Math.abs(x2 - x1),
      Math.abs(y2 - y1),
    );
    const rect = cropRectToVisible(translated, viewport);
    if (
      rect === null || rect.width < MIN_HINT_SIZE ||
      rect.height < MIN_HINT_SIZE
    ) continue;

    const href = hrefOf(area);
    if (requireHref && href === null) continue;

    const { text, show } = linkTextFor(area, null);
    hints.push({
      element: area,
      hitTarget: element,
      rect,
      kind: "area",
      secondary: false,
      possibleFalsePositive: false,
      linkText: text,
      showLinkText: show,
      href,
    });
  }
  return hints;
};

// ---------------------------------------------------------------------------
// Link text
// ---------------------------------------------------------------------------

/**
 * The text filter mode matches against.
 *
 * Ported from `LinkHints.getLinkText`, with one addition: when the derived text
 * is empty we fall back to `aria-label`/`title`. Icon-only buttons are now the
 * norm, and without the fallback they are unreachable in filter mode.
 */
export const linkTextFor = (
  element: Element,
  reason: string | null,
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
    // `element.value` is deliberately never read.
    //
    // Only `type="password"` used to be excluded, so every other input
    // contributed its *contents* as the hint's label — and that label is
    // carried verbatim across frame boundaries in the wire descriptor. Payment
    // iframes (Stripe Elements, Braintree, Adyen) render card numbers in
    // `type="text"` with an `aria-label` and no `<label>`, which is exactly
    // this branch. TOTP codes and email addresses are the same shape.
    //
    // `placeholder` is authored by the page rather than typed by the user, so
    // it is safe and, for filter matching, usually the better label anyway.
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

  if (reason !== null) return { text: reason, show: true };

  const text = (element.textContent ?? "").slice(0, 256).trim();
  return text.length > 0 ? { text, show: false } : fallback();
};

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Does this look like a host whose shadow root we cannot see?
 *
 * There is no API for "has a closed shadow root", so this is a heuristic: an
 * upgraded custom element with no light-DOM children at all, yet which occupies
 * a box, must be rendering content from somewhere we cannot reach. False
 * positives only cost a HUD line; false negatives cost the user a silent
 * unexplained gap in the hints, which is worse.
 */
const looksLikeClosedShadowHost = (element: Element): boolean => {
  if (element.shadowRoot !== null) return false;
  if (!element.localName.includes("-")) return false;
  if (element.childNodes.length > 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width >= MIN_HINT_SIZE && rect.height >= MIN_HINT_SIZE;
};

interface Collected {
  readonly elements: Element[];
  unreachableHosts: number;
}

/**
 * Every element in document order, descending into *open* shadow roots.
 *
 * Slotted light-DOM children already appear under their host, so they are not
 * visited twice.
 */
const collectElements = (root: ParentNode, into: Collected): void => {
  for (const element of root.querySelectorAll("*")) {
    into.elements.push(element);
    const shadow = element.shadowRoot;
    if (shadow !== null) collectElements(shadow, into);
    else if (looksLikeClosedShadowHost(element)) into.unreachableHosts += 1;
  }
};

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
 * Does `ancestor` contain `node`, crossing open shadow boundaries?
 *
 * `Node.contains` stops at a shadow root, so a hit on a *descendant inside the
 * element's own open shadow root* looked like an unrelated element painted on
 * top — and every clickable custom element lost its hint entirely.
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
 * Is `element` the thing the user would hit at this point?
 *
 * `document.elementsFromPoint` rather than `elementFromPoint`: the singular
 * form returns the retargeted shadow *host*, so a hint inside any web component
 * would look permanently occluded. Walking the returned front-to-back list lets
 * us accept the host, an ancestor, or a descendant.
 *
 * The two directions are *not* symmetric, and treating them as such is what
 * made this wrong both ways:
 *
 * - A hit on something inside our own subtree — including inside our own open
 *   shadow root — is us. Accept it.
 * - A hit on an *ancestor* is only us if nothing else is painted in between.
 *   Accepting any ancestor meant `pointer-events: none` overlays,
 *   `clip-path`-hidden content and `height: 0; overflow: hidden` boxes earned
 *   hints — and real synthetic clicks — because their containing block was
 *   returned by the hit test.
 */
const hitsAtPoint = (
  element: Element,
  hosts: readonly Element[],
  x: number,
  y: number,
  overlayHost: Element | null,
): boolean => {
  for (const candidate of document.elementsFromPoint(x, y)) {
    if (candidate === overlayHost) continue;
    if (candidate === element) return true;
    if (containsDeep(element, candidate)) return true;
    if (hosts.includes(candidate)) return true;
    // An ancestor: the point is inside our box but the topmost thing painted
    // there is something above us in the tree, which means we are not painting
    // at this point at all.
    return false;
  }
  return false;
};

/** A hair inside the edge: exactly on the boundary the hit test is ambiguous. */
const EDGE_NUDGE = 0.1;

const isHintVisible = (
  hint: LocalHint,
  overlayHost: Element | null,
): boolean => {
  const { left, top, width, height } = hint.rect;
  const near = { x: left + EDGE_NUDGE, y: top + EDGE_NUDGE };
  const far = { x: left + width - EDGE_NUDGE, y: top + height - EDGE_NUDGE };
  const target = hint.hitTarget ?? hint.element;
  const hosts = shadowHostChain(target);
  const hits = (x: number, y: number): boolean =>
    hitsAtPoint(target, hosts, x, y, overlayHost);

  // Centre first: it is the point that succeeds most often, and every hit test
  // is a forced layout flush.
  return hits(left + width / 2, top + height / 2) ||
    hits(near.x, near.y) || hits(far.x, near.y) ||
    hits(near.x, far.y) || hits(far.x, far.y);
};

// ---------------------------------------------------------------------------
// False positives
// ---------------------------------------------------------------------------

/** How far back to look for a clickable descendant. Upstream's number. */
const FALSE_POSITIVE_WINDOW = 6;
/** How many `parentElement` hops count as "close". Upstream's number. */
const FALSE_POSITIVE_DEPTH = 3;

/**
 * Drop weakly-hinted elements that merely wrap something already hinted.
 *
 * Expects `hints` in *reverse* document order, so a descendant is always at a
 * lower index than its ancestor. False positives cluster tightly in the DOM,
 * which is why a six-element window is enough and a full ancestor scan is not
 * needed.
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
): LocalHint[] | undefined => {
  const requireHref = options.requireHref === true;

  // Image maps first, exactly as upstream: an `<img usemap>` yields hints for
  // its areas and never for itself.
  const areas = imageMapHints(
    element,
    options.caps,
    options.viewport,
    requireHref,
  );
  if (areas !== null) return areas.length > 0 ? areas : undefined;

  const classification = classify(element);
  if (classification === null) return undefined;

  const href = hrefOf(element);
  if (requireHref && href === null) return undefined;

  const rect = visibleClientRect(
    element,
    options.caps,
    options.viewport,
  );
  if (rect === null) return undefined;

  const { text, show } = linkTextFor(element, classification.reason);
  return [{
    element,
    rect,
    kind: classification.kind,
    secondary: classification.secondary,
    possibleFalsePositive: classification.possibleFalsePositive,
    linkText: text,
    showLinkText: show,
    href,
  }];
};

/**
 * Run the whole detection pipeline.
 *
 * Two chunked passes rather than one: classification touches every element in
 * the document, while the occlusion test is a forced hit test per surviving
 * hint. Interleaving them would mean a hit test in the middle of a style-read
 * loop, which is the worst possible layout-thrash pattern.
 */
export const detectHints = async (
  options: DetectOptions,
): Promise<DetectionResult> => {
  const collected: Collected = { elements: [], unreachableHosts: 0 };
  collectElements(options.root ?? document, collected);

  const chunk = {
    budgetMs: CHUNK_BUDGET_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  const groups = await mapChunked(
    collected.elements,
    (element) => buildHints(element, options),
    chunk,
  );

  // Descendants before ancestors, so a later element paints above an earlier
  // one and the false-positive window looks the right way.
  const reversed = groups.flat().reverse();
  const filtered = dropFalsePositives(reversed);

  const overlayHost = options.overlayHost ?? null;
  const visible = await mapChunked(
    filtered,
    (hint) => (isHintVisible(hint, overlayHost) ? hint : undefined),
    chunk,
  );

  visible.reverse();

  // Stable partition: second-class citizens last, so they never take the short
  // hint strings away from a real link.
  const hints = [
    ...visible.filter((hint) => !hint.secondary),
    ...visible.filter((hint) => hint.secondary),
  ];

  return { hints, unreachableHosts: collected.unreachableHosts };
};
