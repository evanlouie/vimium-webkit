/**
 * The markers, and the stylesheet that draws them.
 *
 * A marker lives in the `"hints"` layer of the one closed shadow root. That
 * layer is `position: fixed` and carries `z-index: 2147483647`, which already
 * escapes every stacking context of the page. There is therefore no use of
 * `popover` here: its support differs across the WebKit versions that we
 * target, and it would give us nothing that we do not already have.
 *
 * The layer is fixed to the viewport, and the markers of upstream are absolute
 * in the document. Two corrections follow, which Vimium does not need:
 *
 * 1. **Scroll.** The rects were measured against the layout viewport at
 *    detection time. When the page scrolls under us, the whole layer is
 *    translated by the difference, instead of measuring thousands of elements
 *    again.
 * 2. **The visual viewport.** On iOS the overlay host is translated by the
 *    offset of the visual viewport, to imitate `position: device-fixed`. A
 *    marker coordinate is relative to the layout viewport, so it must be
 *    translated back by the same amount.
 *
 * The translation of the whole layer is correct for a scroll of the page, and
 * for nothing else. A container that scrolls inside the page, a resize and a
 * reflow all move one target and not the layer. The hints service measures the
 * targets again for those, and it calls `reanchor` before it draws the new
 * rects. The layer then holds the offset of the visual viewport only, because
 * the new rects already carry the scroll of the page.
 *
 * The container, every listener and the reposition fiber belong to the scope
 * that builds the layer. To close that scope removes the markers. There is no
 * `dispose` method.
 */

import { Effect, FiberHandle, Option, Ref, type Scope } from "effect";
import { Dom } from "~/platform/Dom.ts";
import { Ui } from "~/ui/Ui.ts";
import type { HintRect } from "./Detect.ts";

// ---------------------------------------------------------------------------
// The stylesheet
// ---------------------------------------------------------------------------

/**
 * The marker CSS.
 *
 * It is a string, and it is installed with `Ui.setStyle`, which puts it in the
 * `adoptedStyleSheets` of the shadow root. **Never build a `<style>` element
 * for this.** Safari applies the `style-src` of the *page* to a DOM node that a
 * content script inserts, so a `<style>` tag is refused outright on any site
 * with a strict policy, and a constructed stylesheet is not a fetch and is not
 * policed. That one fact is why the overlay works on GitHub, on GMail and on
 * every bank.
 *
 * The visual language is the language of upstream Vimium, and that is
 * deliberate. A user recognises the yellow box, and a marker is a thing that
 * the user reads in 80 ms under time pressure.
 *
 * `all: initial` is applied by the shadow host, so nothing here has to defend
 * itself against an inherited page style. Only the properties that we want are
 * set.
 */
export const HINT_CSS = `
.vw-hints {
  position: absolute;
  inset: 0;
  pointer-events: none;
  /* Marker churn during filter mode must not invalidate the page layout. */
  contain: layout style;
}

.vw-hint {
  position: absolute;
  top: 0;
  left: 0;
  display: block;
  box-sizing: border-box;
  padding: 1px 3px;
  background: linear-gradient(to bottom, #fff785 0%, #ffc542 100%);
  border: 1px solid #c38a22;
  border-radius: 3px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.35);
  color: #302505;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  text-align: left;
  white-space: nowrap;
  pointer-events: none;
  /* Promoted once, in advance: filter mode draws again on every keystroke, and
     we only ever change the transform. */
  will-change: transform;
}

/*
 * A weak-signal hint (a class name, a bare span, a tabindex). It is visible,
 * and it is quieter, so that the eye lands on a true link first.
 */
.vw-hint--secondary {
  background: linear-gradient(to bottom, #f6f0c8 0%, #e8d79a 100%);
  border-color: #b9a86a;
}

/* The characters that the user already typed. They are dimmed, and never
   removed: the width must not change while the user types, or the markers
   dance. */
.vw-hint__matched {
  color: #c38a22;
  opacity: 0.55;
}

/* Filter mode: the link text beside the number. It is lower case and lighter,
   so that it never competes with the digits. */
.vw-hint__text {
  margin-left: 4px;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  opacity: 0.75;
}

/* Filter mode: the candidate that Tab or Enter would activate. */
.vw-hint--active {
  border-color: #1a73e8;
  box-shadow: 0 0 0 2px rgba(26, 115, 232, 0.55), 0 2px 4px rgba(0, 0, 0, 0.35);
}

/* Filtered out. \`display: none\` and not an opacity, so that a hidden marker
   costs nothing to lay out. On a link-dense page most markers are hidden most
   of the time. */
.vw-hint--hidden {
  display: none;
}

@media (prefers-reduced-motion: no-preference) {
  .vw-hint {
    transition: opacity 60ms linear;
  }
}
`;

