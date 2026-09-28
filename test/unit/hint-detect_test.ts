/**
 * The two parts of `features/hints/Detect.ts` that a page can break.
 *
 * A unit test runs in Node with no DOM, so both parts take the tree as an
 * argument. The fake nodes below give only what the code under test reads.
 *
 * 1. **The image-map lookup.** The name in a `usemap` attribute belongs to the
 *    page. It can hold a quotation mark, a backslash, a bracket or an emoji. A
 *    selector that is built by joining strings then throws, and the throw used
 *    to stop the hints of the whole page. The fake document therefore throws
 *    from `querySelector`: the lookup must never build a selector at all.
 * 2. **The walk of the tree.** Discovery walks the document in time-boxed
 *    slices, so the user can interrupt it. The order must stay the order of
 *    the recursive walk that used `querySelectorAll`, which the reference
 *    below repeats.
 */

import { assert, describe, it } from "@effect/vitest";
import {
  Array,
  Boolean,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  MutableRef,
  Option,
  Record,
  Ref,
  Struct,
  pipe,
} from "effect";
import { constVoid } from "effect/Function";
import { Dom } from "~/platform/Dom.ts";
import {
  type ElementWalk,
  collectElements,
  findImageMap,
  mapNameOf,
  startWalk,
  stepWalk,
} from "~/features/hints/Detect.ts";

// ---------------------------------------------------------------------------
// Image maps
// ---------------------------------------------------------------------------

/** A `<map>` that answers the two attributes used by the standard. */
interface FakeMap {
  readonly getAttribute: (attribute: string) => string | null;
}

/** A document or shadow root, as the lookup reads it. */
interface FakeMapRoot {
  readonly querySelectorAll: (selector: string) => ReadonlyArray<FakeMap>;
}

const mapElement = (name: string | null, id: string | null = null): FakeMap => {
  const attributes: Record.ReadonlyRecord<string, string | null> = { name, id };
  return {
    getAttribute: (attribute) =>
      pipe(
        attributes,
        Record.get(attribute),
        Option.flatMap(Option.fromNullishOr),
        Option.getOrNull,
      ),
  };
};

/**
 * A document or shadow root that accepts only the fixed `map` selector.
 *
 * Any other selector throws a `SyntaxError`, as the DOM does for a selector
 * that page text breaks.
 */
const rootWith = (maps: ReadonlyArray<FakeMap>): FakeMapRoot => ({
  querySelectorAll: (selector) =>
    pipe(
      selector,
      Option.liftPredicate((built) => built === "map"),
      Option.as(maps),
      Option.getOrThrowWith(() => new SyntaxError(`the lookup built a selector: ${selector}`)),
    ),
});

/** An image context inside `root`, with its owning document. */
const contextIn = (root: FakeMapRoot, ownerDocument: FakeMapRoot = root) => ({
  ownerDocument,
  getRootNode: (): FakeMapRoot => root,
});

/** The map that the lookup found, or `null`. */
const found = (context: ReturnType<typeof contextIn>, usemap: string): unknown =>
  pipe(findImageMap(context, usemap), Option.getOrNull);

/** Names that a page may use, and that a joined selector cannot carry. */
const AWKWARD_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["a quotation mark", 'na"v'],
  ["a backslash", "na\\v"],
  ["a trailing backslash", "nav\\"],
  ["a space", "main nav"],
  ["a bracket", "nav[0]"],
  ["a brace", "nav{x}"],
  ["a colon", "nav:hover"],
  ["a comma", "nav,other"],
  ["an emoji", "🗺️nav"],
  ["a newline", "na\nv"],
  ["a digit at the start", "0nav"],
];

