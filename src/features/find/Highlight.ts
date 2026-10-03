/**
 * The highlight of the matches, and the CSS that draws it.
 *
 * The rectangles live in the `"find"` layer of the one closed shadow root. That
 * layer is fixed to the viewport and it carries `z-index: 2147483647`.
 * `Range.getClientRects()` gives one rectangle for each line box, so a match
 * that wraps over a line gives two rectangles and both must be drawn. One
 * `getBoundingClientRect` would paint a block over the text between them.
 *
 * A position is corrected for the scroll instead of measured again. The
 * rectangles are measured once against the layout viewport, and the container
 * is moved by the difference in the scroll afterwards. Measuring some hundreds
 * of ranges on every scroll frame costs far more. On iOS the offset of the
 * visual viewport is subtracted as well, because the host of the overlay is
 * moved by it to imitate `position: device-fixed`.
 *
 * The scroll of an inner container is the exception. It moves the matches
 * inside it and no others, by an amount that the scroll of the window does not
 * give, so the rectangles are measured again, once for each animation frame.
 *
 * Every element and every listener here is a scoped resource. Close the scope
 * that built the highlighter, and the overlay goes with it. There is no
 * `dispose` method.
 */

import { Array, Boolean, Effect, FiberHandle, Option, Ref, Scope, pipe } from "effect";
import { whenSome } from "~/domain/Prelude.ts";
import { Dom } from "~/platform/Dom.ts";
import { Ui } from "~/ui/Ui.ts";
import type { FindMatch } from "./Engine.ts";

// ---------------------------------------------------------------------------
// The stylesheet
// ---------------------------------------------------------------------------

/** The key under which `Ui.setStyle` holds the sheet below. */
export const FIND_STYLE_KEY = "find";

/**
 * The CSS of the find overlay.
 *
 * It is installed with `ui.setStyle`, which puts it in the
 * `adoptedStyleSheets` of the shadow root. **Never build a `<style>` element
 * for this.** Safari applies the `style-src` of the *page* to a node that a
 * content script inserts, so a `<style>` tag is blocked on any site with a
 * strict policy, and a constructed stylesheet is not a fetch and is not
 * policed.
 *
 * Why we draw our own rectangles, and do not use `::selection` or the CSS
 * Custom Highlight API: page CSS cannot be trusted to leave `::selection`
 * alone, because many sites make it transparent, and `::highlight()` was not
 * usable across the WebKit versions that this application targets. Our own
 * rectangles are the only way to be certain that the user can see the match.
 *
 * The colours are the amber of the hint markers, on purpose: this is the same
 * extension speaking, and the user must not have to learn a second colour.
 *
 * The fill is translucent, and not opaque, because the rectangle sits *over*
 * the text: the shadow host is at `z-index: 2147483647`. Above about 45% alpha
 * the matched word becomes unreadable, which removes the reason for the
 * highlight.
 */
export const FIND_CSS = `
.vw-find {
  position: absolute;
  inset: 0;
  pointer-events: none;
  contain: layout style;
}

.vw-find__rect {
  position: absolute;
  top: 0;
  left: 0;
  box-sizing: border-box;
  background: rgba(255, 197, 66, 0.42);
  border-radius: 2px;
  pointer-events: none;
  will-change: transform;
}

/*
 * The current match. It is marked by an *outline* and not by a stronger fill:
 * an outline reads at one glance without hiding the letters below it, and it
 * survives a dark page, where a difference in the fill alone does not.
 */
.vw-find__rect--current {
  background: rgba(255, 138, 0, 0.45);
  outline: 2px solid #c2410c;
  outline-offset: 1px;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.75);
}

.vw-find__rect--hidden {
  display: none;
}
`;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The largest number of rectangles that we draw.
 *
 * A query of `e` matches some thousands of times. Above a few hundred the
 * highlights say nothing and cost a frame. The current match is always drawn,
 * so the limit can never hide the one rectangle that matters.
 */
export const MAX_RENDERED_RECTS = 400;

/**
 * A rectangle this far outside the viewport is still drawn.
 *
 * It makes a scroll into view smooth.
 */
const VIEWPORT_MARGIN = 400;

interface PlacedRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly current: boolean;
}

interface Origin {
  readonly x: number;
  readonly y: number;
}

/** What the overlay shows: the matches, and the index of the current one. */
interface Shown {
  readonly matches: ReadonlyArray<FindMatch>;
  readonly currentIndex: number;
}

const NOTHING_SHOWN: Shown = { matches: [], currentIndex: -1 };

/** The band of the page, in viewport coordinates, whose rectangles are drawn. */
interface Band {
  readonly minTop: number;
  readonly maxTop: number;
}

/**
 * The indexes of the matches, in the order that they are drawn.
 *
 * The current match comes first, so that the limit can never drop it.
 */
const drawOrder = (
  matches: ReadonlyArray<FindMatch>,
  currentIndex: number,
): ReadonlyArray<number> =>
  pipe(
    matches,
    Array.map((_, index) => index),
    Array.filter((index) => index !== currentIndex),
    Array.prepend(currentIndex),
  );

