/**
 * The scroller, over a fake document.
 *
 * A unit test here runs in Node, where there is no DOM at all, so the whole
 * document is a small model: an element clamps its own offsets, and the fake
 * engine writes `scrollLeft` the way that a real engine writes it. That is
 * enough to press the four decisions that the service makes — which container
 * absorbs a command, how much of the command each container takes, how a
 * right-to-left container reports its offsets, and what a page-sized command
 * measures.
 *
 * The animation is driven by the `TestClock`. `Dom.nextFrame` sleeps for one
 * frame, so `TestClock.adjust` runs exactly the frames that the test asks for.
 * Nothing waits for real time.
 */

import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Commands } from "~/core/Commands.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import {
  defaultSettings,
  type Settings as SettingsData,
} from "~/domain/Persisted.ts";
import {
  detectRtlScrollModel,
  type RtlScrollModel,
  Scroller,
} from "~/features/Scroller.ts";
import { Dom } from "~/platform/Dom.ts";

// ---------------------------------------------------------------------------
// A document, in miniature
// ---------------------------------------------------------------------------

const FRAME_MS = 16;

interface ElementOptions {
  readonly name: string;
  readonly scrollHeight?: number;
  readonly clientHeight?: number;
  readonly scrollWidth?: number;
  readonly clientWidth?: number;
  readonly overflowX?: string;
  readonly overflowY?: string;
  readonly direction?: "ltr" | "rtl";
  readonly parent?: FakeElement | null;
  /** How this fake engine writes `scrollLeft` in a right-to-left container. */
  readonly model?: RtlScrollModel;
  /** The offset that the container starts at, in raw engine units. */
  readonly startLeft?: number;
  readonly startTop?: number;
}

/**
 * One scroll container.
 *
 * The clamp is the whole point. A real container refuses a write that goes
 * past its range, and every decision under test reads the value back.
 */
class FakeElement {
  readonly name: string;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly overflowX: string;
  readonly overflowY: string;
  readonly direction: "ltr" | "rtl";
  readonly model: RtlScrollModel;
  readonly shadowRoot: null = null;
  parentElement: FakeElement | null;
  #top: number;
  #left: number;

  constructor(options: ElementOptions) {
    this.name = options.name;
    this.scrollHeight = options.scrollHeight ?? 100;
    this.clientHeight = options.clientHeight ?? 100;
    this.scrollWidth = options.scrollWidth ?? 100;
    this.clientWidth = options.clientWidth ?? 100;
    this.overflowX = options.overflowX ?? "auto";
    this.overflowY = options.overflowY ?? "auto";
    this.direction = options.direction ?? "ltr";
    this.model = options.model ?? "negative";
    this.parentElement = options.parent ?? null;
    this.#top = options.startTop ?? 0;
    this.#left = options.startLeft ?? 0;
  }

  get maxTop(): number {
    return Math.max(0, this.scrollHeight - this.clientHeight);
  }

  get maxLeft(): number {
    return Math.max(0, this.scrollWidth - this.clientWidth);
  }

  /** The lowest `scrollLeft` that this engine accepts on this element. */
  get lowestLeft(): number {
    return this.direction === "rtl" && this.model === "negative"
      ? -this.maxLeft
      : 0;
  }

  get highestLeft(): number {
    return this.direction === "rtl" && this.model === "negative"
      ? 0
      : this.maxLeft;
  }

  get scrollTop(): number {
    return this.#top;
  }

  set scrollTop(value: number) {
    this.#top = Math.min(Math.max(value, 0), this.maxTop);
  }

  get scrollLeft(): number {
    return this.#left;
  }

  set scrollLeft(value: number) {
    this.#left = Math.min(Math.max(value, this.lowestLeft), this.highestLeft);
  }

  scrollTo(options: { left: number; top: number }): void {
    this.scrollLeft = options.left;
    this.scrollTop = options.top;
  }