describe("the image-map lookup", () => {
  it.effect.each(AWKWARD_NAMES)("finds the map whose name holds %s", ([, name]) =>
    Effect.sync(() => {
      const target = mapElement(name);
      const context = contextIn(rootWith([mapElement("other"), target]));

      const map = findImageMap(context, `#${name}`);

      assert.isTrue(Option.isSome(map), `no map for ${JSON.stringify(name)}`);
      assert.strictEqual(Option.getOrNull(map), target);
    }),
  );

  it.effect("gives no map for an empty name", () =>
    Effect.sync(() => {
      const context = contextIn(rootWith([mapElement(""), mapElement("nav")]));
      // The image then gets no hint of its own, and every other element on the
      // page keeps its hint.
      assert.isTrue(Option.isNone(findImageMap(context, "#")));
      assert.isTrue(Option.isNone(findImageMap(context, "")));
      assert.isTrue(Option.isNone(mapNameOf("#")));
      assert.isTrue(Option.isNone(mapNameOf("")));
    }),
  );

  it.effect("takes the first map when the name is on the page two times", () =>
    Effect.sync(() => {
      const first = mapElement("nav");
      const second = mapElement("nav");
      const context = contextIn(rootWith([first, second]));

      assert.strictEqual(found(context, "#nav"), first);
    }),
  );

  it.effect("gives no map for a name that is not on the page", () =>
    Effect.sync(() => {
      const context = contextIn(rootWith([mapElement("nav")]));
      assert.isTrue(Option.isNone(findImageMap(context, "#missing")));
    }),
  );

  it.effect("compares the name exactly", () =>
    Effect.sync(() => {
      const context = contextIn(rootWith([mapElement("nav")]));
      assert.isTrue(Option.isNone(findImageMap(context, "#NAV")));
      assert.isTrue(Option.isNone(findImageMap(context, "#nav ")));
      assert.isTrue(Option.isNone(findImageMap(context, "nav")));
      assert.strictEqual(Option.getOrNull(mapNameOf("#nav")), "nav");
    }),
  );

  it.effect("keeps a name that already holds a hash", () =>
    Effect.sync(() => {
      const target = mapElement("#nav");
      const context = contextIn(rootWith([mapElement("nav"), target]));
      // Only the first `#` is the separator, as `usemap` defines it.
      assert.strictEqual(found(context, "##nav"), target);
    }),
  );

  it.effect("uses the text after the first hash", () =>
    Effect.sync(() => {
      const target = mapElement("nav");
      const context = contextIn(rootWith([target]));
      assert.strictEqual(found(context, "prefix#nav"), target);
    }),
  );

  it.effect("matches an id when a map has no name", () =>
    Effect.sync(() => {
      const target = mapElement(null, "nav");
      const context = contextIn(rootWith([target]));
      assert.strictEqual(found(context, "#nav"), target);
    }),
  );

  it.effect("searches only the image context tree", () =>
    Effect.sync(() => {
      const documentMap = mapElement("nav");
      const shadowMap = mapElement("nav");
      const documentRoot = rootWith([documentMap]);
      const documentContext = contextIn(documentRoot);
      const shadowContext = contextIn(rootWith([shadowMap]), documentRoot);
      const emptyShadowContext = contextIn(rootWith([]), documentRoot);

      assert.strictEqual(found(shadowContext, "#nav"), shadowMap);
      assert.strictEqual(found(documentContext, "#nav"), documentMap);
      assert.isTrue(Option.isNone(findImageMap(emptyShadowContext, "#nav")));
    }),
  );
});

// ---------------------------------------------------------------------------
// A fake tree
// ---------------------------------------------------------------------------

/**
 * A node that answers what the walk reads: the sibling pointers, the shadow
 * root, and what the closed-host heuristic needs.
 */
interface FakeNode {
  readonly localName: string;
  readonly children: FakeNode[];
  readonly childNodes: ReadonlyArray<unknown>;
  shadowRoot: FakeRoot | null;
  parent: FakeParent | null;
  index: number;
  readonly firstElementChild: FakeNode | null;
  readonly lastElementChild: FakeNode | null;
  readonly nextElementSibling: FakeNode | null;
  readonly previousElementSibling: FakeNode | null;
  readonly getBoundingClientRect: () => { width: number; height: number };
}

