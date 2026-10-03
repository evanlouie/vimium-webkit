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
 *
 * The animation is a forked fiber that waits on `dom.nextFrame`, and not a
 * `requestAnimationFrame` loop. One `FiberHandle` per axis holds the fiber, so
 * a new scroll interrupts the previous one, and the layer scope stops both.
 * The first step is applied at once, inside the keystroke that asked for it,
 * and the fiber starts only after that.
 */

import {
  Array,
  Boolean,
  Context,
  Data,
  Effect,
  FiberHandle,
  HashSet,
  Iterable,
  Layer,
  Match,
  Option,
  Order,
  Predicate,
  Ref,
  Struct,
  flow,
  pipe,
} from "effect";
import { constFalse } from "effect/Function";
import { Commands } from "~/core/Commands.ts";
import { recoverUnlessInterrupted } from "~/core/Recovery.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { Dom } from "~/platform/Dom.ts";
import { deepActiveElement, isUserEvent } from "~/platform/Elements.ts";

export type ScrollAxis = "x" | "y";

export interface ScrollPosition {
  readonly x: number;
  readonly y: number;
}

/** Where `scrollTo` goes: one end of the range, or an offset in CSS pixels. */
type OffsetTarget = "start" | "end" | number;

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
    offset: "scrollTop",
    overflow: "overflowY",
    scrollSize: "scrollHeight",
    clientSize: "clientHeight",
    viewport: "innerHeight",
  },
  x: {
    offset: "scrollLeft",
    overflow: "overflowX",
    scrollSize: "scrollWidth",
    clientSize: "clientWidth",
    viewport: "innerWidth",
  },
} as const;

const SCROLLABLE_OVERFLOW: ReadonlyArray<string> = ["auto", "scroll", "overlay"];

// ---------------------------------------------------------------------------
// Pure geometry
// ---------------------------------------------------------------------------

/** Which way a scroll goes along its axis. */
type Direction = "backward" | "forward";

/** Only a negative distance goes back. A distance of zero goes forward. */
const directionOf = (amount: number): Direction =>
  pipe(
    amount < 0,
    Boolean.match({
      onFalse: (): Direction => "forward",
      onTrue: (): Direction => "backward",
    }),
  );

/** `scrollTo` walks towards the start only to reach the start. */
const directionTo = (position: OffsetTarget): Direction =>
  pipe(
    Match.value(position),
    Match.withReturnType<Direction>(),
    Match.when("start", () => "backward"),
    Match.orElse(() => "forward"),
  );

/** The offset that `scrollTo` writes, given the largest offset of the element. */
const offsetFor = (position: OffsetTarget, max: number): number =>
  pipe(
    Match.value(position),
    Match.when("start", () => 0),
    Match.when("end", () => max),
    Match.orElse((offset) => offset),
  );

/** A distance of zero is nothing to scroll. */
const nonZero = Option.liftPredicate((amount: number) => amount !== 0);

/** Upstream's easing budget: a longer scroll gets proportionally less time. */
const durationFor = (amount: number): number =>
  Math.max(100, 20 * Math.log(Math.max(Math.E, Math.abs(amount))));

const readOffset = (element: Element, axis: ScrollAxis): number =>
  element[AXIS_PROPERTIES[axis].offset];

const writeOffset = (element: Element, axis: ScrollAxis, value: number): void => {
  element[AXIS_PROPERTIES[axis].offset] = value;
};

/** Apply one offset change, and answer how far the element truly moved. */
const applyOffset = (element: Element, axis: ScrollAxis, delta: number): number => {
  const before = readOffset(element, axis);
  writeOffset(element, axis, before + delta);
  return readOffset(element, axis) - before;
};

/** What an element did with a distance that it was asked to move. */
type Motion = Data.TaggedEnum<{
  /** It moved this far. A frame that asks for nothing moves nothing. */
  Moved: { readonly distance: number };
  /** It moved nothing, although it was asked to move `delta`. */
  Refused: { readonly delta: number };
}>;
const Motion = Data.taggedEnum<Motion>();

/** Ask an element to move, and classify what it did. */
const moveElement = (element: Element, axis: ScrollAxis, delta: number): Motion =>
  pipe(
    applyOffset(element, axis, delta),
    Option.liftPredicate((moved) => moved !== 0),
    Option.match({
      onNone: () => Motion.Refused({ delta }),
      onSome: (moved) => Motion.Moved({ distance: moved }),
    }),
  );

