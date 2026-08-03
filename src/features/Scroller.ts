/**
 * Scrolling.
 *
 * Ported from upstream Vimium's `content_scripts/scroller.js` (MIT), together
 * with its keyboard-repeat calibration. That calibration is not decoration. It
 * is the difference between scrolling that feels like Vim and scrolling that
 * feels cheap.
 *
 * WebKit specifics:
 *
 * - We animate ourselves against `behavior: "instant"`. The `smooth` easing of
 *   Safari cannot be cancelled, and `smooth` calls at key-repeat rate fight
 *   each other. `behavior: "smooth"` also did not animate in Safari before
 *   15.4, which is a second reason not to depend on it.
 * - `document.scrollingElement` is used for every root scroll. Never branch on
 *   `document.body` against `documentElement`. Hiding that WebKit difference is
 *   the reason that `scrollingElement` exists.
 * - Safari uses overlay scrollbars, so a `clientWidth` difference is not a
 *   usable signal for scrollability.
 * - A right-to-left container writes `scrollLeft` in two different ways across
 *   engines. Every offset here is normalised to one convention: zero at the
 *   left edge, and growth to the right. `RtlScrollModel` gives the detail.
 *
 * The animation is a forked fiber that waits on `dom.nextFrame`, and not a
 * `requestAnimationFrame` loop. One `FiberHandle` per axis holds the fiber, so
 * a new scroll interrupts the previous one, and the layer scope stops both.
 * The first step is applied at once, inside the keystroke that asked for it,
 * and the fiber starts only after that.
 */

import { Context, Effect, FiberHandle, Layer, Option, Ref } from "effect";
import { Commands } from "~/core/Commands.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { Dom } from "~/platform/Dom.ts";
import { deepActiveElement } from "~/platform/Elements.ts";

export type ScrollAxis = "x" | "y";