  /** The probe of the model detection is appended to the body. */
  appendChild(): void {}

  getRootNode(): unknown {
    return null;
  }
}

const asElement = (element: FakeElement): Element =>
  element as unknown as Element;

/** The probe element that `detectRtlScrollModel` makes. */
class FakeProbe {
  readonly model: RtlScrollModel;
  attached = false;
  removed = false;
  #left: number;

  constructor(model: RtlScrollModel) {
    this.model = model;
    // A right-to-left container starts at its right edge, which is `max` under
    // the non-negative model and zero under the negative one.
    this.#left = model === "nonNegative" ? 36 : 0;
  }

  get scrollLeft(): number {
    return this.#left;
  }

  set scrollLeft(value: number) {
    const lowest = this.model === "negative" ? -36 : 0;
    const highest = this.model === "negative" ? 0 : 36;
    this.#left = Math.min(Math.max(value, lowest), highest);
  }

  setAttribute(): void {}
  appendChild(): void {}
  remove(): void {
    this.removed = true;
  }
}

interface WorldOptions {
  readonly innerHeight?: number;
  readonly innerWidth?: number;
  readonly visualViewport?: { width: number; height: number } | null;
  /** Reading `visualViewport` throws, as a poisoned realm would. */
  readonly poisonVisualViewport?: boolean;
  readonly model?: RtlScrollModel;
}

interface World {
  readonly root: FakeElement;
  readonly document: Document;
  readonly window: Window & typeof globalThis;
  readonly probes: FakeProbe[];
  focus(element: FakeElement | null): void;
  make(options: ElementOptions): FakeElement;
}

const makeWorld = (options: WorldOptions = {}): World => {
  const model = options.model ?? "negative";
  const root = new FakeElement({
    name: "root",
    scrollHeight: 10_000,
    clientHeight: 800,
    scrollWidth: 10_000,
    clientWidth: 1000,
    model,
  });
  const probes: FakeProbe[] = [];
  let active: FakeElement | null = null;

  const document = {
    get scrollingElement(): Element {
      return asElement(root);
    },
    get documentElement(): Element {
      return asElement(root);
    },
    get body(): Element {
      return asElement(root);
    },
    get activeElement(): Element | null {
      return active === null ? null : asElement(active);
    },
    createElement: (): unknown => {
      const probe = new FakeProbe(model);
      probes.push(probe);
      return probe;
    },
  } as unknown as Document;

  const window = {
    innerHeight: options.innerHeight ?? 800,
    innerWidth: options.innerWidth ?? 1000,
    get visualViewport(): unknown {
      if (options.poisonVisualViewport === true) {
        throw new TypeError("visualViewport is not readable here");
      }
      return options.visualViewport ?? null;
    },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: (element: unknown): unknown => {
      const value = element as FakeElement;
      return {
        overflowX: value.overflowX,
        overflowY: value.overflowY,
        direction: value.direction,
      };
    },
  } as unknown as Window & typeof globalThis;

  return {
    root,
    document,
    window,
    probes,
    focus: (element) => {
      active = element;
    },
    make: (elementOptions) =>
      new FakeElement({ model, parent: root, ...elementOptions }),
  };
};

// ---------------------------------------------------------------------------
// The layers
// ---------------------------------------------------------------------------

/**
 * `Dom`, over the fake world.
 *
 * `nextFrame` sleeps, so the `TestClock` decides when a frame happens.
 */
const domOf = (world: World): Layer.Layer<Dom> =>
  Layer.sync(Dom, () =>
    Dom.of({
      window: world.window,
      document: world.document,
      href: Effect.succeed("https://example.test/"),
      probe: (_api, read) => Effect.sync(read) as never,
      probeOr: <A>(read: () => A, fallback: A) =>
        Effect.sync(() => {
          try {
            return read();
          } catch {
            return fallback;
          }
        }),
      attempt: (_api, run) => Effect.sync(run) as never,
      listen: (() => Effect.void) as unknown as Dom["Service"]["listen"],
      listenOn: (() => Effect.void) as unknown as Dom["Service"]["listenOn"],
      events: (() => Stream.empty) as unknown as Dom["Service"]["events"],
      nextFrame: Effect.andThen(
        Effect.sleep(`${FRAME_MS} millis`),
        Clock.currentTimeMillis,
      ),
      yieldToBrowser: Effect.void,
      now: Clock.currentTimeMillis,
    }));