/** How far the content of an element reaches past its box along `axis`. */
const overflowOf = (element: Element, axis: ScrollAxis): number =>
  element[AXIS_PROPERTIES[axis].scrollSize] - element[AXIS_PROPERTIES[axis].clientSize];

/**
 * Has the element room left to scroll in this direction?
 *
 * Sub-pixel layout regularly leaves a fraction of a pixel of overflow on an
 * element that has nothing to scroll, so a pixel of overflow is no room.
 */
const hasRoom = (element: Element, axis: ScrollAxis, direction: Direction): boolean => {
  const room = overflowOf(element, axis);
  const offset = readOffset(element, axis);
  return (
    room > 1 &&
    pipe(
      Match.value(direction),
      Match.when("backward", () => offset > 0),
      Match.when("forward", () => offset < room - 1),
      Match.exhaustive,
    )
  );
};

/**
 * Is `element` a scroll container with something to scroll along `axis`?
 *
 * The size comes first, because it is the cheaper read and most elements fail
 * it.
 */
const isScrollContainer = (view: Window, element: Element, axis: ScrollAxis): boolean =>
  overflowOf(element, axis) > 1 &&
  pipe(
    SCROLLABLE_OVERFLOW,
    Array.contains(view.getComputedStyle(element)[AXIS_PROPERTIES[axis].overflow]),
  );

/**
 * Can `element` absorb a scroll in this direction along `axis`?
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
  direction: Direction,
): boolean => isScrollContainer(view, element, axis) && hasRoom(element, axis, direction);

const isShadowRoot = (node: Node): node is ShadowRoot => node instanceof ShadowRoot;

/**
 * The element above this one.
 *
 * The walk goes through an open shadow root with `getRootNode().host`. A scroll
 * container inside a web component is invisible to a `parentElement` walk.
 */
const parentOf = (element: Element): Option.Option<Element> =>
  pipe(
    element.parentElement,
    Option.fromNullOr,
    Option.orElse(() =>
      pipe(
        element.getRootNode(),
        Option.liftPredicate(isShadowRoot),
        Option.map((root) => root.host),
      ),
    ),
  );

/** The start and every element above it, up to the root and without it. */
const ancestorsBelow =
  (root: Element) =>
  (start: Option.Option<Element>): Iterable<Element> =>
    Iterable.unfold(
      start,
      flow(
        Option.filter((element) => element !== root),
        Option.map((element) => [element, parentOf(element)] as const),
      ),
    );

/** The area of the part of `element` that is inside the viewport. */
const visibleArea = (view: Window, element: Element): number => {
  const rect = element.getBoundingClientRect();
  const width = Math.min(rect.right, view.innerWidth) - Math.max(rect.left, 0);
  const height = Math.min(rect.bottom, view.innerHeight) - Math.max(rect.top, 0);
  return Math.max(0, width) * Math.max(0, height);
};

interface Candidate {
  readonly element: Element;
  readonly area: number;
}

const largestFirst: Order.Order<Candidate> = pipe(
  Order.flip(Order.Number),
  Order.mapInput((candidate: Candidate) => candidate.area),
);

/**
 * The largest scroll container in view, found as upstream's
 * `firstScrollableElement` finds it.
 *
 * An element that scrolls along the axis answers for itself. Otherwise its
 * children are tried, the one with the largest visible area first, so the
 * search goes down the main pane of an app shell and not down its toolbar. A
 * child that is out of view is never tried.
 */
const largestScrollable =
  (view: Window, axis: ScrollAxis) =>
  (element: Element): Option.Option<Element> =>
    pipe(
      element,
      Option.liftPredicate((element) => isScrollContainer(view, element, axis)),
      Option.orElse(() =>
        pipe(
          Array.fromIterable(element.children),
          Array.map((child) => ({ element: child, area: visibleArea(view, child) })),
          Array.filter(({ area }) => area > 0),
          Array.sort(largestFirst),
          Array.findFirst(({ element: child }) => largestScrollable(view, axis)(child)),
        ),
      ),
    );

/**
 * The element that must absorb a scroll along `axis` in `direction`.
 *
 * The nearest ancestor of `start` that can absorb it comes first. The document
 * comes next, when it scrolls along the axis at all. An app shell hides the
 * overflow of its `body` and scrolls a pane inside it, so a document that does
 * not scroll gives the scroll to the largest scroll container in view. The
 * document is the last resort.
 */
