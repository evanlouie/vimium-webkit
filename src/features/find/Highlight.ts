/**
 * The highlight of the matches, and the CSS that draws it.
 *
 * The rectangles live in the `"find"` layer of the one closed shadow root. That
 * layer is fixed to the viewport and it carries `z-index: 2147483647`.
 * `Range.getClientRects()` gives one rectangle for each line box, so a match
 * that wraps over a line gives two rectangles and both must be drawn. One
 * `getBoundingClientRect` would paint a block over the text between them.
 *
 * A position is corrected for the scroll of the window instead of measured
 * again, because that correction is one style write for any number of matches.
 * The correction is not enough on its own: a nested container that scrolls, and
 * a reflow, move some ranges and not others. The overlay therefore keeps the
 * matches, and measures them again when it sees a change that the correction
 * cannot describe. `reposition` says which event takes which path. On iOS the
 * offset of the visual viewport is subtracted as well, because the host of the
 * overlay is moved by it to imitate `position: device-fixed`.
 *
 * Every element and every listener here is a scoped resource. Close the scope
 * that built the highlighter, and the overlay goes with it. There is no
 * `dispose` method.
 */

import { Effect, Exit, FiberHandle, Option, Ref, Scope } from "effect";
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

/** What `render` drew, so that a later frame can draw it again. */
interface Drawn {
  readonly matches: ReadonlyArray<FindMatch>;
  readonly currentIndex: number;
}

/**
 * The measured place of the current match, at the last full measurement.
 *
 * It is the probe for a layout change that no event names. See `frame`.
 */
interface Anchor {
  readonly index: number;
  readonly left: number;
  readonly top: number;
}

/**
 * How far the anchor may move before the overlay measures again.
 *
 * One pixel, because a scroll offset can be fractional under a zoom, and a
 * measurement that follows a fraction would run on every frame.
 */
const ANCHOR_TOLERANCE = 1;

// ---------------------------------------------------------------------------
// The highlighter
// ---------------------------------------------------------------------------

export interface Highlighter {
  /**
   * Measure and draw.
   *
   * `currentIndex` may be out of range, which means "none".
   */
  readonly render: (
    matches: ReadonlyArray<FindMatch>,
    currentIndex: number,
  ) => Effect.Effect<void>;

  /** Hide every rectangle, and keep the elements for the next search. */
  readonly clear: Effect.Effect<void>;
}

/**
 * Build a highlighter that belongs to the enclosing scope.
 *
 * Close that scope to remove the overlay, the listeners and the fiber that
 * follows the scroll.
 */
export const makeHighlighter: Effect.Effect<
  Highlighter,
  never,
  Dom | Ui | Scope.Scope