/**
 * The rectangles of one match that are worth drawing.
 *
 * A rectangle of no size draws nothing. A rectangle of another match is drawn
 * only near the viewport, and the current match is always drawn.
 */
const placedRects = (match: FindMatch, current: boolean, band: Band): ReadonlyArray<PlacedRect> =>
  pipe(
    Array.fromIterable(match.range.getClientRects()),
    Array.filter(
      (rect) =>
        rect.width !== 0 &&
        rect.height !== 0 &&
        (current || (rect.bottom >= band.minTop && rect.top <= band.maxTop)),
    ),
    Array.map((rect) => ({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      current,
    })),
  );

const NO_RECTS: ReadonlyArray<PlacedRect> = [];

/**
 * Every rectangle to draw, up to about `MAX_RENDERED_RECTS`.
 *
 * The limit is checked before each match, and a match is drawn whole, so the
 * last match can take the count a little past the limit. No match after the
 * limit is measured at all.
 */
const placeAll = (
  matches: ReadonlyArray<FindMatch>,
  currentIndex: number,
  band: Band,
): ReadonlyArray<PlacedRect> =>
  pipe(
    drawOrder(matches, currentIndex),
    Array.reduce(NO_RECTS, placeMatch(matches, currentIndex, band)),
  );

/** Add the rectangles of match `index`, while the limit allows one more match. */
const placeMatch =
  (matches: ReadonlyArray<FindMatch>, currentIndex: number, band: Band) =>
  (placed: ReadonlyArray<PlacedRect>, index: number): ReadonlyArray<PlacedRect> =>
    pipe(
      matches,
      Array.get(index),
      Option.filter(() => placed.length < MAX_RENDERED_RECTS),
      Option.map((match) => placedRects(match, index === currentIndex, band)),
      Option.map((rects) => pipe(placed, Array.appendAll(rects))),
      Option.getOrElse(() => placed),
    );

const rectClass: (current: boolean) => string = Boolean.match({
  onFalse: () => "vw-find__rect",
  onTrue: () => "vw-find__rect vw-find__rect--current",
});

const HIDDEN_RECT_CLASS = "vw-find__rect vw-find__rect--hidden";

/** Put one pooled element over `rect`. */
const place = (element: HTMLElement, rect: PlacedRect): void => {
  element.className = rectClass(rect.current);
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
  element.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
};

const hide = (element: HTMLElement): void => {
  element.className = HIDDEN_RECT_CLASS;
};

// ---------------------------------------------------------------------------
// The highlighter
// ---------------------------------------------------------------------------

export interface Highlighter {
  /**
   * Measure and draw.
   *
   * `currentIndex` may be out of range, which means "none".
   */
  readonly render: (matches: ReadonlyArray<FindMatch>, currentIndex: number) => Effect.Effect<void>;

  /** Hide every rectangle, and keep the elements for the next search. */
  readonly clear: Effect.Effect<void>;
}

/**
 * Build a highlighter that belongs to the enclosing scope.
 *
 * Close that scope to remove the overlay, the listeners and the fiber that
 * follows the scroll.
 */