const scrollTarget = (
  view: Window,
  root: Element,
  start: Option.Option<Element>,
  axis: ScrollAxis,
  direction: Direction,
): Element =>
  pipe(
    start,
    ancestorsBelow(root),
    Iterable.findFirst((element) => isScrollable(view, element, axis, direction)),
    Option.orElse(() =>
      pipe(
        root,
        Option.liftPredicate((root) => overflowOf(root, axis) > 1),
      ),
    ),
    Option.orElse(() => largestScrollable(view, axis)(view.document.body ?? root)),
    Option.getOrElse(() => root),
  );

/**
 * Where the walk for the scroll target starts.
 *
 * The focus says where the user is, unless it rests on the page itself. A click
 * on a pane that cannot take the focus leaves it on `body`. The element that
 * the user pressed last stands in then, which is what makes `j` scroll the
 * pane that the user clicked into. Upstream keeps the same element for the
 * same reason.
 */
const walkStart = (document: Document, pressed: Option.Option<Element>): Option.Option<Element> =>
  pipe(
    deepActiveElement(document),
    Option.fromNullOr,
    Option.filter((focused) => focused !== document.body && focused !== document.documentElement),
    Option.orElse(() =>
      pipe(
        pressed,
        Option.filter((element) => element.isConnected),
      ),
    ),
  );

/** The element that a press truly started at, through an open shadow root. */
const pressedElement = (event: Event): Option.Option<Element> =>
  pipe(
    event.composedPath(),
    Array.head,
    Option.filter((target) => target instanceof Element),
  );

/**
 * The physical key of a press.
 *
 * An empty `code` is not a physical key that we can watch, so it is absent and
 * not a value.
 */
const physicalKey = (event: KeyboardEvent): Option.Option<string> =>
  pipe(
    event.code,
    Option.liftPredicate((code) => code !== ""),
  );

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
  /** The distance that this frame asks for, when it asks for any. */
  readonly delta: Option.Option<number>;
  readonly progress: number;
}

/** What one step decided after the element moved. */
interface Outcome {
  readonly running: boolean;
  readonly rate: number;
}

/** Everything that the end of a step reads, besides the animation. */
interface Settlement {
  readonly rate: number;
  /** How far the element truly moved in this frame. */
  readonly distance: number;
  readonly progress: number;
  /** The physical keys that are down now. */
  readonly held: HashSet.HashSet<string>;
  readonly stepSize: number;
}

/**
 * Fold more distance into a running animation.
 *
 * The rebase onto `applied` is what makes this *more* distance instead of a
 * restart. A reset of `elapsed` alone puts `progress` back to zero, and the
 * next step then aims at zero total distance and jumps backwards by everything
 * covered so far.
 */
const merged =
  (amount: number) =>
  (animation: Animation): Animation =>
    pipe(
      animation,
      Struct.assign({
        origin: animation.applied,
        amount: animation.amount + amount,
        duration: durationFor(Math.abs(animation.amount + amount - animation.applied)),
        elapsed: 0,
      }),
    );

/**
 * Add distance to the animation that this press owns.
 *
 * The answer is the extended animation. An animation of an earlier press, or
 * none at all, stays as it is and answers `None`.
 */
const extendedBy =
  (press: number, amount: number) =>
  (
    state: Option.Option<Animation>,
  ): readonly [Option.Option<Animation>, Option.Option<Animation>] => {
    const extended = pipe(
      state,
      Option.filter((animation) => animation.generation === press),
      Option.map(merged(amount)),
    );
    return [
      extended,
      pipe(
        extended,
        Option.orElse(() => state),
      ),
    ];
  };

/**
 * Run a transition on the animation of an axis.
 *
 * An axis with no animation answers `None`, and it stays without one.
 */
const onAnimation =
  <B>(transition: (animation: Animation) => readonly [B, Option.Option<Animation>]) =>
  (state: Option.Option<Animation>): readonly [Option.Option<B>, Option.Option<Animation>] =>
    pipe(
      state,
      Option.match({
        onNone: () => [Option.none<B>(), state] as const,
        onSome: flow(transition, ([answer, next]) => [Option.some(answer), next] as const),
      }),
    );

/**
 * Count one more frame of an animation.
 *
 * The answer is what the frame must draw, and the animation that has counted
 * the time of the frame.
 */