/**
 * The longest user stylesheet that we will install.
 *
 * Marker styling needs a few declarations. A limit as generous as this never
 * inconveniences a true user, and it stops a pathological value from going
 * through `replaceSync` on every session.
 */
const MAX_USER_CSS_LENGTH = 8 * 1024;

/**
 * The constructs that would let user CSS reach outside the overlay.
 *
 * `@import` and `url(` both make a network request, which turns a stylesheet
 * into a channel for exfiltration: an attribute selector plus a background
 * image reports which hints exist to a third-party host. Neither one is needed
 * to style a marker, so to refuse them costs nothing true.
 */
const FORBIDDEN_CSS = /@import\b|url\s*\(|@charset\b/iu;

/**
 * Is this user CSS that we are willing to install?
 *
 * It is exported so that the settings dialog can refuse the value at the moment
 * when the user can correct it, and not drop it later in silence.
 */
export const isSafeUserCss = (css: string): boolean =>
  css.length <= MAX_USER_CSS_LENGTH && !FORBIDDEN_CSS.test(css);

/**
 * The stylesheet of a session, with `userDefinedLinkHintCss` after it.
 *
 * It is appended, and not merged, so that a user rule wins at equal
 * specificity. It is inside our shadow root, so a bad user rule can only break
 * our own overlay, and never the page. "Only our own overlay" is not nothing:
 * CSS that moves or relabels a marker can make a hint point at an element that
 * the user did not choose, and that is why `isSafeUserCss` exists.
 */
export const hintCss = (userDefinedLinkHintCss: string): string => {
  const user = userDefinedLinkHintCss.trim();
  if (user.length === 0 || !isSafeUserCss(user)) return HINT_CSS;
  return `${HINT_CSS}\n/* user */\n${user}\n`;
};

// ---------------------------------------------------------------------------
// The markers
// ---------------------------------------------------------------------------

export interface MarkerSpec {
  readonly rect: HintRect;
  readonly hintString: string;
  /** How many first characters are already typed. They are drawn dimmed. */
  readonly matchedLength: number;
  readonly secondary: boolean;
  /** Filter mode: the candidate that `Enter` would activate. */
  readonly active: boolean;
  /** Filter mode: drawn beside the number when the hint has no visible text. */
  readonly linkText: string;
  readonly showLinkText: boolean;
  readonly hidden: boolean;
}

/** Keep the marker inside the viewport when a hint sits against an edge. */
const MARKER_INSET = 2;

/** How many characters of the link text a marker shows. */
const MAX_LABEL_LENGTH = 40;

export interface MarkerLayer {
  /**
   * Draw `specs`, and reuse the marker elements between two calls.
   *
   * Filter mode draws again on every keystroke, so one new element for each
   * marker would mean thousands of node creations for one session.
   */
  readonly render: (specs: readonly MarkerSpec[]) => Effect.Effect<void>;
  /**
   * Take the scroll position of now as the position of the next `render`.
   *
   * The caller measured the rects of its hints again, so those rects are
   * against the viewport of now. Without this, the layer would translate them
   * a second time by every scroll since the detection pass.
   */
  readonly reanchor: Effect.Effect<void>;
  /** Hide every marker at once. The elements stay for the next draw. */
  readonly clear: Effect.Effect<void>;
}

const paintText = (
  document: Document,
  marker: HTMLElement,
  spec: MarkerSpec,
): void => {
  const matched = spec.hintString.slice(0, spec.matchedLength);
  const rest = spec.hintString.slice(spec.matchedLength);
  const label = spec.showLinkText
    ? spec.linkText.slice(0, MAX_LABEL_LENGTH)
    : "";

  // `textContent` on each part, and never `innerHTML`: the page supplies the
  // link text, and it would otherwise be a route for injection into our own
  // overlay.
  marker.replaceChildren();
  if (matched.length > 0) {
    const dim = document.createElement("span");
    dim.className = "vw-hint__matched";
    dim.textContent = matched;
    marker.appendChild(dim);
  }
  marker.appendChild(document.createTextNode(rest));
  if (label.length > 0) {
    const text = document.createElement("span");
    text.className = "vw-hint__text";
    text.textContent = label;
    marker.appendChild(text);
  }
};

const paint = (
  document: Document,
  marker: HTMLElement,
  spec: MarkerSpec,
): void => {
  const classes = ["vw-hint"];
  if (spec.hidden) classes.push("vw-hint--hidden");
  if (spec.secondary) classes.push("vw-hint--secondary");
  if (spec.active) classes.push("vw-hint--active");
  marker.className = classes.join(" ");
  if (spec.hidden) return;

  const left = Math.max(MARKER_INSET, spec.rect.left);
  const top = Math.max(MARKER_INSET, spec.rect.top);
  // Whole pixels: a marker on a fractional boundary is drawn blurred, and hint
  // text at 11px has no legibility to spare.
  marker.style.transform = `translate(${Math.round(left)}px, ${
    Math.round(top)
  }px)`;

  paintText(document, marker, spec);
};

/**
 * Build the marker layer for the enclosing scope.
 *
 * The container, the listeners and the reposition fiber go when the scope
 * closes.
 */
export const makeMarkerLayer: Effect.Effect<
  MarkerLayer,
  never,
  Dom | Ui | Scope.Scope
> = Effect.gen(function*() {
  const dom = yield* Dom;
  const ui = yield* Ui;
  const document = dom.document;

  const hintsLayer = yield* ui.layer("hints");

  const container = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const element = document.createElement("div");
      element.className = "vw-hints";
      hintsLayer.appendChild(element);
      return element;
    }),
    (element) =>
      Effect.sync(() => {
        element.remove();
      }),
  );

  const markers = yield* Ref.make<ReadonlyArray<HTMLElement>>([]);

  /** Where the page stood when the rects of the current specs were measured. */
  const first = yield* dom.probeOr(
    () => ({ x: dom.window.scrollX, y: dom.window.scrollY }),
    { x: 0, y: 0 },
  );
  const originRef = yield* Ref.make(first);

  const scrollNow = Effect.flatMap(
    Ref.get(originRef),
    (origin) =>
      dom.probeOr(
        () => ({ x: dom.window.scrollX, y: dom.window.scrollY }),
        origin,
      ),
  );

  const applyOffset = Effect.gen(function*() {
    const viewport = yield* ui.viewport;
    const origin = yield* Ref.get(originRef);
    const scroll = yield* scrollNow;
    const dx = scroll.x - origin.x + viewport.offsetLeft;
    const dy = scroll.y - origin.y + viewport.offsetTop;
    yield* Effect.sync(() => {
      container.style.transform = `translate(${-dx}px, ${-dy}px)`;
    });
  });

  const reanchor = Effect.gen(function*() {
    const scroll = yield* scrollNow;
    yield* Ref.set(originRef, scroll);
    yield* applyOffset;
  });

  // One write for each animation frame. A scroll arrives far more often than
  // we can usefully draw again, and WebKit throttles the animation frames of a
  // cross-origin frame and of Low Power Mode to 30 each second, which is
  // exactly the back pressure that we want here.
  const frame = yield* FiberHandle.make<void, never>();
  const reposition = Effect.asVoid(
    FiberHandle.run(frame, Effect.andThen(dom.nextFrame, applyOffset)),
  );

  // The capture phase: a scroll does not bubble from an element that scrolls,
  // and a hint on an inner scroller must follow it as well.
  yield* dom.listen("document", "scroll", () => reposition, {
    capture: true,
    passive: true,
  });
  yield* dom.listen("window", "resize", () => reposition, { passive: true });

  const visualViewport = yield* dom.probeOr(
    () => Option.fromNullishOr(dom.window.visualViewport),
    Option.none<VisualViewport>(),
  );
  if (Option.isSome(visualViewport)) {
    const visual = visualViewport.value;
    yield* dom.listenOn(visual, "resize", () => reposition, { passive: true });
    yield* dom.listenOn(visual, "scroll", () => reposition, { passive: true });
  }

  yield* applyOffset;

  /**
   * Make sure that there are at least `count` marker elements.
   *
   * A marker is a child of the container, and the container is released with
   * the scope, so the markers go with it. There is nothing else to remove.
   */
  const grow = (count: number): Effect.Effect<ReadonlyArray<HTMLElement>> =>
    Ref.modify(markers, (current) => {
      if (current.length >= count) return [current, current];
      const next = [...current];
      while (next.length < count) {
        const marker = document.createElement("div");
        marker.className = "vw-hint";
        container.appendChild(marker);
        next.push(marker);
      }
      return [next, next];
    });

  const render = (specs: readonly MarkerSpec[]): Effect.Effect<void> =>
    Effect.flatMap(grow(specs.length), (elements) =>
      Effect.sync(() => {
        for (let index = 0; index < elements.length; index++) {
          const marker = elements[index];
          if (marker === undefined) continue;
          const spec = specs[index];
          if (spec === undefined) {
            marker.className = "vw-hint vw-hint--hidden";
            continue;
          }
          paint(document, marker, spec);
        }
      }));

  const clear = Effect.flatMap(
    Ref.get(markers),
    (elements) =>
      Effect.sync(() => {
        for (const marker of elements) {
          marker.className = "vw-hint vw-hint--hidden";
        }
      }),
  );

  return { render, reanchor, clear };
});
