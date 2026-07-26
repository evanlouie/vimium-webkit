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
 * Can `element` absorb a scroll of this sign along `axis`?
 *
 * Deliberately read-only. Upstream confirms scrollability by nudging the offset
 * ±1px and observing, and that probe is wrong in both directions here: under
 * `scroll-behavior: smooth` the write is *animated*, so reading back in the
 * same task returns the old value and every nested smooth scroller is judged
 * unscrollable — which is why `j` inside one scrolled the document by ~10px
 * instead of the container by 60. It also fires a `scroll` event on the page
 * for every candidate on the walk, on every keystroke.
 *
 * Computed `overflow` plus the size comparison answers "is this a scroll
 * container", and the remaining-room check answers "has it any left in this
 * direction" — which is what makes the walk continue past an exhausted inner
 * container to the outer one.
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
  // Sub-pixel layout routinely leaves a fraction of a pixel of "overflow" on
  // an element with nothing to scroll.
  if (scrollSize - clientSize <= 1) return false;

  const offset = readOffset(element, axis);
  return amountSign < 0 ? offset > 0 : offset < scrollSize - clientSize - 1;
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
  /** The physical key holding this animation open, for key-repeat detection. */
  code: string | null;
  generation: number;
  amount: number;
  /**
   * Distance already covered when the current leg started.
   *
   * Key repeat extends a running animation and resets `elapsed`, which sets
   * `progress` back to zero. Without a rebase the next frame's target is zero
   * *total* distance and the scroll jumps backwards by everything applied so
   * far — measured at −367px on the first repeat frame.
   */
  origin: number;
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
  readonly #onWindowBlur: () => void;

  #calibration = 1;
  /** Bumped on every non-repeat keydown; identifies "this press". */
  #generation = 0;
  #heldCodes = new Set<string>();
  #animations = new Map<ScrollAxis, Animation>();

  constructor(options: ScrollerOptions) {
    this.#options = options;
    // A dropped `keyup` (window loses focus mid-repeat) would otherwise leave
    // an animation running forever.
    //
    // Bubble phase, not capture: `blur` does not bubble, so a capturing
    // `window` listener ran for *every element blur on the page* — thousands of
    // times on a form-heavy site — to answer a question only the window's own
    // blur can answer.
    this.#onWindowBlur = () => this.#releaseAll();
    globalThis.addEventListener("blur", this.#onWindowBlur);
  }

  dispose(): void {
    globalThis.removeEventListener("blur", this.#onWindowBlur);
    for (const axis of [...this.#animations.keys()]) this.#cancel(axis);
    this.#heldCodes.clear();
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

    // Checked *before* resolving a target. `#target()` walks the ancestor chain
    // reading computed styles at every step, and on the key-repeat path its
    // result is thrown away — pure waste at ~30 Hz.
    const existing = this.#animations.get(axis);
    if (existing && existing.generation === this.#generation) {
      this.#merge(existing, amount);
      return;
    }

    this.#scrollElementBy(this.#target(axis, amount), axis, amount, event);
  }

  /**
   * Fold more distance into a running animation.
   *
   * Rebasing onto `applied` is what makes it *more* distance rather than a
   * restart: resetting `elapsed` alone puts `progress` back to zero, and the
   * next frame then aims at zero total distance and jumps backwards by
   * everything covered so far.
   */
  #merge(animation: Animation, amount: number): void {
    animation.origin = animation.applied;
    animation.amount += amount;
    animation.duration = durationFor(
      Math.abs(animation.amount - animation.applied),
    );
    animation.elapsed = 0;
  }

  #scrollElementBy(
    element: Element,
    axis: ScrollAxis,
    amount: number,
    event: KeyboardEvent | null,
  ): void {
    if (!this.#animated()) {
      this.#applyInstant(element, axis, amount);
      return;
    }

    const existing = this.#animations.get(axis);
    if (existing !== undefined && existing.element === element) {
      // A second press while the first is still gliding. Accumulating rather
      // than cancelling is what makes three taps scroll three steps whatever
      // their timing; cancelling discarded whatever the first press had not yet
      // applied.
      existing.code = event?.code ?? existing.code;
      existing.generation = this.#generation;
      this.#merge(existing, amount);
      return;
    }

    existing?.handle && cancelAnimationFrame(existing.handle);
    this.#start(element, axis, amount, event?.code ?? null);
  }

  /**
   * Should this scroll be animated at all?
   *
   * `prefers-reduced-motion` is a user telling the platform that animation
   * makes the web unusable for them; a userscript that animates anyway is
   * overriding an accessibility setting with a preference.
   */
  #animated(): boolean {
    if (!this.#options.smooth()) return false;
    if (typeof matchMedia !== "function") return true;
    return !matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  scrollByViewport(
    axis: ScrollAxis,
    fraction: number,
    event: KeyboardEvent | null,
  ): void {
    // One walk, not two: `scrollBy` would resolve the same target again.
    const element = this.#target(axis, fraction);
    const props = AXIS_PROPERTIES[axis];
    const size =
      element === (document.scrollingElement ?? document.documentElement)
        ? globalThis[props.viewport]
        : element[props.clientSize];

    const amount = Math.round(size * fraction);
    if (amount === 0) return;

    const existing = this.#animations.get(axis);
    if (existing && existing.generation === this.#generation) {
      this.#merge(existing, amount);
      return;
    }
    this.#scrollElementBy(element, axis, amount, event);
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
      origin: 0,
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

      // Calibration scales the *rate*, not the distance. Multiplying the
      // target distance by it meant a calibration that had drifted to its 1.6
      // ceiling — which it reaches within a few taps — silently made every
      // scroll 60% further than `scrollStepSize` says.
      const progress = Math.min(
        1,
        (animation.elapsed * this.#calibration) / animation.duration,
      );
      const target = animation.origin +
        (animation.amount - animation.origin) * progress;
      const frameDelta = Math.trunc(target - animation.applied);

      if (frameDelta !== 0) {
        const before = readOffset(element, axis);
        writeOffset(element, axis, before + frameDelta);
        const moved = readOffset(element, axis) - before;
        animation.applied += moved;
        if (moved === 0) {
          // The element refused the scroll: either it is at the end of its
          // range, or it lied about being scrollable. Hand the remainder to the
          // document rather than stopping silently.
          const root = document.scrollingElement ?? document.documentElement;
          if (root !== element && animation.applied === 0) {
            writeOffset(root, axis, readOffset(root, axis) + frameDelta);
          }
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
        animation.origin = animation.applied;
        animation.amount += Math.sign(animation.amount) *
          Math.abs(this.#options.stepSize());
        animation.duration = durationFor(Math.abs(this.#options.stepSize()));
        animation.elapsed = 0;
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