interface FakeRoot {
  readonly children: FakeNode[];
  readonly firstElementChild: FakeNode | null;
  readonly lastElementChild: FakeNode | null;
}

type FakeParent = FakeNode | FakeRoot;

/** The fake DOM counts from a synchronous getter, so it keeps plain mutable counters. */
const nextId = MutableRef.make(0);
const siblingReads = MutableRef.make(0);

const firstOf = (parent: FakeParent): FakeNode | null =>
  pipe(parent.children, Array.head, Option.getOrNull);

const lastOf = (parent: FakeParent): FakeNode | null =>
  pipe(parent.children, Array.last, Option.getOrNull);

/** The sibling at `offset` from `self`, and one sibling read more. */
const siblingOf = (self: FakeNode, offset: number): FakeNode | null => {
  MutableRef.increment(siblingReads);
  return pipe(
    self.parent,
    Option.fromNullishOr,
    Option.flatMap((parent) => pipe(parent.children, Array.get(self.index + offset))),
    Option.getOrNull,
  );
};

const node = (localName = "div"): FakeNode => {
  const id = MutableRef.incrementAndGet(nextId);
  const self: FakeNode = {
    localName,
    children: [],
    childNodes: [],
    shadowRoot: null,
    parent: null,
    index: 0,
    get firstElementChild(): FakeNode | null {
      return firstOf(self);
    },
    get lastElementChild(): FakeNode | null {
      return lastOf(self);
    },
    get nextElementSibling(): FakeNode | null {
      return siblingOf(self, 1);
    },
    get previousElementSibling(): FakeNode | null {
      return siblingOf(self, -1);
    },
    // A box, so that a childless custom element counts as a closed host.
    getBoundingClientRect: () => ({ width: 10 + (id % 3), height: 10 }),
  };
  return self;
};

const root = (): FakeRoot => {
  const self: FakeRoot = {
    children: [],
    get firstElementChild(): FakeNode | null {
      return firstOf(self);
    },
    get lastElementChild(): FakeNode | null {
      return lastOf(self);
    },
  };
  return self;
};

/** Put `child` last under `parent`, and link it to its siblings. */
const append = (parent: FakeParent, child: FakeNode): void => {
  child.parent = parent;
  child.index = parent.children.length;
  parent.children.push(child);
};

/** Remove `child` and repair the sibling indexes. */
const remove = (child: FakeNode): void =>
  pipe(
    child.parent,
    Option.fromNullishOr,
    Option.match({
      onNone: constVoid,
      onSome: (parent) => {
        parent.children.splice(child.index, 1);
        pipe(
          parent.children,
          Array.forEach((sibling, index) => {
            sibling.index = index;
          }),
        );
        child.parent = null;
        child.index = 0;
      },
    }),
  );

/** Move `child` to the end of `parent`. */
const move = (child: FakeNode, parent: FakeParent): void => {
  remove(child);
  append(parent, child);
};

/** Every descendant of `where`, in document order, as `querySelectorAll` gives. */
const descendants = (where: FakeParent): ReadonlyArray<FakeNode> =>
  pipe(
    where.children,
    Array.flatMap((child) => pipe(descendants(child), Array.prepend(child))),
  );

interface Walked {
  readonly elements: ReadonlyArray<FakeNode>;
  readonly unreachableHosts: number;
}

/** The heuristic of `looksLikeClosedShadowHost`, over the fake node. */
const looksClosed = (element: FakeNode): boolean =>
  element.shadowRoot === null &&
  element.localName.includes("-") &&
  element.childNodes.length === 0 &&
  element.getBoundingClientRect().width >= 3 &&
  element.getBoundingClientRect().height >= 3;

/**
 * The walk that this change replaces, copied from the file before the change.
 *
 * It is the reference for the order. The chunked walk must agree with it, node
 * for node, and it must count the same unreachable hosts.
 */
