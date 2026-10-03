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

import {
  Array,
  Data,
  Effect,
  FiberHandle,
  flow,
  Option,
  pipe,
  Ref,
  type Scope,
  String,
} from "effect";
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
 * `@import` and a URL make a network request, which turns a stylesheet into a
 * channel for exfiltration: an attribute selector plus a background image
 * reports which hints exist to a third-party host. A URL is `url(`, or `src(`,
 * or a plain string inside `image(` and `image-set(`, which also covers
 * `-webkit-image-set(`. None of them is needed to style a marker, so to refuse
 * them costs nothing true.
 */
const FORBIDDEN_CSS = /@import\b|@charset\b|(?:url|src|image(?:-set)?)\s*\(/iu;

/** CSS reads CR LF, a lone CR and FF as one LF, before it reads anything else. */
const CSS_NEWLINE = /\r\n?|\f/gu;

/** A hex escape with the one white space after it, or any other escaped character. */
const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})[ \t\n]?|([\s\S]))/giu;

/** The character of a hex escape. CSS reads zero, a surrogate and a value past Unicode as U+FFFD. */
const hexCharacter = (hex: string): string =>
  pipe(
    Number.parseInt(hex, 16),
    Option.liftPredicate(
      (code) => code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff),
    ),
    Option.match({
      onNone: () => "\uFFFD",
      onSome: (code) => globalThis.String.fromCodePoint(code),
    }),
  );

/** The character that one escape stands for. */
const unescapeOne = (
  _escape: string,
  hex: string | undefined,
  character: string | undefined,
): string =>
  pipe(
    Option.fromNullishOr(hex),
    Option.map(hexCharacter),
    Option.orElse(() => Option.fromNullishOr(character)),
    Option.getOrElse(() => ""),
  );

/**
 * The text that the tokenizer of CSS reads, with each escape replaced by its
 * character.
 *
 * The tokenizer reads `u\72l(` as `url(`, so a test of the raw text would not
 * see it.
 */
const unescapeCss = (css: string): string =>
  pipe(css, String.replaceAll(CSS_NEWLINE, "\n"), (text) => text.replace(CSS_ESCAPE, unescapeOne));

/**
 * Is this user CSS that we are willing to install?
 *
 * It is exported so that the settings dialog can refuse the value at the moment
 * when the user can correct it, and not drop it later in silence.
 */
export const isSafeUserCss = (css: string): boolean =>
  css.length <= MAX_USER_CSS_LENGTH && !FORBIDDEN_CSS.test(unescapeCss(css));

/**
 * The stylesheet of a session, with `userDefinedLinkHintCss` after it.
 *
 * It is appended, and not merged, so that a user rule wins at equal
 * specificity. It is inside our shadow root, so a bad user rule can only break
 * our own overlay, and never the page. "Only our own overlay" is not nothing:
 * CSS that moves or relabels a marker can make a hint point at an element that
 * the user did not choose, and that is why `isSafeUserCss` exists.
 */
export const hintCss: (userDefinedLinkHintCss: string) => string = flow(
  String.trim,
  Option.liftPredicate((user) => user.length > 0 && isSafeUserCss(user)),
  Option.match({
    onNone: () => HINT_CSS,
    onSome: (user) => `${HINT_CSS}\n/* user */\n${user}\n`,
  }),
);

// ---------------------------------------------------------------------------
// The markers
// ---------------------------------------------------------------------------

/** The classes of a marker that do not depend on whether it is drawn. */
type MarkerStyle = {
  readonly secondary: boolean;
  /** Filter mode: the candidate that `Enter` would activate. */
  readonly active: boolean;
};

/**
 * What one marker draws.
 *
 * A marker is hidden when the typed keys filter it out, or when the page took
 * its target away. A hidden marker keeps its element for the next draw, and
 * the classes of its style.
 */