export const makeHighlighter: Effect.Effect<Highlighter, never, Dom | Ui | Scope.Scope> =
  Effect.gen(function* () {
    const dom = yield* Dom;
    const ui = yield* Ui;
    const doc = dom.document;
    const win = dom.window;

    // The scope of the highlighter is kept, so that a rectangle element which is
    // made later still belongs to it. `render` has no scope of its own, and an
    // element must live as long as the overlay.
    const scope = yield* Scope.Scope;

    const findLayer = yield* ui.layer("find");

    const container = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const element = doc.createElement("div");
        element.className = "vw-find";
        findLayer.appendChild(element);
        return element;
      }),
      (element) =>
        Effect.sync(() => {
          element.remove();
        }),
    );

    const rects = yield* Ref.make<ReadonlyArray<HTMLElement>>([]);
    const origin = yield* Ref.make<Origin>({ x: 0, y: 0 });
    const shown = yield* Ref.make(NOTHING_SHOWN);
    /** Did an inner container scroll since the last measurement? */
    const innerScrolled = yield* Ref.make(false);

    const readScroll: Effect.Effect<Origin> = dom.probeOrElse(
      () => ({ x: win.scrollX, y: win.scrollY }),
      () => ({ x: 0, y: 0 }),
    );

    /**
     * Move the container by the difference in the scroll since the measurement.
     *
     * The offset of the visual viewport is added, because the host of the overlay
     * is already moved by it.
     */
    const applyOffset = Effect.fn("Highlighter.applyOffset")(function* () {
      const viewport = yield* ui.viewport;
      const start = yield* Ref.get(origin);
      const scroll = yield* readScroll;
      const dx = scroll.x - start.x + viewport.offsetLeft;
      const dy = scroll.y - start.y + viewport.offsetTop;
      yield* Effect.sync(() => {
        container.style.transform = `translate(${-dx}px, ${-dy}px)`;
      });
    });

    const measure = Effect.fn("Highlighter.measure")(function* (
      matches: ReadonlyArray<FindMatch>,
      currentIndex: number,
    ) {
      const viewport = yield* ui.viewport;
      const band: Band = {
        minTop: -VIEWPORT_MARGIN,
        maxTop: viewport.height + VIEWPORT_MARGIN,
      };
      return yield* dom.probeOrElse(
        () => placeAll(matches, currentIndex, band),
        () => [],
      );
    });

    /** A new rectangle element, which lives as long as the overlay. */
    const makeRect = pipe(
      Effect.acquireRelease(
        Effect.sync(() => {
          const div = doc.createElement("div");
          div.className = "vw-find__rect";
          container.appendChild(div);
          return div;
        }),
        (div) =>
          Effect.sync(() => {
            div.remove();
          }),
      ),
      Scope.provide(scope),
    );

    /** Make sure that the pool holds an element for each of `placed`. */
    const grow = Effect.fn("Highlighter.grow")(function* (placed: ReadonlyArray<PlacedRect>) {
      const pool = yield* Ref.get(rects);
      const added = yield* pipe(
        placed,
        Array.drop(pool.length),
        Effect.forEach(() => makeRect),
      );
      const grown = pipe(pool, Array.appendAll(added));
      yield* pipe(rects, Ref.set<ReadonlyArray<HTMLElement>>(grown));
      return grown;
    });

    const paint = Effect.fn("Highlighter.paint")(function* (placed: ReadonlyArray<PlacedRect>) {
      const pool = yield* grow(placed);
      yield* Effect.sync(() =>
        pipe(
          pool,
          Array.forEach((element, index) =>
            pipe(
              placed,
              Array.get(index),
              Option.match({
                onNone: () => hide(element),
                onSome: (rect) => place(element, rect),
              }),
            ),
          ),
        ),
      );
    });

    /** Measure and draw what the overlay shows. */
    const draw = Effect.fn("Highlighter.draw")(function* () {
      const { matches, currentIndex } = yield* Ref.get(shown);
      // A new measurement sets the scroll baseline again. Everything after this
      // call is a difference from here.
      const scroll = yield* readScroll;
      yield* pipe(origin, Ref.set(scroll));
      const placed = yield* measure(matches, currentIndex);
      yield* paint(placed);
      yield* applyOffset();
    });

    const render = Effect.fn("Highlighter.render")(function* (
      matches: ReadonlyArray<FindMatch>,
      currentIndex: number,
    ) {
      yield* pipe(shown, Ref.set<Shown>({ matches, currentIndex }));
      yield* draw();
    });

    const clear = pipe(
      shown,
      Ref.set(NOTHING_SHOWN),
      Effect.andThen(Ref.get(rects)),
      Effect.flatMap((pool) => Effect.sync(() => pipe(pool, Array.forEach(hide)))),
    );

    // ---------------------------------------------------------------------
    // Following the scroll
    // ---------------------------------------------------------------------

    const repositionFiber = yield* FiberHandle.make<void, never>();

    /** The correction of a frame: a new measurement after an inner scroll, and a move otherwise. */
    const correct = pipe(
      innerScrolled,
      Ref.getAndSet(false),
      Effect.flatMap(Boolean.match({ onFalse: () => applyOffset(), onTrue: () => draw() })),
    );

    /**
     * One correction for each animation frame.
     *
     * `onlyIfMissing` gives the behaviour of the old `rafCoalesce`: the first
     * event of a frame asks for the correction, and every later event of the same
     * frame is dropped instead of starting the wait again.
     */
    const reposition = pipe(
      dom.nextFrame,
      Effect.andThen(correct),
      FiberHandle.run(repositionFiber, { onlyIfMissing: true }),
      Effect.asVoid,
    );

    const remeasure = pipe(innerScrolled, Ref.set(true), Effect.andThen(reposition));

    // The capture phase: `scroll` does not bubble out of an element that
    // scrolls, so only a capturing listener on the document hears an inner
    // scroll container.
    yield* dom.listen(
      "document",
      "scroll",
      (event) =>
        pipe(
          event.target === doc,
          Boolean.match({ onFalse: () => remeasure, onTrue: () => reposition }),
        ),
      { capture: true, passive: true },
    );
    yield* dom.listen("window", "resize", () => reposition, { passive: true });

    const visualViewport = yield* dom.probeOrElse(
      () => Option.fromNullishOr(win.visualViewport),
      Option.none,
    );
    yield* pipe(
      visualViewport,
      whenSome((visual) =>
        pipe(
          ["resize", "scroll"],
          Effect.forEach(
            (type) => dom.listenOn(visual, type, () => reposition, { passive: true }),
            { discard: true },
          ),
        ),
      ),
    );

    const start = yield* readScroll;
    yield* pipe(origin, Ref.set(start));
    yield* applyOffset();

    return { render, clear };
  });