const referenceWalk = (where: FakeParent): Walked => {
  const visits = pipe(descendants(where), Array.map(referenceVisit));
  return {
    elements: pipe(
      visits,
      Array.flatMap((visit) => visit.elements),
    ),
    unreachableHosts: pipe(
      visits,
      Array.reduce(0, (sum, visit) => sum + visit.unreachableHosts),
    ),
  };
};

/** One element of the reference walk, followed by its shadow tree. */
const referenceVisit = (element: FakeNode): Walked =>
  pipe(
    element.shadowRoot,
    Option.fromNullishOr,
    Option.match({
      onNone: () => ({
        elements: [element],
        unreachableHosts: pipe(
          looksClosed(element),
          Boolean.match({ onFalse: () => 0, onTrue: () => 1 }),
        ),
      }),
      onSome: (shadow) => {
        const inner = referenceWalk(shadow);
        return {
          elements: pipe(inner.elements, Array.prepend(element)),
          unreachableHosts: inner.unreachableHosts,
        };
      },
    }),
  );

/** Every fifth element of a level is a web component. */
const nameAt = (index: number): string =>
  pipe(index % 5 === 0, Boolean.match({ onFalse: () => "div", onTrue: () => "x-widget" }));

/**
 * A tree with `breadth` branches, `depth` levels, shadow roots and web
 * components.
 *
 * The shape is deterministic, so a failure names one node and not a random
 * one.
 */
const buildTree = (breadth: number, depth: number): FakeRoot => {
  /** `parent`, after it grew `level` levels below it. */
  const grown = <P extends FakeParent>(parent: P, level: number): P => {
    pipe(
      level > 0,
      Boolean.match({
        onFalse: constVoid,
        onTrue: () =>
          pipe(
            breadth,
            Array.makeBy((index) => index),
            Array.forEach(branch(parent, level)),
          ),
      }),
    );
    return parent;
  };
  /** The child at `index` of `parent`, grown one level less. */
  const branch =
    (parent: FakeParent, level: number) =>
    (index: number): void => {
      const child = node(nameAt(index));
      append(parent, child);
      // Every third element carries an open shadow root with content of its
      // own, so the two walks must agree about where a shadow tree belongs.
      child.shadowRoot = pipe(
        index % 3 === 0 && level > 1,
        Boolean.match({ onFalse: () => null, onTrue: () => grown(root(), level - 1) }),
      );
      grown(child, level - 1);
    };
  return grown(root(), depth);
};

/** Step `walk` by `slice` until no work is left. */
const drain = (walk: ElementWalk<FakeNode>, slice: number): Effect.Effect<void> =>
  pipe(
    Effect.sync(() => stepWalk(walk, slice)),
    Effect.flatMap(Boolean.match({ onFalse: () => Effect.void, onTrue: () => drain(walk, slice) })),
  );

const walkAll = (tree: FakeRoot, slice: number): Effect.Effect<Walked> => {
  const walk = startWalk(tree);
  return pipe(drain(walk, slice), Effect.as(walk));
};

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