export type MarkerSpec = Data.TaggedEnum<{
  Hidden: MarkerStyle;
  Shown: MarkerStyle & {
    readonly rect: HintRect;
    readonly hintString: string;
    /** How many first characters are already typed. They are drawn dimmed. */
    readonly matchedLength: number;
    /** Filter mode: the link text beside the number, for a hint that has no visible text. */
    readonly label: Option.Option<string>;
  };
}>;

export const MarkerSpec = Data.taggedEnum<MarkerSpec>();

type ShownMarker = Data.TaggedEnum.Value<MarkerSpec, "Shown">;

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

interface ScrollPosition {
  readonly x: number;
  readonly y: number;
}

const SHOWN_CLASSES = ["vw-hint"];
const HIDDEN_CLASSES = ["vw-hint", "vw-hint--hidden"];

/** The class list of a marker: the classes of its state, then those of its style. */
const classList = (state: ReadonlyArray<string>, { secondary, active }: MarkerStyle): string =>
  pipe(
    [
      { name: "vw-hint--secondary", on: secondary },
      { name: "vw-hint--active", on: active },
    ],
    Array.filter(({ on }) => on),
    Array.map(({ name }) => name),
    Array.prependAll(state),
    Array.join(" "),
  );

/** The class list of a marker that has no spec, or of every marker after `clear`. */
const HIDDEN_CLASS = classList(HIDDEN_CLASSES, { secondary: false, active: false });

const textSpan = (document: Document, className: string, text: string): HTMLSpanElement => {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
};

/** A span for text that is not empty. An empty span would add nothing. */
const optionalSpan = (
  document: Document,
  className: string,
): ((text: string) => Option.Option<HTMLSpanElement>) =>
  flow(
    Option.liftPredicate(String.isNonEmpty),
    Option.map((content) => textSpan(document, className, content)),
  );

const paintText = (document: Document, marker: HTMLElement, shown: ShownMarker): void => {
  const matched = shown.hintString.slice(0, shown.matchedLength);
  const rest = shown.hintString.slice(shown.matchedLength);
  const label = pipe(
    shown.label,
    Option.map((text) => text.slice(0, MAX_LABEL_LENGTH)),
    Option.flatMap(optionalSpan(document, "vw-hint__text")),
  );

  // `textContent` on each part, and never `innerHTML`: the page supplies the
  // link text, and it would otherwise be a route for injection into our own
  // overlay.
  marker.replaceChildren(
    ...Array.getSomes([
      pipe(matched, optionalSpan(document, "vw-hint__matched")),
      Option.some(document.createTextNode(rest)),
      label,
    ]),
  );
};

const paintShown = (document: Document, marker: HTMLElement, shown: ShownMarker): void => {
  marker.className = classList(SHOWN_CLASSES, shown);
  const left = Math.max(MARKER_INSET, shown.rect.left);
  const top = Math.max(MARKER_INSET, shown.rect.top);
  // Whole pixels: a marker on a fractional boundary is drawn blurred, and hint
  // text at 11px has no legibility to spare.
  marker.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  paintText(document, marker, shown);
};

const hide = (marker: HTMLElement): void => {
  marker.className = HIDDEN_CLASS;
};

const paint = (document: Document, marker: HTMLElement): ((spec: MarkerSpec) => void) =>
  MarkerSpec.$match({
    Hidden: (style) => {
      marker.className = classList(HIDDEN_CLASSES, style);
    },
    Shown: (shown) => paintShown(document, marker, shown),
  });

/** Draw each spec on the marker at its place. A marker without a spec is hidden. */
const paintAll = (
  document: Document,
  elements: ReadonlyArray<HTMLElement>,
  specs: readonly MarkerSpec[],
): void =>
  pipe(
    elements,
    Array.forEach((marker, index) =>
      pipe(
        specs,
        Array.get(index),
        Option.match({
          onNone: () => hide(marker),
          onSome: paint(document, marker),
        }),
      ),
    ),
  );

/**
 * Build the marker layer for the enclosing scope.
 *
 * The container, the listeners and the reposition fiber go when the scope
 * closes.
 */
