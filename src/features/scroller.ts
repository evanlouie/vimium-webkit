/**
 * Scrolling.
 *
 * Ported from upstream Vimium's `content_scripts/scroller.js` (MIT), including
 * its keyboard-repeat calibration. That calibration is not incidental polish —
 * it is the difference between scrolling that feels like Vim and scrolling that
 * feels cheap.
 *
 * WebKit specifics (IMPLEMENTATION_PLAN.md §6.6):
 *
 * - We animate ourselves against `behavior: "instant"`. Safari's `smooth`
 *   easing is not cancellable, and stacking `smooth` calls at key-repeat rate
 *   produces visible fighting. (`behavior: "smooth"` did not actually animate
 *   in Safari until 15.4, which is a second reason not to depend on it.)
 * - `document.scrollingElement` is used unconditionally for root scrolling.
 *   Never branch on `document.body` vs `documentElement`: papering over that
 *   WebKit quirk is precisely why `scrollingElement` exists.
 * - Safari uses overlay scrollbars by default, so a `clientWidth` delta is not
 *   a usable scrollability signal.
 */

import type { ScrollAxis, ScrollerApi } from "~/core/context.ts";

const MIN_CALIBRATION = 0.5;
const MAX_CALIBRATION = 1.6;
/** Target throughput during key repeat, in CSS pixels per animation frame. */
const CALIBRATION_TARGET_PX_PER_FRAME = 150;
/** Ignore the first few frames; they are dominated by scheduling noise. */
const CALIBRATION_WARMUP_MS = 75;

const AXIS_PROPERTIES = {
  y: {
    scrollOffset: "scrollTop",
    scrollSize: "scrollHeight",
    clientSize: "clientHeight",
    overflow: "overflowY",
    viewport: "innerHeight",
  },
  x: {
    scrollOffset: "scrollLeft",
    scrollSize: "scrollWidth",
    clientSize: "clientWidth",
    overflow: "overflowX",
    viewport: "innerWidth",
  },
} as const;

type AxisProperties = (typeof AXIS_PROPERTIES)[ScrollAxis];

const readOffset = (element: Element, axis: ScrollAxis): number =>
  axis === "y" ? element.scrollTop : element.scrollLeft;

const writeOffset = (
  element: Element,
  axis: ScrollAxis,
  value: number,
): void => {
  if (axis === "y") element.scrollTop = value;
  else element.scrollLeft = value;
};

const SCROLLABLE_OVERFLOW: ReadonlySet<string> = new Set([
  "auto",
  "scroll",
  "overlay",
]);

/**
 * Is `element` actually scrollable along `axis`?
 *
 * The computed-style and size checks are necessary but not sufficient:
 * `scrollHeight`/`clientHeight` lie often enough (sub-pixel layout, sticky
 * children, `content-visibility`) that upstream confirms empirically by
 * nudging ±1px and observing. We do the same, and restore the offset.
 */
export const isScrollable = (
  element: Element,
  axis: ScrollAxis,
  amountSign: number,
): boolean => {
  const props: AxisProperties = AXIS_PROPERTIES[axis];
  const style = getComputedStyle(element);
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  if (!SCROLLABLE_OVERFLOW.has(overflow)) return false;

  const scrollSize = element[props.scrollSize];
  const clientSize = element[props.clientSize];
  if (scrollSize <= clientSize) return false;

  const before = readOffset(element, axis);
  const probe = amountSign < 0 ? -1 : 1;
  writeOffset(element, axis, before + probe);
  const moved = readOffset(element, axis) !== before;
  writeOffset(element, axis, before);
  return moved;
};

/**
 * The nearest ancestor that can absorb the scroll.
 *
 * Walks through open shadow roots via `getRootNode().host`, because a scroll
 * container inside a web component is otherwise invisible to a `parentElement`
 * walk.
 */