describe("the walk of the tree", () => {
  it.effect("finds the same elements, in the same order, as the walk before", () =>
    Effect.gen(function* () {
      const tree = buildTree(6, 5);
      const reference = referenceWalk(tree);

      const chunked = yield* walkAll(tree, 7);

      assert.isAbove(reference.elements.length, 4_000);
      assert.strictEqual(chunked.elements.length, reference.elements.length);
      pipe(
        reference.elements,
        Array.forEach((element, index) => {
          const walked = pipe(chunked.elements, Array.get(index), Option.getOrNull);
          assert.strictEqual(
            walked,
            element,
            `element ${index} is not the element of the walk before`,
          );
        }),
      );
      assert.strictEqual(chunked.unreachableHosts, reference.unreachableHosts);
      assert.isAbove(reference.unreachableHosts, 0);
    }),
  );

  it.effect("gives the same order for every slice size", () =>
    Effect.gen(function* () {
      const tree = buildTree(5, 5);
      const one = yield* walkAll(tree, 1);
      const seven = yield* walkAll(tree, 7);
      const whole = yield* walkAll(tree, 5_000);

      assert.deepStrictEqual(one.elements, seven.elements);
      assert.deepStrictEqual(one.elements, whole.elements);
      assert.strictEqual(one.unreachableHosts, whole.unreachableHosts);
    }),
  );

  it.effect("visits the host, then its shadow tree, then its light tree", () =>
    Effect.gen(function* () {
      const host = node("x-host");
      const light = node("div");
      const shadowChild = node("span");
      append(host, light);
      const shadow = root();
      append(shadow, shadowChild);
      host.shadowRoot = shadow;
      const tree = root();
      append(tree, host);

      const walked = yield* walkAll(tree, 1);

      assert.deepStrictEqual(walked.elements, [host, shadowChild, light]);
    }),
  );

  it.effect("gives false as soon as no element is left", () =>
    Effect.sync(() => {
      const tree = root();
      append(tree, node());
      append(tree, node());
      const walk = startWalk(tree);
      assert.isTrue(stepWalk(walk, 1));
      assert.isFalse(stepWalk(walk, 1));
      assert.isFalse(stepWalk(walk, 1));
      assert.strictEqual(walk.elements.length, 2);
    }),
  );

  it.effect("walks an empty root", () =>
    Effect.sync(() => {
      const walk = startWalk(root());
      assert.isFalse(stepWalk(walk, 32));
      assert.strictEqual(walk.elements.length, 0);
    }),
  );

  it.effect("bounds sibling reads in one step", () =>
    Effect.sync(() => {
      const tree = root();
      pipe(
        Array.makeBy(10_000, () => node()),
        Array.forEach((child) => append(tree, child)),
      );
      MutableRef.set(siblingReads, 0);

      const walk = startWalk(tree);
      assert.isTrue(stepWalk(walk, 7));

      assert.strictEqual(walk.elements.length, 7);
      assert.isAtMost(MutableRef.get(siblingReads), 7);
    }),
  );

  it.effect("excludes a child appended after its parent was visited", () =>
    Effect.sync(() => {
      const parent = node();
      const tree = root();
      append(tree, parent);
      const walk = startWalk(tree);
      assert.isFalse(stepWalk(walk, 1));

      const added = node();
      append(parent, added);

      assert.isFalse(stepWalk(walk, 10));
      assert.deepStrictEqual(walk.elements, [parent]);
    }),
  );

  it.effect("includes a child added before its parent is visited", () =>
    Effect.gen(function* () {
      const parent = node();
      const future = node();
      append(parent, future);
      const tree = root();
      append(tree, parent);
      const walk = startWalk(tree);
      assert.isTrue(stepWalk(walk, 1));

      const added = node();
      append(future, added);
      yield* drain(walk, 1);

      assert.deepStrictEqual(walk.elements, [parent, future, added]);
    }),
  );

  it.effect("keeps a pending element that the page removes", () =>
    Effect.gen(function* () {
      const first = node();
      const removed = node();
      const tree = root();
      append(tree, first);
      append(tree, removed);
      const walk = startWalk(tree);
      assert.isTrue(stepWalk(walk, 1));

      remove(removed);
      yield* drain(walk, 1);

      assert.deepStrictEqual(walk.elements, [first, removed]);
    }),
  );

  it.effect("does not produce a moved element two times", () =>
    Effect.gen(function* () {
      const first = node();
      const second = node();
      const tree = root();
      append(tree, first);
      append(tree, second);
      const walk = startWalk(tree);
      assert.isTrue(stepWalk(walk, 1));

      move(first, second);
      yield* drain(walk, 1);

      assert.deepStrictEqual(walk.elements, [first, second]);
    }),
  );

  it.effect("stops continuous growth at the element limit", () =>
    Effect.sync(() => {
      const first = node();
      const future = node();
      append(first, future);
      const tree = root();
      append(tree, first);
      const walk = startWalk(tree, 12);
      assert.isTrue(stepWalk(walk, 1));

      // The page appends one more child below the last one after every step.
      const grow = (below: FakeNode): void =>
        pipe(
          walk.truncated,
          Boolean.match({
            onFalse: () => {
              const added = node();
              append(below, added);
              stepWalk(walk, 1);
              grow(added);
            },
            onTrue: constVoid,
          }),
        );
      grow(future);

      assert.strictEqual(walk.elements.length, 12);
      assert.strictEqual(walk.examined, 12);
      assert.isFalse(stepWalk(walk, 1));
    }),
  );
});