> = Effect.gen(function*() {
  const dom = yield* Dom;
  const ui = yield* Ui;
  const doc = dom.document;
  const win = dom.window;

  // The scope of the highlighter is kept, so that a rectangle element which is
  // made later still belongs to it. `render` has no scope of its own, and an
  // element must live as long as the overlay.
  const scope = yield* Scope.Scope;
  const scoped = <A, E>(
    effect: Effect.Effect<A, E, Scope.Scope>,
  ): Effect.Effect<A, E> => Effect.provideService(effect, Scope.Scope, scope);

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
  /**
   * The matches that are on the screen now.
   *
   * They are kept so that a frame which cannot use the scroll correction can
   * measure them again. `clear` drops them, so a cleared overlay holds no
   * `Range` and pins no node.
   */
  const drawn = yield* Ref.make<Drawn>({ matches: [], currentIndex: -1 });
  const anchor = yield* Ref.make<Option.Option<Anchor>>(Option.none());
  /** Does the frame that is already asked for need a full measurement? */
  const remeasure = yield* Ref.make(false);

  const readScroll: Effect.Effect<Origin> = dom.probeOr(
    () => ({ x: win.scrollX, y: win.scrollY }),
    { x: 0, y: 0 },
  );

  /**
   * Move the container by the difference in the scroll since the measurement.
   *
   * The offset of the visual viewport is added, because the host of the overlay
   * is already moved by it.
   */
  const applyOffset = Effect.fn("Highlighter.applyOffset")(function*() {
    const viewport = yield* ui.viewport;
    const start = yield* Ref.get(origin);
    const scroll = yield* readScroll;
    const dx = scroll.x - start.x + viewport.offsetLeft;
    const dy = scroll.y - start.y + viewport.offsetTop;
    yield* Effect.sync(() => {
      container.style.transform = `translate(${-dx}px, ${-dy}px)`;
    });
  });

  /**
   * The place of the current match, for the probe of the next frame.
   *
   * One rectangle, and not one for each match: the probe must cost the same on
   * a page with four matches and on a page with four hundred.
   */
  const measureAnchor = Effect.fn("Highlighter.measureAnchor")(
    function*(matches: ReadonlyArray<FindMatch>, currentIndex: number) {
      const match = matches[currentIndex];
      if (match === undefined) return Option.none<Anchor>();
      return yield* dom.probeOr<Option.Option<Anchor>>(() => {
        const rect = match.range.getBoundingClientRect();
        return Option.some({
          index: currentIndex,
          left: rect.left,
          top: rect.top,
        });
      }, Option.none<Anchor>());
    },
  );

  /**
   * Did the current match move by more than the scroll of the window?
   *
   * A reflow gives no event that names it: an image that arrives, a font that
   * loads and a panel that opens all move the text with no scroll and no
   * resize. One measurement for each frame answers that, and its cost does not
   * grow with the number of matches.
   */
  const anchorMoved = Effect.fn("Highlighter.anchorMoved")(function*() {
    const mark = yield* Ref.get(anchor);
    if (Option.isNone(mark)) return false;
    const state = yield* Ref.get(drawn);
    const match = state.matches[mark.value.index];
    if (match === undefined) return false;
    const start = yield* Ref.get(origin);
    const scroll = yield* readScroll;
    const dx = scroll.x - start.x;
    const dy = scroll.y - start.y;
    return yield* dom.probeOr(() => {
      const rect = match.range.getBoundingClientRect();
      return Math.abs(rect.left - (mark.value.left - dx)) > ANCHOR_TOLERANCE ||
        Math.abs(rect.top - (mark.value.top - dy)) > ANCHOR_TOLERANCE;
    }, false);
  });

  const measure = Effect.fn("Highlighter.measure")(
    function*(matches: ReadonlyArray<FindMatch>, currentIndex: number) {
      const viewport = yield* ui.viewport;
      const minTop = -VIEWPORT_MARGIN;
      const maxTop = viewport.height + VIEWPORT_MARGIN;

      return yield* dom.probeOr<ReadonlyArray<PlacedRect>>(() => {
        const placed: PlacedRect[] = [];
        // The current match comes first, so that the limit can never drop it.
        const order = [currentIndex, ...matches.keys()];
        const drawn = new Set<number>();

        for (const index of order) {
          if (placed.length >= MAX_RENDERED_RECTS) break;
          if (drawn.has(index)) continue;
          const match = matches[index];
          if (match === undefined) continue;
          drawn.add(index);

          const current = index === currentIndex;
          for (const rect of match.range.getClientRects()) {
            if (rect.width === 0 || rect.height === 0) continue;
            if (!current && (rect.bottom < minTop || rect.top > maxTop)) {
              continue;
            }
            placed.push({
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              current,
            });
          }
        }
        return placed;
      }, []);
    },
  );

  /** Make sure that the pool holds at least `count` elements. */
  const grow = Effect.fn("Highlighter.grow")(function*(count: number) {
    let pool = yield* Ref.get(rects);
    while (pool.length < count) {
      const element = yield* scoped(Effect.acquireRelease(
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
      ));
      pool = [...pool, element];
      yield* Ref.set(rects, pool);
    }
    return pool;
  });

  const paint = Effect.fn("Highlighter.paint")(
    function*(placed: ReadonlyArray<PlacedRect>) {
      const pool = yield* grow(placed.length);
      yield* Effect.sync(() => {
        for (let index = 0; index < pool.length; index++) {
          const element = pool[index];
          if (element === undefined) continue;
          const rect = placed[index];
          if (rect === undefined) {
            element.className = "vw-find__rect vw-find__rect--hidden";
            continue;
          }
          element.className = rect.current
            ? "vw-find__rect vw-find__rect--current"
            : "vw-find__rect";
          element.style.width = `${rect.width}px`;
          element.style.height = `${rect.height}px`;
          element.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
        }
      });
    },
  );

  const render = Effect.fn("Highlighter.render")(
    function*(matches: ReadonlyArray<FindMatch>, currentIndex: number) {
      // A new measurement sets the scroll baseline again. Everything after this
      // call is a difference from here.
      yield* Ref.set(drawn, { matches, currentIndex });
      yield* Ref.set(origin, yield* readScroll);
      yield* paint(yield* measure(matches, currentIndex));
      yield* Ref.set(anchor, yield* measureAnchor(matches, currentIndex));
      yield* applyOffset();
    },
  );

  /** Measure and draw the same matches again, after the layout moved them. */
  const redraw = Effect.fn("Highlighter.redraw")(function*() {
    const state = yield* Ref.get(drawn);
    if (state.matches.length === 0) return;
    yield* render(state.matches, state.currentIndex);
  });

  const clear = Effect.gen(function*() {
    const pool = yield* Ref.get(rects);
    yield* Ref.set(drawn, { matches: [], currentIndex: -1 });
    yield* Ref.set(anchor, Option.none());
    yield* Effect.sync(() => {
      for (const element of pool) {
        element.className = "vw-find__rect vw-find__rect--hidden";
      }
    });
  });

  // ---------------------------------------------------------------------
  // Following the page
  // ---------------------------------------------------------------------

  const repositionFiber = yield* FiberHandle.make<void, never>();

  /**
   * The work of one animation frame.
   *
   * Two paths, and the events choose between them:
   *
   * - **The correction.** The window scrolled, so every rectangle moved by the
   *   same amount. One style write answers that, whatever the number of
   *   matches. The probe of one rectangle follows, so a reflow that no event
   *   named is still seen.
   * - **The measurement.** A nested container scrolled, the window was resized
   *   or the document changed size. Each of those moves some ranges and not
   *   others, so no single offset can describe it and every drawn rectangle is
   *   measured again.
   *
   * The cost of the correction does not grow with the number of matches: two
   * reads of the scroll, one rectangle, one style write. The measurement costs
   * one `getClientRects` for each drawn match, and at most `MAX_RENDERED_RECTS`
   * style writes.
   */
  const frame = Effect.gen(function*() {
    if (yield* Ref.getAndSet(remeasure, false)) {
      yield* redraw();
      return;
    }
    yield* applyOffset();
    if (yield* anchorMoved()) yield* redraw();
  });

  /**
   * One pass for each animation frame.
   *
   * `onlyIfMissing` gives the behaviour of the old `rafCoalesce`: the first
   * event of a frame asks for the pass, and every later event of the same
   * frame is dropped instead of starting the wait again. A later event can
   * still raise the pass to a full measurement, because the flag is read when
   * the frame arrives.
   */
  const reposition = Effect.asVoid(FiberHandle.run(
    repositionFiber,
    Effect.andThen(dom.nextFrame, frame),
    { onlyIfMissing: true },
  ));

  /** Ask for a full measurement on the next frame. */
  const repositionAll = Effect.andThen(Ref.set(remeasure, true), reposition);

  /**
   * Did the window scroll, or did an element inside the page scroll?
   *
   * The page scroll moves every match by one offset, and the correction
   * answers it. A scroll of an element moves the text inside that element
   * only, so the rectangles must be measured again.
   */
  const isPageScroll = (target: EventTarget | null): boolean =>
    target === doc || target === win || target === doc.scrollingElement ||
    target === doc.documentElement || target === doc.body;

  // The capture phase: `scroll` does not bubble out of an element that
  // scrolls, and a match inside an inner scroll container must follow it too.
  yield* dom.listen(
    "document",
    "scroll",
    (event) => isPageScroll(event.target) ? reposition : repositionAll,
    { capture: true, passive: true },
  );
  // A resize reflows the page, so every range can move on its own.
  yield* dom.listen("window", "resize", () => repositionAll, {
    passive: true,
  });

  const visualViewport = yield* dom.probeOr(
    () => Option.fromNullishOr(win.visualViewport),
    Option.none<VisualViewport>(),
  );
  if (Option.isSome(visualViewport)) {
    const visual = visualViewport.value;
    // A change of the visible viewport can be a keyboard that opens, and that
    // reflows the page. A pan or a pinch does not, and the correction with the
    // probe answers it.
    yield* dom.listenOn(visual, "resize", () => repositionAll, {
      passive: true,
    });
    yield* dom.listenOn(visual, "scroll", () => reposition, { passive: true });
  }

  // The services of this layer, for the observer callback. The callback is an
  // imperative caller, and `runSyncExitWith` is the bridge that
  // `ARCHITECTURE.md` section 3 names. `platform/Dom.ts` uses the same helper
  // for a listener.
  const services = yield* Effect.context<never>();
  const runObserver = Effect.runSyncExitWith(services);

  /**
   * Watch the page for a reflow that changes its size.
   *
   * An image that arrives, a panel that opens and a font that loads all move
   * the text with no scroll and no resize of the window. The observer reports
   * the change of the box, and the frame measures again. The observer watches
   * the root and the body only, and not the subtree, so a busy page reports
   * one box and not thousands.
   */
  yield* Effect.acquireRelease(
    dom.probeOr(() => {
      const observer = new ResizeObserver(() => {
        const exit = runObserver(repositionAll);
        // A defect here must not travel into the callback of the browser. The
        // overlay is a decoration, and a throw from a page callback is worse
        // than a highlight that is one frame late.
        if (Exit.isFailure(exit)) {
          runObserver(
            Effect.logError("the find overlay could not follow a reflow", exit),
          );
        }
      });
      observer.observe(doc.documentElement);
      if (doc.body !== null) observer.observe(doc.body);
      return Option.some(observer);
    }, Option.none<ResizeObserver>()),
    (observer) =>
      Effect.sync(() => {
        if (Option.isSome(observer)) observer.value.disconnect();
      }),
  );

  yield* Ref.set(origin, yield* readScroll);
  yield* applyOffset();

  return { render, clear };
});