export const findScrollableAncestor = (
  start: Element | null,
  axis: ScrollAxis,
  amount: number,
): Element => {
  const root = document.scrollingElement ?? document.documentElement;
  let node: Element | null = start;

  while (node !== null && node !== root) {
    if (isScrollable(node, axis, Math.sign(amount) || 1)) return node;
    const parent: Element | null = node.parentElement;
    if (parent !== null) {
      node = parent;
      continue;
    }
    const treeRoot = node.getRootNode();
    node = treeRoot instanceof ShadowRoot ? treeRoot.host : null;
  }

  return root;
};

interface Animation {
  readonly axis: ScrollAxis;
  readonly element: Element;
  readonly code: string | null;
  readonly generation: number;
  amount: number;
  duration: number;
  elapsed: number;
  applied: number;
  frames: number;
  lastTimestamp: number;
  handle: number;
}

export interface ScrollerOptions {
  stepSize(): number;
  smooth(): boolean;
  /** The element scroll commands should act on; defaults to the focused one. */
  activeElement?: () => Element | null;
}

class Scroller implements ScrollerApi {
  readonly #options: ScrollerOptions;

  #calibration = 1;
  /** Bumped on every non-repeat keydown; identifies "this press". */
  #generation = 0;
  #heldCodes = new Set<string>();
  #animations = new Map<ScrollAxis, Animation>();

  constructor(options: ScrollerOptions) {
    this.#options = options;
    // A dropped `keyup` (window loses focus mid-repeat) would otherwise leave
    // an animation running forever.
    globalThis.addEventListener("blur", () => this.#releaseAll(), true);
  }

  /** Call from the global keydown listener, before command dispatch. */
  noteKeydown(event: KeyboardEvent): void {
    if (event.repeat) return;
    this.#generation++;
    if (event.code) this.#heldCodes.add(event.code);
  }

  noteKeyup(event: KeyboardEvent): void {
    if (event.code) this.#heldCodes.delete(event.code);
  }

  #releaseAll(): void {
    this.#heldCodes.clear();
  }

  scrollBy(
    axis: ScrollAxis,
    amount: number,
    event: KeyboardEvent | null,
  ): void {
    if (amount === 0) return;
    const element = this.#target(axis, amount);

    if (!this.#options.smooth()) {
      this.#applyInstant(element, axis, amount);
      return;
    }

    const existing = this.#animations.get(axis);
    // During key repeat the running animator simply keeps going: starting a
    // fresh one per repeat is what makes naive implementations accelerate
    // uncontrollably.
    if (existing && existing.generation === this.#generation) {
      existing.amount += amount;
      existing.duration = durationFor(
        Math.abs(existing.amount - existing.applied),
      );
      existing.elapsed = 0;
      return;
    }

    existing?.handle && cancelAnimationFrame(existing.handle);
    this.#start(element, axis, amount, event?.code ?? null);
  }

  scrollByViewport(
    axis: ScrollAxis,
    fraction: number,
    event: KeyboardEvent | null,
  ): void {
    const element = this.#target(axis, fraction);
    const props = AXIS_PROPERTIES[axis];
    const size =
      element === (document.scrollingElement ?? document.documentElement)
        ? globalThis[props.viewport]
        : element[props.clientSize];
    this.scrollBy(axis, Math.round(size * fraction), event);
  }

  scrollTo(axis: ScrollAxis, position: "start" | "end" | number): void {
    const element = this.#target(axis, position === "start" ? -1 : 1);
    const props = AXIS_PROPERTIES[axis];
    const max = element[props.scrollSize] - element[props.clientSize];
    const value = position === "start"
      ? 0
      : position === "end"
      ? max
      : position;
    this.#cancel(axis);
    writeOffset(element, axis, value);
  }

  position(): { readonly x: number; readonly y: number } {
    const root = document.scrollingElement ?? document.documentElement;
    return { x: root.scrollLeft, y: root.scrollTop };
  }

  restore(x: number, y: number): void {
    const root = document.scrollingElement ?? document.documentElement;
    // `instant`: a restore is a jump, and a smooth restore would fight with
    // whatever the user does next.
    root.scrollTo({ left: x, top: y, behavior: "instant" });
  }

