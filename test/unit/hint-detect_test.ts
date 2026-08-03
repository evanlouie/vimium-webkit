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
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Stream,
} from "effect";
import { Dom } from "~/platform/Dom.ts";
import {
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
const mapElement = (name: string | null, id: string | null = null): Element =>
  ({
    getAttribute: (attribute: string): string | null =>
      attribute === "name" ? name : attribute === "id" ? id : null,
  }) as unknown as Element;

/** A document or shadow root that accepts only the fixed `map` selector. */
const rootWith = (maps: readonly Element[]): Document | ShadowRoot =>
  ({
    querySelectorAll: (selector: string): readonly Element[] => {
      if (selector !== "map") {
        throw new SyntaxError(`the lookup built a selector: ${selector}`);
      }
      return maps;
    },
  }) as unknown as Document | ShadowRoot;

/** An image context inside `root`, with its owning document. */
const contextIn = (
  root: Document | ShadowRoot,
  ownerDocument: Document = root as Document,
): Element =>
  ({
    ownerDocument,
    getRootNode: (): Document | ShadowRoot => root,
  }) as unknown as Element;

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
  for (const [label, name] of AWKWARD_NAMES) {
    it.effect(`finds the map whose name holds ${label}`, () =>
      Effect.sync(() => {
        const target = mapElement(name);
        const context = contextIn(rootWith([mapElement("other"), target]));

        const found = findImageMap(context, `#${name}`);

        assert.isTrue(
          Option.isSome(found),
          `no map for ${JSON.stringify(name)}`,
        );
        assert.strictEqual(Option.getOrNull(found), target);
      }));
  }

  it.effect("gives no map for an empty name", () =>
    Effect.sync(() => {
      const context = contextIn(rootWith([mapElement(""), mapElement("nav")]));
      // The image then gets no hint of its own, and every other element on the
      // page keeps its hint.
      assert.isTrue(Option.isNone(findImageMap(context, "#")));
      assert.isTrue(Option.isNone(findImageMap(context, "")));
      assert.isTrue(Option.isNone(mapNameOf("#")));
      assert.isTrue(Option.isNone(mapNameOf("")));
    }));

  it.effect("takes the first map when the name is on the page two times", () =>
    Effect.sync(() => {
      const first = mapElement("nav");
      const second = mapElement("nav");
      const context = contextIn(rootWith([first, second]));

      assert.strictEqual(
        Option.getOrNull(findImageMap(context, "#nav")),
        first,
      );
    }));

  it.effect("gives no map for a name that is not on the page", () =>
    Effect.sync(() => {
      const context = contextIn(rootWith([mapElement("nav")]));
      assert.isTrue(Option.isNone(findImageMap(context, "#missing")));
    }));

  it.effect("compares the name exactly", () =>
    Effect.sync(() => {
      const context = contextIn(rootWith([mapElement("nav")]));
      assert.isTrue(Option.isNone(findImageMap(context, "#NAV")));
      assert.isTrue(Option.isNone(findImageMap(context, "#nav ")));
      assert.isTrue(Option.isNone(findImageMap(context, "nav")));
      assert.strictEqual(Option.getOrNull(mapNameOf("#nav")), "nav");
    }));

  it.effect("keeps a name that already holds a hash", () =>
    Effect.sync(() => {
      const target = mapElement("#nav");
      const context = contextIn(rootWith([mapElement("nav"), target]));
      // Only the first `#` is the separator, as `usemap` defines it.
      assert.strictEqual(
        Option.getOrNull(findImageMap(context, "##nav")),
        target,
      );
    }));

  it.effect("uses the text after the first hash", () =>
    Effect.sync(() => {
      const target = mapElement("nav");
      const context = contextIn(rootWith([target]));
      assert.strictEqual(
        Option.getOrNull(findImageMap(context, "prefix#nav")),
        target,
      );
    }));

  it.effect("matches an id when a map has no name", () =>
    Effect.sync(() => {
      const target = mapElement(null, "nav");
      const context = contextIn(rootWith([target]));
      assert.strictEqual(
        Option.getOrNull(findImageMap(context, "#nav")),
        target,
      );
    }));

  it.effect("searches only the image context tree", () =>
    Effect.sync(() => {
      const documentMap = mapElement("nav");
      const shadowMap = mapElement("nav");
      const documentRoot = rootWith([documentMap]) as Document;
      const documentContext = contextIn(documentRoot);
      const shadowContext = contextIn(rootWith([shadowMap]), documentRoot);
      const emptyShadowContext = contextIn(rootWith([]), documentRoot);

      assert.strictEqual(
        Option.getOrNull(findImageMap(shadowContext, "#nav")),
        shadowMap,
      );
      assert.strictEqual(
        Option.getOrNull(findImageMap(documentContext, "#nav")),
        documentMap,
      );
      assert.isTrue(Option.isNone(findImageMap(emptyShadowContext, "#nav")));
    }));
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
  readonly childNodes: readonly unknown[];
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

let nextId = 0;
let siblingReads = 0;

const node = (localName = "div"): FakeNode => {
  nextId += 1;
  const id = nextId;
  const self: FakeNode = {
    localName,
    children: [],
    childNodes: [],
    shadowRoot: null,
    parent: null,
    index: 0,
    get firstElementChild(): FakeNode | null {
      return self.children[0] ?? null;
    },
    get lastElementChild(): FakeNode | null {
      return self.children[self.children.length - 1] ?? null;
    },
    get nextElementSibling(): FakeNode | null {
      siblingReads += 1;
      return self.parent?.children[self.index + 1] ?? null;
    },
    get previousElementSibling(): FakeNode | null {
      siblingReads += 1;
      return self.parent?.children[self.index - 1] ?? null;
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
      return self.children[0] ?? null;
    },
    get lastElementChild(): FakeNode | null {
      return self.children[self.children.length - 1] ?? null;
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
const remove = (child: FakeNode): void => {
  const parent = child.parent;
  if (parent === null) return;
  parent.children.splice(child.index, 1);
  for (const [index, sibling] of parent.children.entries()) {
    sibling.index = index;
  }
  child.parent = null;
  child.index = 0;
};

/** Move `child` to the end of `parent`. */
const move = (child: FakeNode, parent: FakeParent): void => {
  remove(child);
  append(parent, child);
};

/** Every descendant of `where`, in document order, as `querySelectorAll` gives. */
const descendants = (where: FakeParent): readonly FakeNode[] => {
  const out: FakeNode[] = [];
  const visit = (parent: FakeParent): void => {
    for (const child of parent.children) {
      out.push(child);
      visit(child);
    }
  };
  visit(where);
  return out;
};

/**
 * The walk that this change replaces, copied from the file before the change.
 *
 * It is the reference for the order. The chunked walk must agree with it, node
 * for node, and it must count the same unreachable hosts.
 */
const referenceWalk = (
  where: FakeParent,
  into: { elements: FakeNode[]; unreachableHosts: number },
): void => {
  for (const element of descendants(where)) {
    into.elements.push(element);
    const shadow = element.shadowRoot;
    if (shadow !== null) referenceWalk(shadow, into);
    else if (looksClosed(element)) into.unreachableHosts += 1;
  }
};

/** The heuristic of `looksLikeClosedShadowHost`, over the fake node. */
const looksClosed = (element: FakeNode): boolean =>
  element.shadowRoot === null && element.localName.includes("-") &&
  element.childNodes.length === 0 &&
  element.getBoundingClientRect().width >= 3 &&
  element.getBoundingClientRect().height >= 3;

/**
 * A tree with `breadth` branches, `depth` levels, shadow roots and web
 * components.
 *
 * The shape is deterministic, so a failure names one node and not a random
 * one.
 */
const buildTree = (breadth: number, depth: number): FakeRoot => {
  const tree = root();
  const grow = (parent: FakeParent, level: number): void => {
    if (level === 0) return;
    for (let index = 0; index < breadth; index += 1) {
      const child = node(index % 5 === 0 ? "x-widget" : "div");
      append(parent, child);
      // Every third element carries an open shadow root with content of its
      // own, so the two walks must agree about where a shadow tree belongs.
      if (index % 3 === 0 && level > 1) {
        const shadow = root();
        grow(shadow, level - 1);
        child.shadowRoot = shadow;
      }
      grow(child, level - 1);
    }
  };
  grow(tree, depth);
  return tree;
};

const walkAll = (
  tree: FakeRoot,
  slice: number,
): { elements: readonly FakeNode[]; unreachableHosts: number } => {
  const walk = startWalk(tree as unknown as ParentNode);
  while (stepWalk(walk, slice));
  return {
    elements: walk.collected.elements as unknown as readonly FakeNode[],
    unreachableHosts: walk.collected.unreachableHosts,
  };
};

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

describe("the walk of the tree", () => {
  it.effect("finds the same elements, in the same order, as the walk before", () =>
    Effect.sync(() => {
      const tree = buildTree(6, 5);
      const reference = { elements: [] as FakeNode[], unreachableHosts: 0 };
      referenceWalk(tree, reference);

      const chunked = walkAll(tree, 7);

      assert.isAbove(reference.elements.length, 4_000);
      assert.strictEqual(chunked.elements.length, reference.elements.length);
      for (const [index, element] of reference.elements.entries()) {
        assert.strictEqual(
          chunked.elements[index],
          element,
          `element ${index} is not the element of the walk before`,
        );
      }
      assert.strictEqual(
        chunked.unreachableHosts,
        reference.unreachableHosts,
      );
      assert.isAbove(reference.unreachableHosts, 0);
    }));

  it.effect("gives the same order for every slice size", () =>
    Effect.sync(() => {
      const tree = buildTree(5, 5);
      const one = walkAll(tree, 1);
      const seven = walkAll(tree, 7);
      const whole = walkAll(tree, 5_000);

      assert.deepStrictEqual([...one.elements], [...seven.elements]);
      assert.deepStrictEqual([...one.elements], [...whole.elements]);
      assert.strictEqual(one.unreachableHosts, whole.unreachableHosts);
    }));

  it.effect("visits the host, then its shadow tree, then its light tree", () =>
    Effect.sync(() => {
      const host = node("x-host");
      const light = node("div");
      const shadowChild = node("span");
      append(host, light);
      const shadow = root();
      append(shadow, shadowChild);
      host.shadowRoot = shadow;
      const tree = root();
      append(tree, host);

      const walked = walkAll(tree, 1);

      assert.deepStrictEqual([...walked.elements], [host, shadowChild, light]);
    }));

  it.effect("gives false as soon as no element is left", () =>
    Effect.sync(() => {
      const tree = root();
      append(tree, node());
      append(tree, node());
      const walk = startWalk(tree as unknown as ParentNode);
      assert.isTrue(stepWalk(walk, 1));
      assert.isFalse(stepWalk(walk, 1));
      assert.isFalse(stepWalk(walk, 1));
      assert.strictEqual(walk.collected.elements.length, 2);
    }));

  it.effect("walks an empty root", () =>
    Effect.sync(() => {
      const walk = startWalk(root() as unknown as ParentNode);
      assert.isFalse(stepWalk(walk, 32));
      assert.strictEqual(walk.collected.elements.length, 0);
    }));

  it.effect("bounds sibling reads in one step", () =>
    Effect.sync(() => {
      const tree = root();
      for (let index = 0; index < 10_000; index += 1) append(tree, node());
      siblingReads = 0;

      const walk = startWalk(tree as unknown as ParentNode);
      assert.isTrue(stepWalk(walk, 7));

      assert.strictEqual(walk.collected.elements.length, 7);
      assert.isAtMost(siblingReads, 7);
    }));

  it.effect("excludes a child appended after its parent was visited", () =>
    Effect.sync(() => {
      const parent = node();
      const tree = root();
      append(tree, parent);
      const walk = startWalk(tree as unknown as ParentNode);
      assert.isFalse(stepWalk(walk, 1));

      const added = node();
      append(parent, added);

      assert.isFalse(stepWalk(walk, 10));
      assert.deepStrictEqual(
        walk.collected.elements as unknown as FakeNode[],
        [parent],
      );
    }));

  it.effect("includes a child added before its parent is visited", () =>
    Effect.sync(() => {
      const parent = node();
      const future = node();
      append(parent, future);
      const tree = root();
      append(tree, parent);
      const walk = startWalk(tree as unknown as ParentNode);
      assert.isTrue(stepWalk(walk, 1));

      const added = node();
      append(future, added);
      while (stepWalk(walk, 1));

      assert.deepStrictEqual(
        walk.collected.elements as unknown as FakeNode[],
        [parent, future, added],
      );
    }));

  it.effect("keeps a pending element that the page removes", () =>
    Effect.sync(() => {
      const first = node();
      const removed = node();
      const tree = root();
      append(tree, first);
      append(tree, removed);
      const walk = startWalk(tree as unknown as ParentNode);
      assert.isTrue(stepWalk(walk, 1));

      remove(removed);
      while (stepWalk(walk, 1));

      assert.deepStrictEqual(
        walk.collected.elements as unknown as FakeNode[],
        [first, removed],
      );
    }));

  it.effect("does not produce a moved element two times", () =>
    Effect.sync(() => {
      const first = node();
      const second = node();
      const tree = root();
      append(tree, first);
      append(tree, second);
      const walk = startWalk(tree as unknown as ParentNode);
      assert.isTrue(stepWalk(walk, 1));

      move(first, second);
      while (stepWalk(walk, 1));

      assert.deepStrictEqual(
        walk.collected.elements as unknown as FakeNode[],
        [first, second],
      );
    }));

  it.effect("stops continuous growth at the element limit", () =>
    Effect.sync(() => {
      const first = node();
      let future = node();
      append(first, future);
      const tree = root();
      append(tree, first);
      const walk = startWalk(tree as unknown as ParentNode, 12);
      assert.isTrue(stepWalk(walk, 1));

      while (!walk.collected.truncated) {
        const added = node();
        append(future, added);
        future = added;
        stepWalk(walk, 1);
      }

      assert.strictEqual(walk.collected.elements.length, 12);
      assert.strictEqual(walk.examined, 12);
      assert.isFalse(stepWalk(walk, 1));
    }));
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
  Layer.effect(
    Dom,
    Effect.gen(function*() {
      const clock = yield* Ref.make(0);
      return Dom.of(
        {
          window: undefined as unknown as Window & typeof globalThis,
          document: undefined as unknown as Document,
          href: Effect.succeed("https://example.test/"),
          probe: <A>(_api: string, read: () => A) => Effect.sync(read),
          probeOr: <A>(read: () => A, _fallback: A) => Effect.sync(read),
          attempt: <A>(_api: string, run: () => A) => Effect.sync(run),
          listen: () => Effect.void,
          listenOn: () => Effect.void,
          events: () => Stream.empty,
          nextFrame: Effect.succeed(0),
          yieldToBrowser: Effect.gen(function*() {
            yield* Ref.update(turns.count, (value) => value + 1);
            yield* Deferred.succeed(turns.first, undefined);
            // A real turn: `Dom.yieldToBrowser` posts through a `MessageChannel`,
            // so the fiber suspends, and an interruption takes effect here.
            yield* Effect.yieldNow;
          }),
          now: Ref.getAndUpdate(clock, (value) => value + 1),
        } as unknown as Dom["Service"],
      );
    }),
  );

const makeTurns = Effect.gen(function*() {
  const count = yield* Ref.make(0);
  const first = yield* Deferred.make<void>();
  return { count, first } satisfies Turns;
});

describe("discovery in slices", () => {
  it.effect("gives the thread back before it has walked the whole tree", () =>
    Effect.gen(function*() {
      const turns = yield* makeTurns;
      const tree = buildTree(6, 5) as unknown as ParentNode;

      const collected = yield* Effect.provide(
        collectElements(tree, { checkEvery: 64 }),
        countingDom(turns),
      );

      const count = yield* Ref.get(turns.count);
      // This exact result enforces the default eight-millisecond budget. The
      // deterministic clock makes a larger budget use fewer browser turns.
      assert.strictEqual(count, 54);
      assert.isAbove(collected.elements.length, 4_000);
    }));

  it.effect("stops at the first turn when the fiber is interrupted", () =>
    Effect.gen(function*() {
      const turns = yield* makeTurns;
      const tree = buildTree(6, 5) as unknown as ParentNode;

      const fiber = yield* Effect.forkChild(
        Effect.provide(
          collectElements(tree, { budgetMs: 8, checkEvery: 64 }),
          countingDom(turns),
        ),
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
    }));

  it.effect("walks an empty document without a turn", () =>
    Effect.gen(function*() {
      const turns = yield* makeTurns;

      const collected = yield* Effect.provide(
        collectElements(root() as unknown as ParentNode, {}),
        countingDom(turns),
      );

      assert.strictEqual(collected.elements.length, 0);
      assert.strictEqual(yield* Ref.get(turns.count), 0);
    }));
});