// ---------------------------------------------------------------------------
// A `Dom` that counts the turns that the browser gets
// ---------------------------------------------------------------------------

interface Turns {
  /** How many times the walk gave the thread back. */
  readonly count: Ref.Ref<number>;
  /** Completed at the first turn, so a test can act inside the walk. */
  readonly first: Deferred.Deferred<void>;
}

/**
 * A `Dom` whose clock jumps one millisecond for each read.
 *
 * The budget of the walk is therefore over after a few steps, and the number
 * of turns does not depend on the speed of the machine.
 */
const countingDom = (turns: Turns): Layer.Layer<Dom> =>
  pipe(
    Layer.effect(
      Dom,
      Effect.gen(function* () {
        const dom = yield* Dom;
        const clock = yield* Ref.make(0);
        return pipe(
          dom,
          Struct.assign({
            yieldToBrowser: Effect.gen(function* () {
              yield* pipe(
                turns.count,
                Ref.update((value) => value + 1),
              );
              yield* pipe(turns.first, Deferred.succeed<void>(undefined));
              // A real turn: `Dom.yieldToBrowser` posts through a
              // `MessageChannel`, so the fiber suspends, and an interruption
              // takes effect here.
              yield* Effect.yieldNow;
            }),
            now: pipe(
              clock,
              Ref.getAndUpdate((value) => value + 1),
            ),
          }),
          (service) => Dom.of(service),
        );
      }),
    ),
    Layer.provide(Dom.layer),
  );

const makeTurns = Effect.gen(function* () {
  const count = yield* Ref.make(0);
  const first = yield* Deferred.make<void>();
  return { count, first } satisfies Turns;
});

describe("discovery in slices", () => {
  it.effect("gives the thread back before it has walked the whole tree", () =>
    Effect.gen(function* () {
      const turns = yield* makeTurns;
      const tree = buildTree(6, 5);

      const collected = yield* pipe(
        collectElements(tree, { checkEvery: 64 }),
        Effect.provide(countingDom(turns)),
      );

      const count = yield* Ref.get(turns.count);
      // This exact result enforces the default eight-millisecond budget. The
      // deterministic clock makes a larger budget use fewer browser turns.
      assert.strictEqual(count, 54);
      assert.isAbove(collected.elements.length, 4_000);
    }),
  );

  it.effect("stops at the first turn when the fiber is interrupted", () =>
    Effect.gen(function* () {
      const turns = yield* makeTurns;
      const tree = buildTree(6, 5);

      const fiber = yield* pipe(
        collectElements(tree, { budgetMs: 8, checkEvery: 64 }),
        Effect.provide(countingDom(turns)),
        Effect.forkChild,
      );

      // A signal, and not a sleep: the walk itself says when it gave the
      // thread back for the first time.
      yield* Deferred.await(turns.first);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      assert.isTrue(Exit.hasInterrupts(exit), "the walk must not finish");
      const count = yield* Ref.get(turns.count);
      // A walk that ran to the end took far more turns than this.
      assert.isBelow(count, 4);
    }),
  );

  it.effect("walks an empty document without a turn", () =>
    Effect.gen(function* () {
      const turns = yield* makeTurns;

      const collected = yield* pipe(
        collectElements(root(), {}),
        Effect.provide(countingDom(turns)),
      );

      assert.strictEqual(collected.elements.length, 0);
      assert.strictEqual(yield* Ref.get(turns.count), 0);
    }),
  );
});