const timed =
  (timestamp: number, rate: number) =>
  (animation: Animation): readonly [Frame, Option.Option<Animation>] => {
    const previous = pipe(
      animation.lastTimestamp,
      Option.getOrElse(() => timestamp - NOMINAL_FRAME_MS),
    );
    const delta = Math.min(Math.max(0, timestamp - previous), MAX_FRAME_MS);
    const elapsed = animation.elapsed + delta;
    // The calibration scales the *rate*, and not the distance. A
    // multiplication of the target distance by it made every scroll 60%
    // longer than `scrollStepSize` says, as soon as the calibration reached
    // its ceiling of 1.6 — which takes a few presses.
    const progress = Math.min(1, (elapsed * rate) / animation.duration);
    const goal = animation.origin + (animation.amount - animation.origin) * progress;
    return [
      {
        element: animation.element,
        delta: nonZero(Math.trunc(goal - animation.applied)),
        progress,
      },
      pipe(
        animation,
        Struct.assign({
          elapsed,
          frames: animation.frames + 1,
          lastTimestamp: Option.some(timestamp),
        }),
        Option.some,
      ),
    ];
  };

/** The first frames, and a leg with no frame, say nothing about throughput. */
const isWarmingUp = (animation: Animation): boolean =>
  animation.elapsed < CALIBRATION_WARMUP_MS || animation.frames === 0;

/** The distance per frame so far, once the first frames are behind. */
const throughput: (animation: Animation) => Option.Option<number> = flow(
  Option.liftPredicate(Predicate.not(isWarmingUp)),
  Option.map(({ applied, frames }) => Math.abs(applied) / frames),
);

/** Nudge the calibration towards the target throughput. */
const corrected =
  (calibration: number) =>
  (perFrame: number): number =>
    pipe(
      Match.value(perFrame),
      Match.when(
        (measured) => measured < CALIBRATION_TARGET_PX_PER_FRAME * 0.75,
        () => Math.min(MAX_CALIBRATION, calibration * 1.05),
      ),
      Match.when(
        (measured) => measured > CALIBRATION_TARGET_PX_PER_FRAME * 1.25,
        () => Math.max(MIN_CALIBRATION, calibration * 0.95),
      ),
      Match.orElse(() => calibration),
    );

/**
 * Move the calibration towards about 150px per frame.
 *
 * The frame rate is not a constant that we can know in advance. A cross-origin
 * frame is throttled to 30fps until the user interacts with it, and a busy main
 * thread drops frames at any time. Measuring the true throughput and correcting
 * it is the only way to make a held key feel the same in both cases.
 */
const recalibrate = (calibration: number, animation: Animation): number =>
  pipe(
    animation,
    throughput,
    Option.map(corrected(calibration)),
    Option.getOrElse(() => calibration),
  );

/**
 * Key repeat: extend the animation instead of restarting it, so a held key
 * gives one continuous glide and not a staircase.
 */
const repeatedLeg = (animation: Animation, stepSize: number): Animation =>
  pipe(
    animation,
    Struct.assign({
      origin: animation.applied,
      amount: animation.amount + Math.sign(animation.amount) * Math.abs(stepSize),
      duration: durationFor(Math.abs(stepSize)),
      elapsed: 0,
    }),
  );

/** The key that holds an animation open, while it is still down. */
const heldKey = (animation: Animation, held: HashSet.HashSet<string>): Option.Option<string> =>
  pipe(
    animation.code,
    Option.filter((code) => pipe(held, HashSet.has(code))),
  );

/** The animation after a frame. A finished leg ends it, unless its key is still held. */
const nextLeg = (
  animation: Animation,
  { progress, held, stepSize }: Settlement,
): Option.Option<Animation> =>
  pipe(
    progress >= 1,
    Boolean.match({
      onFalse: () => Option.some(animation),
      onTrue: () =>
        pipe(
          heldKey(animation, held),
          Option.map(() => repeatedLeg(animation, stepSize)),
        ),
    }),
  );