export interface ScrollPosition {
  readonly x: number;
  readonly y: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_CALIBRATION = 0.5;
const MAX_CALIBRATION = 1.6;
/** Target throughput during key repeat, in CSS pixels per animation frame. */
const CALIBRATION_TARGET_PX_PER_FRAME = 150;
/** Ignore the first frames. Scheduling noise dominates them. */
const CALIBRATION_WARMUP_MS = 75;

/**
 * The time that the first step covers, before a frame has been measured.
 *
 * The first step runs inside the keystroke, so there is no earlier timestamp to
 * measure against. One nominal frame is what the next real frame would have
 * given, and it makes the page move inside the key press.
 */
const NOMINAL_FRAME_MS = 16;

/**
 * The largest time that one step may cover.
 *
 * A background tab, a long layout or a suspended machine gives a gap of
 * seconds. Without this clamp the next step reaches full progress at once, and
 * the smooth scroll becomes a jump.
 */
const MAX_FRAME_MS = 100;

const AXIS_PROPERTIES = {
  y: {
    scrollSize: "scrollHeight",
    clientSize: "clientHeight",
    viewport: "innerHeight",
  },
  x: {
    scrollSize: "scrollWidth",
    clientSize: "clientWidth",
    viewport: "innerWidth",
  },
} as const;

const SCROLLABLE_OVERFLOW: ReadonlySet<string> = new Set([
  "auto",
  "scroll",
  "overlay",
]);

// ---------------------------------------------------------------------------
// Pure geometry
// ---------------------------------------------------------------------------

/** Upstream's easing budget: a longer scroll gets proportionally less time. */
const durationFor = (amount: number): number =>
  Math.max(100, 20 * Math.log(Math.max(Math.E, Math.abs(amount))));

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

/**
 * Apply one offset change, and answer how far the element truly moved.
 *
 * A delta needs no normalisation. In every model that a current engine uses,
 * `scrollLeft` grows to the right, so a positive delta moves the content to the
 * right on a left-to-right container and on a right-to-left one. Only the ends
 * of the range differ, and `rtlShift` below normalises those.
 */
const applyOffset = (
  element: Element,
  axis: ScrollAxis,
  delta: number,
): number => {
  const before = readOffset(element, axis);
  writeOffset(element, axis, before + delta);
  return readOffset(element, axis) - before;
};

// ---------------------------------------------------------------------------
// Right-to-left horizontal offsets
// ---------------------------------------------------------------------------

/**
 * How an engine writes `scrollLeft` in a right-to-left container.
 *
 * - `negative`: the range is `[-max, 0]`, and zero is the *right* edge, which
 *   is where such a container starts. WebKit, Blink and Gecko do this now.
 * - `nonNegative`: the range is `[0, max]`, and zero is the *left* edge. Older
 *   WebKit and older Blink did this, and Safari on an old device still can.
 *
 * We normalise both to one convention: **zero at the left edge, and growth to
 * the right**. That is what a left-to-right container already gives, so every
 * room check and every endpoint write below reads the same way on both.
 *
 * The old Internet Explorer model, where zero is the right edge and the value
 * grows to the *left*, is out of scope. No engine that runs a userscript
 * manager uses it, and no read-only test can tell it from `nonNegative`.
 */
export type RtlScrollModel = "negative" | "nonNegative";

/** The probe container. It is hidden, it is fixed, and it moves no layout. */
const RTL_PROBE_STYLE = "position:fixed;top:-9999px;left:-9999px;" +
  "width:4px;height:4px;overflow:scroll;direction:rtl;" +
  "scroll-behavior:auto;visibility:hidden;pointer-events:none;";

/**
 * Measure the model. Never read the user agent.
 *
 * A user agent string is a claim, and every engine copies the claims of the
 * others. The offsets of one hidden right-to-left container are the fact.
 *
 * The container starts at its right edge. A positive offset there means that
 * zero is the left edge, which is the `nonNegative` model. If the offset is
 * zero, a write of `-1` that survives means the `negative` model.
 *
 * `scroll-behavior: auto` is on the probe because a page rule of `smooth` would
 * defer the write, and the read back would then give the old value.
 */
export const detectRtlScrollModel = (document: Document): RtlScrollModel => {
  const host: Element | null = document.body ?? document.documentElement;
  if (host === null) return "negative";

  const outer = document.createElement("div");
  outer.setAttribute("style", RTL_PROBE_STYLE);
  const inner = document.createElement("div");
  inner.setAttribute("style", "width:40px;height:1px;");
  outer.appendChild(inner);
  host.appendChild(outer);

  try {
    if (outer.scrollLeft > 0) return "nonNegative";
    outer.scrollLeft = -1;
    return outer.scrollLeft < 0 ? "negative" : "nonNegative";
  } finally {
    outer.remove();
  }
};

/**
 * What to add to a raw offset to get the normalised one.
 *
 * Only a right-to-left container under the `negative` model needs a shift, and
 * the shift is the whole scroll range: raw `-max` is normalised `0`, and raw
 * `0` is normalised `max`.
 */
const rtlShift = (
  direction: string,
  axis: ScrollAxis,
  model: RtlScrollModel,
  max: number,
): number =>
  axis === "x" && model === "negative" && direction === "rtl" ? max : 0;

/** The same shift, when the caller has no computed style to hand. */
const shiftOf = (
  view: Window,
  element: Element,
  axis: ScrollAxis,
  model: RtlScrollModel,
): number => {
  if (axis === "y" || model === "nonNegative") return 0;
  const max = element.scrollWidth - element.clientWidth;
  return rtlShift(view.getComputedStyle(element).direction, axis, model, max);
};

/**
 * Can `element` absorb a scroll of this sign along `axis`?
 *
 * The check is read-only on purpose. Upstream confirms scrollability by moving
 * the offset by one pixel and reading it back. That probe is wrong in both
 * directions here. Under `scroll-behavior: smooth` the write is animated, so
 * the read in the same task gives the old value, and every nested smooth
 * scroller is judged unscrollable. That is why `j` inside one scrolled the
 * document by about 10px instead of the container by 60. The probe also fires a
 * `scroll` event on the page for every candidate of the walk, on every
 * keystroke.
 *
 * The computed `overflow` and the size comparison answer "is this a scroll
 * container". The remaining-room check answers "has it any room left in this
 * direction". The second answer is what makes the walk continue past an
 * exhausted inner container to the outer one.
 */
const isScrollable = (
  view: Window,
  element: Element,
  axis: ScrollAxis,
  amountSign: number,
  model: RtlScrollModel,
): boolean => {
  const properties = AXIS_PROPERTIES[axis];
  const style = view.getComputedStyle(element);
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  if (!SCROLLABLE_OVERFLOW.has(overflow)) return false;

  const scrollSize = element[properties.scrollSize];
  const clientSize = element[properties.clientSize];
  // Sub-pixel layout regularly leaves a fraction of a pixel of overflow on an
  // element that has nothing to scroll.
  const max = scrollSize - clientSize;
  if (max <= 1) return false;

  // Normalised, so that a right-to-left container answers the same question as
  // a left-to-right one. The raw offset of the first is `[-max, 0]` on a
  // current engine, where `offset > 0` is never true and `offset < max - 1`
  // is always true: every left command missed it, and every right command was
  // swallowed by it for ever.
  const offset = readOffset(element, axis) +
    rtlShift(style.direction, axis, model, max);
  return amountSign < 0 ? offset > 0 : offset < max - 1;
};

/** The parent, through the host of an open shadow root. */
const parentOf = (node: Element): Element | null => {
  const parent = node.parentElement;
  if (parent !== null) return parent;
  const treeRoot = node.getRootNode();
  return treeRoot instanceof ShadowRoot ? treeRoot.host : null;
};

/**
 * The nearest ancestor that can absorb the scroll.
 *
 * The walk goes through an open shadow root with `getRootNode().host`. A scroll
 * container inside a web component is invisible to a `parentElement` walk.
 */
const findScrollableAncestor = (
  view: Window,
  root: Element,
  start: Element | null,
  axis: ScrollAxis,
  amount: number,
  model: RtlScrollModel,
): Element => {
  let node: Element | null = start;

  while (node !== null && node !== root) {
    if (isScrollable(view, node, axis, Math.sign(amount) || 1, model)) {
      return node;
    }
    node = parentOf(node);
  }

  return root;
};

// ---------------------------------------------------------------------------
// The animation state
// ---------------------------------------------------------------------------

interface Animation {
  readonly element: Element;
  /** The physical key that holds this animation open, for key repeat. */
  readonly code: Option.Option<string>;
  readonly generation: number;
  readonly amount: number;
  /**
   * The distance already covered when the current leg started.
   *
   * Key repeat extends a running animation and sets `elapsed` back to zero,
   * which sets `progress` back to zero. Without this rebase the target of the
   * next step is zero *total* distance, and the scroll jumps backwards by
   * everything applied so far. It measured −367px on the first repeat step.
   */
  readonly origin: number;
  readonly duration: number;
  readonly elapsed: number;
  readonly applied: number;
  readonly frames: number;
  readonly lastTimestamp: Option.Option<number>;
}

/** What one step decided, before the element is asked to move. */
interface Frame {
  readonly element: Element;
  readonly frameDelta: number;
  readonly progress: number;
}

/** What one step decided after the element moved. */
interface Outcome {
  readonly running: boolean;
  readonly rate: number;
}

/**
 * Fold more distance into a running animation.
 *
 * The rebase onto `applied` is what makes this *more* distance instead of a
 * restart. A reset of `elapsed` alone puts `progress` back to zero, and the
 * next step then aims at zero total distance and jumps backwards by everything
 * covered so far.
 */
const merge = (animation: Animation, amount: number): Animation => ({
  ...animation,
  origin: animation.applied,
  amount: animation.amount + amount,
  duration: durationFor(
    Math.abs(animation.amount + amount - animation.applied),
  ),
  elapsed: 0,
});

/**
 * Move the calibration towards about 150px per frame.
 *
 * The frame rate is not a constant that we can know in advance. A cross-origin
 * frame is throttled to 30fps until the user interacts with it, and a busy main
 * thread drops frames at any time. Measuring the true throughput and correcting
 * it is the only way to make a held key feel the same in both cases.
 */
const recalibrate = (calibration: number, animation: Animation): number => {
  if (animation.elapsed < CALIBRATION_WARMUP_MS || animation.frames === 0) {
    return calibration;
  }
  const perFrame = Math.abs(animation.applied) / animation.frames;
  if (perFrame < CALIBRATION_TARGET_PX_PER_FRAME * 0.75) {
    return Math.min(MAX_CALIBRATION, calibration * 1.05);
  }
  if (perFrame > CALIBRATION_TARGET_PX_PER_FRAME * 1.25) {
    return Math.max(MIN_CALIBRATION, calibration * 0.95);
  }
  return calibration;
};

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Scroller extends Context.Service<Scroller, {
  /** Scroll by a distance in CSS pixels. The event identifies the key press. */
  readonly scrollBy: (
    axis: ScrollAxis,
    amount: number,
    event: Option.Option<KeyboardEvent>,
  ) => Effect.Effect<void>;

  /** Scroll by a fraction of the viewport, or of the scroll container. */
  readonly scrollByViewport: (
    axis: ScrollAxis,
    fraction: number,
    event: Option.Option<KeyboardEvent>,
  ) => Effect.Effect<void>;

  readonly scrollTo: (
    axis: ScrollAxis,
    position: "start" | "end" | number,
  ) => Effect.Effect<void>;

  readonly position: Effect.Effect<ScrollPosition>;

  readonly restore: (x: number, y: number) => Effect.Effect<void>;

  /** Call this from the key path, before a command runs. */
  readonly noteKeydown: (event: KeyboardEvent) => Effect.Effect<void>;

  readonly noteKeyup: (event: KeyboardEvent) => Effect.Effect<void>;
}>()("vimium/features/Scroller") {
  static readonly layer: Layer.Layer<
    Scroller,
    never,
    Commands | Dom | Report | Settings
  > = Layer.effect(
    Scroller,
    Effect.gen(function*() {
      const commands = yield* Commands;
      const dom = yield* Dom;
      const report = yield* Report;
      const settings = yield* Settings;

      const calibration = yield* Ref.make(1);
      /** Increased on every keydown that is not a repeat: "this press". */
      const generation = yield* Ref.make(0);
      const heldCodes = yield* Ref.make<ReadonlySet<string>>(new Set());
      /**
       * The engine model for a right-to-left offset, measured once.
       *
       * The measurement adds one hidden element and forces one layout, so it
       * happens on the first horizontal command and never on a vertical one.
       */
      const rtlModel = yield* Ref.make<Option.Option<RtlScrollModel>>(
        Option.none(),
      );
      const animations: Record<
        ScrollAxis,
        Ref.Ref<Option.Option<Animation>>
      > = {
        x: yield* Ref.make<Option.Option<Animation>>(Option.none()),
        y: yield* Ref.make<Option.Option<Animation>>(Option.none()),
      };
      // One handle per axis. `x` and `y` animate at the same time, and a new
      // scroll on one axis must not stop the other one.
      const fibers: Record<ScrollAxis, FiberHandle.FiberHandle<void>> = {
        x: yield* FiberHandle.make<void>(),
        y: yield* FiberHandle.make<void>(),
      };

      const rootElement = (): Element =>
        dom.document.scrollingElement ?? dom.document.documentElement;

      /**
       * The model for this axis.
       *
       * A vertical offset has one model everywhere, so it needs no
       * measurement. `nonNegative` is the answer that makes every shift zero.
       */
      const modelFor = (axis: ScrollAxis): Effect.Effect<RtlScrollModel> =>
        axis === "y" ? Effect.succeed("nonNegative" as const) : Effect.gen(
          function*() {
            const cached = yield* Ref.get(rtlModel);
            if (Option.isSome(cached)) return cached.value;
            // A realm that refuses the probe gets `negative`, which is what
            // every current engine does.
            const measured = yield* dom.probeOr(
              () => detectRtlScrollModel(dom.document),
              "negative" as const,
            );
            yield* Ref.set(rtlModel, Option.some(measured));
            return measured;
          },
        );

      /**
       * Should this scroll be animated at all?
       *
       * `prefers-reduced-motion` is the user telling the platform that
       * animation makes the web unusable for them. A userscript that animates
       * anyway overrides an accessibility setting with a preference.
       */
      const animated = Effect.gen(function*() {
        if (!settings.currentUnsafe().smoothScroll) return false;
        const reduced = yield* dom.probeOr(
          () =>
            dom.window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          false,
        );
        return !reduced;
      });

      /** The element that must absorb the scroll. */
      const target = (
        axis: ScrollAxis,
        amount: number,
        model: RtlScrollModel,
      ): Effect.Effect<Element> =>
        dom.probeOr(
          () =>
            findScrollableAncestor(
              dom.window,
              rootElement(),
              deepActiveElement(dom.document),
              axis,
              amount,
              model,
            ),
          rootElement(),
        );

      const cancel = (axis: ScrollAxis): Effect.Effect<void> =>
        Effect.gen(function*() {
          yield* Ref.set(animations[axis], Option.none());
          yield* FiberHandle.clear(fibers[axis]);
        });

      const applyInstant = Effect.fn("Scroller.applyInstant")(
        function*(element: Element, axis: ScrollAxis, amount: number) {
          yield* Effect.sync(() => {
            const moved = applyOffset(element, axis, amount);
            // The chosen element refused the scroll, so it lied about being
            // scrollable. Give the distance to the document instead.
            if (moved === 0) {
              const root = rootElement();
              if (root !== element) applyOffset(root, axis, amount);
            }
          });
        },
      );

      /**
       * One step of the animation.
       *
       * It answers `true` while the animation continues. The state is read and
       * written in two indivisible sections, with the element write between
       * them, so a key repeat that arrives in the middle is not lost.
       */
      const step = (
        axis: ScrollAxis,
        timestamp: number,
      ): Effect.Effect<boolean> =>
        Effect.gen(function*() {
          const rate = yield* Ref.get(calibration);
          const frame = yield* Ref.modify(
            animations[axis],
            (state): [Option.Option<Frame>, Option.Option<Animation>] => {
              if (Option.isNone(state)) return [Option.none(), state];
              const animation = state.value;
              const previous = Option.getOrElse(
                animation.lastTimestamp,
                () => timestamp - NOMINAL_FRAME_MS,
              );
              const delta = Math.min(
                Math.max(0, timestamp - previous),
                MAX_FRAME_MS,
              );
              const elapsed = animation.elapsed + delta;
              // The calibration scales the *rate*, and not the distance. A
              // multiplication of the target distance by it made every scroll
              // 60% longer than `scrollStepSize` says, as soon as the
              // calibration reached its ceiling of 1.6 — which takes a few
              // presses.
              const progress = Math.min(
                1,
                (elapsed * rate) / animation.duration,
              );
              const goal = animation.origin +
                (animation.amount - animation.origin) * progress;
              return [
                Option.some({
                  element: animation.element,
                  frameDelta: Math.trunc(goal - animation.applied),
                  progress,
                }),
                Option.some({
                  ...animation,
                  elapsed,
                  frames: animation.frames + 1,
                  lastTimestamp: Option.some(timestamp),
                }),
              ];
            },
          );

          if (Option.isNone(frame)) return false;
          const { element, frameDelta, progress } = frame.value;

          const moved = yield* Effect.sync(() =>
            frameDelta === 0 ? 0 : applyOffset(element, axis, frameDelta)
          );

          if (frameDelta !== 0 && moved === 0) {
            // The element refused the scroll. It is at the end of its range, or
            // it lied about being scrollable. Give the rest to the document
            // instead of stopping without a word.
            const state = yield* Ref.get(animations[axis]);
            const applied = Option.isSome(state) ? state.value.applied : 0;
            const root = rootElement();
            if (root !== element && applied === 0) {
              yield* Effect.sync(() => {
                applyOffset(root, axis, frameDelta);
              });
            }
            yield* Ref.set(animations[axis], Option.none());
            return false;
          }

          const held = yield* Ref.get(heldCodes);
          const stepSize = settings.currentUnsafe().scrollStepSize;

          const outcome = yield* Ref.modify(
            animations[axis],
            (state): [Outcome, Option.Option<Animation>] => {
              if (Option.isNone(state)) {
                return [{ running: false, rate }, state];
              }
              const animation: Animation = {
                ...state.value,
                applied: state.value.applied + moved,
              };
              const next = recalibrate(rate, animation);
              const stillHeld = Option.isSome(animation.code) &&
                held.has(animation.code.value);

              if (progress >= 1 && !stillHeld) {
                return [{ running: false, rate: next }, Option.none()];
              }
              if (progress >= 1 && stillHeld) {
                // Key repeat: extend the animation instead of restarting it, so
                // a held key gives one continuous glide and not a staircase.
                return [
                  { running: true, rate: next },
                  Option.some({
                    ...animation,
                    origin: animation.applied,
                    amount: animation.amount +
                      Math.sign(animation.amount) * Math.abs(stepSize),
                    duration: durationFor(Math.abs(stepSize)),
                    elapsed: 0,
                  }),
                ];
              }
              return [{ running: true, rate: next }, Option.some(animation)];
            },
          );

          yield* Ref.set(calibration, outcome.rate);
          return outcome.running;
        });

      const loop = (axis: ScrollAxis): Effect.Effect<void> =>
        Effect.gen(function*() {
          let running = true;
          while (running) {
            const timestamp = yield* dom.nextFrame;
            running = yield* step(axis, timestamp);
          }
        });

      /** A defect in the animation leaves the page stuck. The user must know. */
      const animate = (axis: ScrollAxis): Effect.Effect<void> =>
        Effect.catchDefect(loop(axis), (defect) =>
          Effect.gen(function*() {
            yield* Effect.logError("the scroll animation failed", defect);
            yield* report.error("Scrolling stopped after an internal failure");
          }));

      const start = Effect.fn("Scroller.start")(
        function*(
          element: Element,
          axis: ScrollAxis,
          amount: number,
          code: Option.Option<string>,
        ) {
          yield* Ref.set(
            animations[axis],
            Option.some<Animation>({
              element,
              code,
              generation: yield* Ref.get(generation),
              amount,
              origin: 0,
              duration: durationFor(Math.abs(amount)),
              elapsed: 0,
              applied: 0,
              frames: 0,
              lastTimestamp: Option.none(),
            }),
          );
          // The first step happens here, inside the keystroke, and not on the
          // next frame. Nothing above suspends, so the page moves while the
          // browser is still dispatching the key.
          const now = yield* dom.now;
          if (!(yield* step(axis, now))) return;
          yield* FiberHandle.run(fibers[axis], animate(axis));
        },
      );

      const scrollElementBy = Effect.fn("Scroller.scrollElementBy")(
        function*(
          element: Element,
          axis: ScrollAxis,
          amount: number,
          event: Option.Option<KeyboardEvent>,
        ) {
          if (!(yield* animated)) {
            yield* applyInstant(element, axis, amount);
            return;
          }

          // An empty `code` is not a physical key that we can watch, so it is
          // absent and not a value.
          const code = Option.flatMap(
            event,
            (value) =>
              value.code === "" ? Option.none() : Option.some(value.code),
          );
          const existing = yield* Ref.get(animations[axis]);
          if (Option.isSome(existing) && existing.value.element === element) {
            // A second press while the first one still glides. Adding the
            // distance, instead of cancelling, is what makes three taps scroll
            // three steps whatever their timing. A cancel discarded what the
            // first press had not yet applied.
            yield* Ref.set(
              animations[axis],
              Option.some({
                ...merge(existing.value, amount),
                code: Option.isSome(code) ? code : existing.value.code,
                generation: yield* Ref.get(generation),
              }),
            );
            return;
          }

          yield* start(element, axis, amount, code);
        },
      );

      /** Extend the running animation when this press already owns it. */
      const mergeThisPress = (
        axis: ScrollAxis,
        amount: number,
      ): Effect.Effect<boolean> =>
        Effect.gen(function*() {
          const existing = yield* Ref.get(animations[axis]);
          const press = yield* Ref.get(generation);
          if (Option.isNone(existing) || existing.value.generation !== press) {
            return false;
          }
          yield* Ref.set(
            animations[axis],
            Option.some(merge(existing.value, amount)),
          );
          return true;
        });

      const scrollBy = Effect.fn("Scroller.scrollBy")(
        function*(
          axis: ScrollAxis,
          amount: number,
          event: Option.Option<KeyboardEvent>,
        ) {
          if (amount === 0) return;
          // Checked *before* a target is resolved. The walk reads a computed
          // style at every step, and on the key-repeat path its result is
          // thrown away. That is waste at about 30 Hz.
          if (yield* mergeThisPress(axis, amount)) return;
          const model = yield* modelFor(axis);
          const element = yield* target(axis, amount, model);
          yield* scrollElementBy(element, axis, amount, event);
        },
      );

      const scrollByViewport = Effect.fn("Scroller.scrollByViewport")(
        function*(
          axis: ScrollAxis,
          fraction: number,
          event: Option.Option<KeyboardEvent>,
        ) {
          // One walk, and not two: `scrollBy` would resolve the same target
          // again.
          const model = yield* modelFor(axis);
          const element = yield* target(axis, fraction, model);
          const properties = AXIS_PROPERTIES[axis];
          const size = element === rootElement()
            ? dom.window[properties.viewport]
            : element[properties.clientSize];

          const amount = Math.round(size * fraction);
          if (amount === 0) return;
          if (yield* mergeThisPress(axis, amount)) return;
          yield* scrollElementBy(element, axis, amount, event);
        },
      );

      const scrollTo = Effect.fn("Scroller.scrollTo")(
        function*(axis: ScrollAxis, position: "start" | "end" | number) {
          const model = yield* modelFor(axis);
          const element = yield* target(
            axis,
            position === "start" ? -1 : 1,
            model,
          );
          const properties = AXIS_PROPERTIES[axis];
          const max = element[properties.scrollSize] -
            element[properties.clientSize];
          // Normalised: zero is the left edge, and `max` is the right one. A
          // right-to-left container under the negative model needs `-max` and
          // `0` instead, and the shift below makes that change.
          const value = position === "start"
            ? 0
            : position === "end"
            ? max
            : position;
          yield* cancel(axis);
          yield* Effect.asVoid(dom.probeOr(() => {
            writeOffset(
              element,
              axis,
              value - shiftOf(dom.window, element, axis, model),
            );
            return true;
          }, false));
        },
      );

      const noteKeydown = Effect.fn("Scroller.noteKeydown")(
        function*(event: KeyboardEvent) {
          if (event.repeat) return;
          yield* Ref.update(generation, (value) => value + 1);
          if (event.code) {
            yield* Ref.update(
              heldCodes,
              (codes) => new Set(codes).add(event.code),
            );
          }
        },
      );

      const noteKeyup = Effect.fn("Scroller.noteKeyup")(
        function*(event: KeyboardEvent) {
          if (!event.code) return;
          yield* Ref.update(heldCodes, (codes) => {
            const next = new Set(codes);
            next.delete(event.code);
            return next;
          });
        },
      );

      // A lost `keyup` — the window loses focus in the middle of a repeat —
      // would otherwise leave an animation running for ever.
      //
      // Bubble phase, and not capture: `blur` does not bubble, so a capturing
      // `window` listener ran for *every element blur on the page*. That is
      // thousands of calls on a form-heavy site, to answer a question that only
      // the blur of the window can answer.
      yield* dom.listen(
        "window",
        "blur",
        () => Ref.set(heldCodes, new Set()),
      );

      const service = Scroller.of({
        scrollBy,
        scrollByViewport,
        scrollTo,
        position: Effect.sync(() => {
          const root = rootElement();
          return { x: root.scrollLeft, y: root.scrollTop };
        }),
        restore: (x, y) =>
          Effect.sync(() => {
            // `instant`: a restore is a jump. A smooth restore would fight with
            // whatever the user does next.
            rootElement().scrollTo({ left: x, top: y, behavior: "instant" });
          }),
        noteKeydown,
        noteKeyup,
      });

      const configuredStep = (): number =>
        settings.currentUnsafe().scrollStepSize;

      yield* commands.registerAll({
        scrollDown: ({ count, event }) =>
          service.scrollBy(
            "y",
            configuredStep() * count,
            Option.fromNullOr(event),
          ),
        scrollUp: ({ count, event }) =>
          service.scrollBy(
            "y",
            -configuredStep() * count,
            Option.fromNullOr(event),
          ),
        scrollLeft: ({ count, event }) =>
          service.scrollBy(
            "x",
            -configuredStep() * count,
            Option.fromNullOr(event),
          ),
        scrollRight: ({ count, event }) =>
          service.scrollBy(
            "x",
            configuredStep() * count,
            Option.fromNullOr(event),
          ),
        scrollPageDown: ({ count, event }) =>
          service.scrollByViewport("y", 0.5 * count, Option.fromNullOr(event)),
        scrollPageUp: ({ count, event }) =>
          service.scrollByViewport("y", -0.5 * count, Option.fromNullOr(event)),
        scrollFullPageDown: ({ count, event }) =>
          service.scrollByViewport("y", 1 * count, Option.fromNullOr(event)),
        scrollFullPageUp: ({ count, event }) =>
          service.scrollByViewport("y", -1 * count, Option.fromNullOr(event)),
        scrollToTop: () => service.scrollTo("y", "start"),
        scrollToBottom: () => service.scrollTo("y", "end"),
        scrollToLeft: () => service.scrollTo("x", "start"),
        scrollToRight: () => service.scrollTo("x", "end"),
      });

      return service;
    }),
  );
}