  #target(axis: ScrollAxis, amount: number): Element {
    const seed = this.#options.activeElement?.() ??
      (document.activeElement instanceof Element
        ? document.activeElement
        : null);
    return findScrollableAncestor(seed, axis, amount);
  }

  #applyInstant(element: Element, axis: ScrollAxis, amount: number): void {
    const before = readOffset(element, axis);
    writeOffset(element, axis, before + amount);
    // If the chosen element refused the scroll (it lied about being
    // scrollable), fall back to the document.
    if (readOffset(element, axis) === before) {
      const root = document.scrollingElement ?? document.documentElement;
      if (root !== element) {
        writeOffset(root, axis, readOffset(root, axis) + amount);
      }
    }
  }

  #start(
    element: Element,
    axis: ScrollAxis,
    amount: number,
    code: string | null,
  ): void {
    const animation: Animation = {
      axis,
      element,
      code,
      generation: this.#generation,
      amount,
      duration: durationFor(Math.abs(amount)),
      elapsed: 0,
      applied: 0,
      frames: 0,
      lastTimestamp: 0,
      handle: 0,
    };

    const step = (timestamp: number): void => {
      if (animation.lastTimestamp === 0) animation.lastTimestamp = timestamp;
      const delta = timestamp - animation.lastTimestamp;
      animation.lastTimestamp = timestamp;
      animation.elapsed += delta;
      animation.frames++;

      const progress = Math.min(1, animation.elapsed / animation.duration);
      const target = animation.amount * progress * this.#calibration;
      const frameDelta = Math.trunc(target - animation.applied);

      if (frameDelta !== 0) {
        const before = readOffset(element, axis);
        writeOffset(element, axis, before + frameDelta);
        const moved = readOffset(element, axis) - before;
        animation.applied += moved;
        if (moved === 0) {
          // Hit the end of the scroll range; nothing further to do.
          this.#finish(axis, animation);
          return;
        }
      }

      this.#recalibrate(animation);

      const stillHeld = animation.code !== null &&
        this.#heldCodes.has(animation.code);
      if (progress >= 1 && !stillHeld) {
        this.#finish(axis, animation);
        return;
      }
      if (progress >= 1 && stillHeld) {
        // Key repeat: extend the animation rather than restarting it, so a held
        // key produces a continuous glide instead of a staircase.
        animation.amount += Math.sign(animation.amount) *
          Math.abs(this.#options.stepSize());
        animation.duration += durationFor(Math.abs(this.#options.stepSize()));
      }

      animation.handle = requestAnimationFrame(step);
    };

    animation.handle = requestAnimationFrame(step);
    this.#animations.set(axis, animation);
  }

  /**
   * Nudge calibration toward ~150px per frame.
   *
   * Frame rate is not a constant we can know ahead of time: cross-origin frames
   * are throttled to 30fps until interacted with, and a busy main thread drops
   * frames arbitrarily. Measuring actual throughput and correcting is the only
   * way a held key feels the same in both cases.
   */
  #recalibrate(animation: Animation): void {
    if (animation.elapsed < CALIBRATION_WARMUP_MS || animation.frames === 0) {
      return;
    }
    const perFrame = Math.abs(animation.applied) / animation.frames;
    if (perFrame < CALIBRATION_TARGET_PX_PER_FRAME * 0.75) {
      this.#calibration = Math.min(MAX_CALIBRATION, this.#calibration * 1.05);
    } else if (perFrame > CALIBRATION_TARGET_PX_PER_FRAME * 1.25) {
      this.#calibration = Math.max(MIN_CALIBRATION, this.#calibration * 0.95);
    }
  }

  #finish(axis: ScrollAxis, animation: Animation): void {
    cancelAnimationFrame(animation.handle);
    if (this.#animations.get(axis) === animation) this.#animations.delete(axis);
  }

  #cancel(axis: ScrollAxis): void {
    const animation = this.#animations.get(axis);
    if (animation) this.#finish(axis, animation);
  }
}

/** Upstream's easing budget: longer scrolls get proportionally less time. */
export const durationFor = (amount: number): number =>
  Math.max(100, 20 * Math.log(Math.max(Math.E, Math.abs(amount))));

export type { Scroller };

export const createScroller = (options: ScrollerOptions): Scroller =>
  new Scroller(options);