const settingsOf = (patch: Partial<SettingsData>): Layer.Layer<Settings> =>
  Layer.sync(Settings, () => {
    const data: SettingsData = { ...defaultSettings(), ...patch };
    return Settings.of({
      current: Effect.succeed(data),
      currentUnsafe: () => data,
      changes: Stream.make(data),
      save: (next) => Effect.succeed(next),
      patch: (change) => Effect.succeed(change(data)),
      reload: Effect.succeed(data),
    });
  });

const scrollerOf = (
  world: World,
  patch: Partial<SettingsData> = {},
): Layer.Layer<Scroller> =>
  Scroller.layer.pipe(
    Layer.provide(Layer.mergeAll(
      domOf(world),
      Commands.layer,
      Report.layer,
      settingsOf(patch),
    )),
  );

/** Run `body` with a scroller over `world`. */
const withScroller = (
  world: World,
  patch: Partial<SettingsData>,
  body: (scroller: Scroller["Service"]) => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.provide(
    Effect.flatMap(Scroller, body),
    scrollerOf(world, patch),
  );

// ---------------------------------------------------------------------------
// The scroll chain
// ---------------------------------------------------------------------------

/** Let the animation run to its end. */
const settle = TestClock.adjust("2 seconds");

describe("the scroll chain", () => {
  /** An inner container with ten pixels left, inside a tall document. */
  const nearlyExhausted = (): { world: World; inner: FakeElement } => {
    const world = makeWorld();
    const inner = world.make({
      name: "inner",
      scrollHeight: 1000,
      clientHeight: 200,
      startTop: 790,
    });
    return { world, inner };
  };

  it.effect("gives the rest of a step to the ancestor, with no animation", () =>
    Effect.gen(function*() {
      const { world, inner } = nearlyExhausted();
      world.focus(inner);

      yield* withScroller(
        world,
        { smoothScroll: false },
        (scroller) => scroller.scrollBy("y", 60, Option.none()),
      );

      // Ten pixels of room, sixty of command. The other fifty used to be
      // thrown away.
      assert.strictEqual(inner.scrollTop, 800);
      assert.strictEqual(world.root.scrollTop, 50);
    }));

  it.effect("gives the rest of a step to the ancestor, while it animates", () =>
    Effect.gen(function*() {
      const { world, inner } = nearlyExhausted();
      world.focus(inner);

      yield* withScroller(
        world,
        { smoothScroll: true },
        (scroller) =>
          Effect.gen(function*() {
            yield* scroller.scrollBy("y", 60, Option.none());
            yield* settle;
          }),
      );

      assert.strictEqual(inner.scrollTop, 800);
      assert.strictEqual(world.root.scrollTop, 50);
    }));

  it.effect("keeps the whole step in a container that has the room", () =>
    Effect.gen(function*() {
      const world = makeWorld();
      const inner = world.make({
        name: "inner",
        scrollHeight: 1000,
        clientHeight: 200,
      });
      world.focus(inner);

      yield* withScroller(
        world,
        { smoothScroll: false },
        (scroller) => scroller.scrollBy("y", 60, Option.none()),
      );

      assert.strictEqual(inner.scrollTop, 60);
      assert.strictEqual(world.root.scrollTop, 0);
    }));
});

// ---------------------------------------------------------------------------
// Right-to-left containers
// ---------------------------------------------------------------------------

describe("the right-to-left model", () => {
  it("reads the negative model from the probe", () => {
    const world = makeWorld({ model: "negative" });
    assert.strictEqual(detectRtlScrollModel(world.document), "negative");
    // The outer probe and the wide child inside it.
    assert.strictEqual(world.probes.length, 2);
    assert.isTrue(world.probes[0]?.removed, "the probe must leave no trace");
  });

  it("reads the non-negative model from the probe", () => {
    const world = makeWorld({ model: "nonNegative" });
    assert.strictEqual(detectRtlScrollModel(world.document), "nonNegative");
  });

  /** A right-to-left container at its start, which is its right edge. */
  const rtlWorld = (): {
    world: World;
    middle: FakeElement;
    inner: FakeElement;
  } => {
    const world = makeWorld({ model: "negative" });
    const middle = world.make({
      name: "middle",
      scrollWidth: 2000,
      clientWidth: 400,
      direction: "rtl",
      startLeft: 0,
    });
    const inner = world.make({
      name: "inner",
      parent: middle,
      scrollWidth: 1000,
      clientWidth: 300,
      direction: "rtl",
      startLeft: 0,
    });
    return { world, middle, inner };
  };

  it.effect("scrolls a right-to-left container to the left", () =>
    Effect.gen(function*() {
      const { world, inner } = rtlWorld();
      world.focus(inner);

      yield* withScroller(
        world,
        { smoothScroll: false },
        (scroller) => scroller.scrollBy("x", -60, Option.none()),
      );

      // Raw `-60` is 60 pixels left of the right edge. Without the
      // normalisation the room check said "no room to the left" for every
      // right-to-left container, and the command went to the document.
      assert.strictEqual(inner.scrollLeft, -60);
      assert.strictEqual(world.root.scrollLeft, 0);
    }));

  it.effect("passes a right command on when the container is at its end", () =>
    Effect.gen(function*() {
      const { world, middle, inner } = rtlWorld();
      // Both containers sit at their right edge, so neither has room to the
      // right. The middle one is scrolled left, so it does have room.
      middle.scrollLeft = -500;
      world.focus(inner);

      yield* withScroller(
        world,
        { smoothScroll: false },
        (scroller) => scroller.scrollBy("x", 60, Option.none()),
      );

      assert.strictEqual(inner.scrollLeft, 0);
      assert.strictEqual(middle.scrollLeft, -440);
      assert.strictEqual(world.root.scrollLeft, 0);
    }));

  it.effect("sends `scrollToLeft` to the left edge, not the right one", () =>
    Effect.gen(function*() {
      const { world, inner } = rtlWorld();
      world.focus(inner);

      yield* withScroller(
        world,
        { smoothScroll: false },
        (scroller) => scroller.scrollTo("x", "start"),
      );

      // The left edge of this container is raw `-700`. A write of zero is the
      // right edge, which is where it already was.
      assert.strictEqual(inner.scrollLeft, -700);
    }));

  it.effect("leaves a left-to-right container alone", () =>
    Effect.gen(function*() {
      const world = makeWorld({ model: "negative" });
      const inner = world.make({
        name: "inner",
        scrollWidth: 1000,
        clientWidth: 300,
      });
      world.focus(inner);

      yield* withScroller(
        world,
        { smoothScroll: false },
        (scroller) => scroller.scrollTo("x", "end"),
      );

      assert.strictEqual(inner.scrollLeft, 700);
    }));
});

// ---------------------------------------------------------------------------
// A guard on the fake itself
// ---------------------------------------------------------------------------

describe("the fake engine", () => {
  it("clamps a right-to-left container to the negative range", () => {
    const world = makeWorld({ model: "negative" });
    const element = world.make({
      name: "rtl",
      scrollWidth: 1000,
      clientWidth: 300,
      direction: "rtl",
    });

    element.scrollLeft = 50;
    assert.strictEqual(element.scrollLeft, 0);
    element.scrollLeft = -5000;
    assert.strictEqual(element.scrollLeft, -700);
  });
});