export const makeMarkerLayer: Effect.Effect<MarkerLayer, never, Dom | Ui | Scope.Scope> =
  Effect.gen(function* () {
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

    const readScroll = (): ScrollPosition => ({ x: dom.window.scrollX, y: dom.window.scrollY });

    /** Where the page stood when the rects of the current specs were measured. */
    const first = yield* dom.probeOrElse(readScroll, () => ({ x: 0, y: 0 }));
    const originRef = yield* Ref.make(first);

    const scrollNow = pipe(
      originRef,
      Ref.get,
      Effect.flatMap((origin) => dom.probeOrElse(readScroll, () => origin)),
    );

    const applyOffset = Effect.gen(function* () {
      const viewport = yield* ui.viewport;
      const origin = yield* Ref.get(originRef);
      const scroll = yield* scrollNow;
      const dx = scroll.x - origin.x + viewport.offsetLeft;
      const dy = scroll.y - origin.y + viewport.offsetTop;
      yield* Effect.sync(() => {
        container.style.transform = `translate(${-dx}px, ${-dy}px)`;
      });
    });

    const reanchor = Effect.gen(function* () {
      const scroll = yield* scrollNow;
      yield* pipe(originRef, Ref.set(scroll));
      yield* applyOffset;
    });

    // One write for each animation frame. A scroll arrives far more often than
    // we can usefully draw again, and WebKit throttles the animation frames of a
    // cross-origin frame and of Low Power Mode to 30 each second, which is
    // exactly the back pressure that we want here.
    const frame = yield* FiberHandle.make<void, never>();
    const reposition = pipe(
      dom.nextFrame,
      Effect.andThen(applyOffset),
      FiberHandle.run(frame),
      Effect.asVoid,
    );

    // The capture phase: a scroll does not bubble from an element that scrolls,
    // and a hint on an inner scroller must follow it as well.
    yield* dom.listen("document", "scroll", () => reposition, {
      capture: true,
      passive: true,
    });
    yield* dom.listen("window", "resize", () => reposition, { passive: true });

    const visualViewport = yield* dom.probeOrElse(
      () => Option.fromNullishOr(dom.window.visualViewport),
      Option.none,
    );
    yield* pipe(
      visualViewport,
      Option.match({
        onNone: () => Effect.void,
        onSome: (visual) =>
          pipe(
            ["resize", "scroll"],
            Effect.forEach(
              (type) => dom.listenOn(visual, type, () => reposition, { passive: true }),
              {
                discard: true,
              },
            ),
          ),
      }),
    );

    yield* applyOffset;

    const newMarker = (): HTMLElement => {
      const marker = document.createElement("div");
      marker.className = "vw-hint";
      container.appendChild(marker);
      return marker;
    };

    /** The markers, with new ones after them until `count` specs fit. */
    const grownTo =
      (count: number) =>
      (current: ReadonlyArray<HTMLElement>): ReadonlyArray<HTMLElement> =>
        pipe(
          count - current.length,
          Option.liftPredicate((missing) => missing > 0),
          Option.map(Array.makeBy(newMarker)),
          Option.map(Array.prependAll(current)),
          Option.getOrElse(() => current),
        );

    /**
     * Make sure that there are at least `count` marker elements.
     *
     * A marker is a child of the container, and the container is released with
     * the scope, so the markers go with it. There is nothing else to remove.
     */
    const grow = (count: number): Effect.Effect<ReadonlyArray<HTMLElement>> =>
      pipe(markers, Ref.modify(flow(grownTo(count), (next) => [next, next] as const)));

    const render = (specs: readonly MarkerSpec[]): Effect.Effect<void> =>
      pipe(
        grow(specs.length),
        Effect.flatMap((elements) => Effect.sync(() => paintAll(document, elements, specs))),
      );

    const clear = pipe(
      markers,
      Ref.get,
      Effect.flatMap((elements) => Effect.sync(() => pipe(elements, Array.forEach(hide)))),
    );

    return { render, reanchor, clear };
  });