/** Count the distance that a frame moved, and decide what follows it. */
const settled =
  (settlement: Settlement) =>
  (current: Animation): readonly [Outcome, Option.Option<Animation>] => {
    const animation: Animation = pipe(
      current,
      Struct.assign({ applied: current.applied + settlement.distance }),
    );
    const next = nextLeg(animation, settlement);
    return [{ running: Option.isSome(next), rate: recalibrate(settlement.rate, animation) }, next];
  };

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Scroller extends Context.Service<
  Scroller,
  {
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

    readonly scrollTo: (axis: ScrollAxis, position: OffsetTarget) => Effect.Effect<void>;

    readonly position: Effect.Effect<ScrollPosition>;

    readonly restore: (x: number, y: number) => Effect.Effect<void>;
  }
>()("vimium/features/Scroller") {
  static readonly layer: Layer.Layer<Scroller, never, Commands | Dom | Report | Settings> =
    Layer.effect(
      Scroller,
      Effect.gen(function* () {
        const commands = yield* Commands;
        const dom = yield* Dom;
        const report = yield* Report;
        const settings = yield* Settings;

        const calibration = yield* Ref.make(1);
        /** Increased on every keydown that is not a repeat: "this press". */
        const generation = yield* Ref.make(0);
        const heldCodes = yield* Ref.make(HashSet.empty<string>());
        /** The element that the user pressed last. */
        const pressed = yield* Ref.make(Option.none<Element>());
        const animations: Record<ScrollAxis, Ref.Ref<Option.Option<Animation>>> = {
          x: yield* Ref.make(Option.none<Animation>()),
          y: yield* Ref.make(Option.none<Animation>()),
        };
        // One handle per axis. `x` and `y` animate at the same time, and a new
        // scroll on one axis must not stop the other one.
        const fibers: Record<ScrollAxis, FiberHandle.FiberHandle<void>> = {
          x: yield* FiberHandle.make<void>(),
          y: yield* FiberHandle.make<void>(),
        };

        const rootElement = (): Element =>
          dom.document.scrollingElement ?? dom.document.documentElement;

        /** Move an element, and do not ask how far it went. */
        const shift =
          (axis: ScrollAxis, delta: number) =>
          (element: Element): Effect.Effect<void> =>
            Effect.sync(() => {
              applyOffset(element, axis, delta);
            });

        /**
         * Give a distance to the document instead of the element that refused
         * it. The document gets nothing when it is that element.
         */
        const handOff = (element: Element, axis: ScrollAxis, delta: number): Effect.Effect<void> =>
          pipe(
            rootElement(),
            Option.liftPredicate((root) => root !== element),
            Option.match({ onNone: () => Effect.void, onSome: shift(axis, delta) }),
          );

        /** What a page step measures: the viewport for the document, and the box of a container. */
        const pageSize = (element: Element, axis: ScrollAxis): number =>
          pipe(
            element === rootElement(),
            Boolean.match({
              onFalse: () => element[AXIS_PROPERTIES[axis].clientSize],
              onTrue: () => dom.window[AXIS_PROPERTIES[axis].viewport],
            }),
          );

        /**
         * Should this scroll be animated at all?
         *
         * `prefers-reduced-motion` is the user telling the platform that
         * animation makes the web unusable for them. A userscript that animates
         * anyway overrides an accessibility setting with a preference.
         */
        const animated = Effect.gen(function* () {
          const { smoothScroll } = settings.currentUnsafe();
          return yield* pipe(
            smoothScroll,
            Boolean.match({
              onFalse: () => Effect.succeed(false),
              onTrue: () =>
                pipe(
                  dom.probeOrElse(
                    () => dom.window.matchMedia("(prefers-reduced-motion: reduce)").matches,
                    constFalse,
                  ),
                  Effect.map(Boolean.not),
                ),
            }),
          );
        });

        /** The element that must absorb the scroll. */
        const target = (axis: ScrollAxis, direction: Direction): Effect.Effect<Element> =>
          pipe(
            Ref.get(pressed),
            Effect.flatMap((last) =>
              dom.probeOrElse(
                () =>
                  scrollTarget(
                    dom.window,
                    rootElement(),
                    walkStart(dom.document, last),
                    axis,
                    direction,
                  ),
                rootElement,
              ),
            ),
          );

        const cancel = (axis: ScrollAxis): Effect.Effect<void> =>
          pipe(
            animations[axis],
            Ref.set(Option.none<Animation>()),
            Effect.andThen(FiberHandle.clear(fibers[axis])),
          );

        const applyInstant = Effect.fn("Scroller.applyInstant")(function* (
          element: Element,
          axis: ScrollAxis,
          amount: number,
        ) {
          const motion = yield* Effect.sync(() => moveElement(element, axis, amount));
          yield* pipe(
            motion,
            Motion.$match({
              Moved: () => Effect.void,
              // The chosen element refused the scroll, so it lied about being
              // scrollable. Give the distance to the document instead.
              Refused: () => handOff(element, axis, amount),
            }),
          );
        });

        /**
         * The element refused the scroll of a frame. It is at the end of its
         * range, or it lied about being scrollable. Give the rest to the
         * document instead of stopping without a word, while the animation has
         * moved nothing yet. The animation ends either way.
         */
        const refused = Effect.fnUntraced(function* (
          axis: ScrollAxis,
          element: Element,
          delta: number,
        ) {
          const state = yield* Ref.get(animations[axis]);
          yield* pipe(
            state,
            Option.exists((animation) => animation.applied !== 0),
            Boolean.match({
              onFalse: () => handOff(element, axis, delta),
              onTrue: () => Effect.void,
            }),
          );
          yield* pipe(animations[axis], Ref.set(Option.none<Animation>()));
          return false;
        });

        /** The element moved. Count the distance, and decide what follows. */
        const settle = Effect.fnUntraced(function* (
          axis: ScrollAxis,
          rate: number,
          moved: number,
          progress: number,
        ) {
          const held = yield* Ref.get(heldCodes);
          const stepSize = settings.currentUnsafe().scrollStepSize;
          const outcome = yield* pipe(
            animations[axis],
            Ref.modify(onAnimation(settled({ rate, distance: moved, progress, held, stepSize }))),
          );
          const { running, rate: next } = pipe(
            outcome,
            Option.getOrElse((): Outcome => ({ running: false, rate })),
          );
          yield* pipe(calibration, Ref.set(next));
          return running;
        });

        /** Draw one frame, and answer whether the animation continues. */
        const draw = (axis: ScrollAxis, rate: number, frame: Frame): Effect.Effect<boolean> =>
          pipe(
            Effect.sync(() =>
              pipe(
                frame.delta,
                Option.match({
                  onNone: () => Motion.Moved({ distance: 0 }),
                  onSome: (delta) => moveElement(frame.element, axis, delta),
                }),
              ),
            ),
            Effect.flatMap(
              Motion.$match({
                Moved: ({ distance: moved }) => settle(axis, rate, moved, frame.progress),
                Refused: ({ delta }) => refused(axis, frame.element, delta),
              }),
            ),
          );

        /**
         * One step of the animation.
         *
         * It answers `true` while the animation continues. The state is read and
         * written in two indivisible sections, with the element write between
         * them, so a key repeat that arrives in the middle is not lost.
         */
        const step = Effect.fnUntraced(function* (axis: ScrollAxis, timestamp: number) {
          const rate = yield* Ref.get(calibration);
          const frame = yield* pipe(
            animations[axis],
            Ref.modify(onAnimation(timed(timestamp, rate))),
          );
          return yield* pipe(
            frame,
            Option.match({
              onNone: () => Effect.succeed(false),
              onSome: (next) => draw(axis, rate, next),
            }),
          );
        });

        /**
         * One step on every animation frame, until a step ends the animation.
         *
         * A recursion, and not `Effect.repeat`. A schedule yields to the
         * scheduler between two runs, which is a macrotask in Safari, and the
         * request for the next frame would wait behind it.
         */
        const loop = (axis: ScrollAxis): Effect.Effect<void> =>
          pipe(
            dom.nextFrame,
            Effect.flatMap((timestamp) => step(axis, timestamp)),
            Effect.flatMap(
              Boolean.match({
                onFalse: () => Effect.void,
                onTrue: () => loop(axis),
              }),
            ),
          );

        /** A defect in the animation leaves the page stuck. The user must know. */
        const animate = (axis: ScrollAxis): Effect.Effect<void> =>
          pipe(
            loop(axis),
            recoverUnlessInterrupted(
              "the scroll animation",
              report.error("Scrolling stopped after an internal failure"),
            ),
          );

        const start = Effect.fn("Scroller.start")(function* (
          element: Element,
          axis: ScrollAxis,
          amount: number,
          code: Option.Option<string>,
        ) {
          const press = yield* Ref.get(generation);
          const animation: Animation = {
            element,
            code,
            generation: press,
            amount,
            origin: 0,
            duration: durationFor(Math.abs(amount)),
            elapsed: 0,
            applied: 0,
            frames: 0,
            lastTimestamp: Option.none(),
          };
          yield* pipe(animations[axis], Ref.set(Option.some(animation)));
          // The first step happens here, inside the keystroke, and not on the
          // next frame. Nothing above suspends, so the page moves while the
          // browser is still dispatching the key. The fiber takes over only
          // when that step leaves distance to cover.
          const now = yield* dom.now;
          yield* pipe(animate(axis), FiberHandle.run(fibers[axis]), Effect.when(step(axis, now)));
        });

        /**
         * A second press while the first one still glides. Adding the
         * distance, instead of cancelling, is what makes three taps scroll
         * three steps whatever their timing. A cancel discarded what the first
         * press had not yet applied.
         */
        const join = Effect.fnUntraced(function* (
          axis: ScrollAxis,
          animation: Animation,
          amount: number,
          code: Option.Option<string>,
        ) {
          const press = yield* Ref.get(generation);
          const joined: Animation = pipe(
            animation,
            merged(amount),
            Struct.assign({
              code: pipe(
                code,
                Option.orElse(() => animation.code),
              ),
              generation: press,
            }),
          );
          yield* pipe(animations[axis], Ref.set(Option.some(joined)));
        });

        const glide = Effect.fnUntraced(function* (
          element: Element,
          axis: ScrollAxis,
          amount: number,
          code: Option.Option<string>,
        ) {
          const existing = yield* Ref.get(animations[axis]);
          yield* pipe(
            existing,
            Option.filter((animation) => animation.element === element),
            Option.match({
              onNone: () => start(element, axis, amount, code),
              onSome: (animation) => join(axis, animation, amount, code),
            }),
          );
        });

        const scrollElementBy = Effect.fn("Scroller.scrollElementBy")(function* (
          element: Element,
          axis: ScrollAxis,
          amount: number,
          event: Option.Option<KeyboardEvent>,
        ) {
          const smooth = yield* animated;
          const code = pipe(event, Option.flatMap(physicalKey));
          yield* pipe(
            smooth,
            Boolean.match({
              onFalse: () => applyInstant(element, axis, amount),
              onTrue: () => glide(element, axis, amount, code),
            }),
          );
        });

        /** Extend the running animation when this press already owns it. */
        const extendThisPress = Effect.fnUntraced(function* (axis: ScrollAxis, amount: number) {
          const press = yield* Ref.get(generation);
          return yield* pipe(animations[axis], Ref.modify(extendedBy(press, amount)));
        });

        /**
         * Scroll by a distance that is not zero.
         *
         * The animation of this press takes the distance when it runs. The
         * element is resolved only when it does not. The walk reads a computed
         * style at every step, and on the key-repeat path its result is thrown
         * away. That is waste at about 30 Hz.
         */
        const scrollDistance = (
          axis: ScrollAxis,
          amount: number,
          event: Option.Option<KeyboardEvent>,
          element: Effect.Effect<Element>,
        ): Effect.Effect<void> =>
          pipe(
            extendThisPress(axis, amount),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  pipe(
                    element,
                    Effect.flatMap((resolved) => scrollElementBy(resolved, axis, amount, event)),
                  ),
                onSome: () => Effect.void,
              }),
            ),
          );

        const scrollBy = Effect.fn("Scroller.scrollBy")(function* (
          axis: ScrollAxis,
          amount: number,
          event: Option.Option<KeyboardEvent>,
        ) {
          yield* pipe(
            amount,
            nonZero,
            Option.match({
              onNone: () => Effect.void,
              onSome: (moved) =>
                scrollDistance(
                  axis,
                  moved,
                  event,
                  Effect.suspend(() => target(axis, directionOf(moved))),
                ),
            }),
          );
        });

        const scrollByViewport = Effect.fn("Scroller.scrollByViewport")(function* (
          axis: ScrollAxis,
          fraction: number,
          event: Option.Option<KeyboardEvent>,
        ) {
          // One walk, and not two: `scrollBy` would resolve the same target
          // again.
          const element = yield* target(axis, directionOf(fraction));
          yield* pipe(
            Math.round(pageSize(element, axis) * fraction),
            nonZero,
            Option.match({
              onNone: () => Effect.void,
              onSome: (moved) => scrollDistance(axis, moved, event, Effect.succeed(element)),
            }),
          );
        });

        const scrollTo = Effect.fn("Scroller.scrollTo")(function* (
          axis: ScrollAxis,
          position: OffsetTarget,
        ) {
          const element = yield* target(axis, directionTo(position));
          const properties = AXIS_PROPERTIES[axis];
          const value = offsetFor(
            position,
            element[properties.scrollSize] - element[properties.clientSize],
          );
          yield* cancel(axis);
          yield* Effect.sync(() => {
            writeOffset(element, axis, value);
          });
        });

        const hold = (code: string): Effect.Effect<void> =>
          pipe(heldCodes, Ref.update(HashSet.add(code)));

        const release = (code: string): Effect.Effect<void> =>
          pipe(heldCodes, Ref.update(HashSet.remove(code)));

        /** A new press, and not a repeat: "this press" moves on, and its key is down. */
        const notePress = Effect.fnUntraced(function* (event: KeyboardEvent) {
          yield* pipe(
            generation,
            Ref.update((value) => value + 1),
          );
          yield* pipe(
            physicalKey(event),
            Option.match({ onNone: () => Effect.void, onSome: hold }),
          );
        });

        /** A key that the page made neither presses nor releases anything. */
        const noteKeydown = flow(
          Option.liftPredicate((event: KeyboardEvent) => isUserEvent(event) && !event.repeat),
          Option.match({ onNone: () => Effect.void, onSome: notePress }),
        );

        const noteKeyup = flow(
          Option.liftPredicate((event: KeyboardEvent) => isUserEvent(event)),
          Option.flatMap(physicalKey),
          Option.match({ onNone: () => Effect.void, onSome: release }),
        );

        // The press counter and the held keys follow every key of the user.
        // `Keyboard` cannot report them, because it never imports a feature,
        // so this service listens itself. These listeners are attached while
        // the application is built, and the key bridge only after that. On the
        // same target and in the same phase they therefore run first: a press
        // is counted before the command that it runs reads the counter, and a
        // release is seen before normal mode stops the event. Nothing here
        // suspends, because this is the key path.
        yield* dom.listen("window", "keydown", noteKeydown, { capture: true });
        yield* dom.listen("window", "keyup", noteKeyup, { capture: true });

        // A lost `keyup` — the window loses focus in the middle of a repeat —
        // would otherwise leave an animation running for ever.
        //
        // Bubble phase, and not capture: `blur` does not bubble, so a capturing
        // `window` listener ran for *every element blur on the page*. That is
        // thousands of calls on a form-heavy site, to answer a question that only
        // the blur of the window can answer.
        yield* dom.listen("window", "blur", () =>
          pipe(heldCodes, Ref.set(HashSet.empty<string>())),
        );

        // Capture phase, so that a page that stops the press still tells us
        // where it was. A press from a script counts too: a hint that clicks
        // into a pane must aim the next scroll at that pane.
        yield* dom.listen(
          "window",
          "pointerdown",
          (event) =>
            pipe(
              dom.probeOrElse(() => pressedElement(event), Option.none),
              Effect.flatMap((element) => pipe(pressed, Ref.set(element))),
            ),
          { capture: true, passive: true },
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
        });

        const configuredStep = (): number => settings.currentUnsafe().scrollStepSize;

        yield* commands.registerAll({
          scrollDown: ({ count, event }) => service.scrollBy("y", configuredStep() * count, event),
          scrollUp: ({ count, event }) => service.scrollBy("y", -configuredStep() * count, event),
          scrollLeft: ({ count, event }) => service.scrollBy("x", -configuredStep() * count, event),
          scrollRight: ({ count, event }) => service.scrollBy("x", configuredStep() * count, event),
          scrollPageDown: ({ count, event }) => service.scrollByViewport("y", 0.5 * count, event),
          scrollPageUp: ({ count, event }) => service.scrollByViewport("y", -0.5 * count, event),
          scrollFullPageDown: ({ count, event }) => service.scrollByViewport("y", 1 * count, event),
          scrollFullPageUp: ({ count, event }) => service.scrollByViewport("y", -1 * count, event),
          scrollToTop: () => service.scrollTo("y", "start"),
          scrollToBottom: () => service.scrollTo("y", "end"),
          scrollToLeft: () => service.scrollTo("x", "start"),
          scrollToRight: () => service.scrollTo("x", "end"),
        });

        return service;
      }),
    );
}
