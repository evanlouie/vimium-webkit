/**
 * The find walk: composed order, the rendered boundary and the budget.
 *
 * Unit tests run in Node, where there is no DOM. The walk is written for that:
 * it reads `nodeType`, `tagName`, `childNodes`, `shadowRoot` and
 * `assignedNodes`, and it asks the view for a computed style. A tree of plain
 * objects gives all of those, so the rules about composed order, about a
 * rendered boundary and about the character budget are tested here, and the
 * browser tests in `test/e2e/find.spec.ts` confirm the same rules against a
 * real layout.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  collectTextRuns,
  type RunCollection,
  type StyleSource,
} from "~/features/find/Engine.ts";

// ---------------------------------------------------------------------------
// A tree of plain objects
// ---------------------------------------------------------------------------

interface FakeElement {
  readonly nodeType: 1;
  readonly tagName: string;
  readonly childNodes: ReadonlyArray<unknown>;
  readonly shadowRoot: unknown;
  readonly display: string;
  readonly hiddenAttribute: boolean;
  readonly hasAttribute: (name: string) => boolean;
  readonly checkVisibility: () => boolean;
  readonly assignedNodes?: (
    options?: { readonly flatten?: boolean },
  ) => ReadonlyArray<unknown>;
}

const text = (data: string): Text =>
  ({ nodeType: 3, data, childNodes: [] }) as unknown as Text;

interface ElementOptions {
  readonly tag?: string;
  /** The computed display. `block` is the default, as it is for a `<div>`. */
  readonly display?: string;
  readonly hidden?: boolean;
  /** The children of an open shadow root. `undefined` means no root at all. */
  readonly shadow?: ReadonlyArray<unknown>;
  /** What a slot is assigned, with the fallback children already resolved. */
  readonly assigned?: ReadonlyArray<unknown>;
}

const element = (
  children: ReadonlyArray<unknown>,
  options: ElementOptions = {},
): Element => {
  const display = options.display ?? "block";
  const node: FakeElement = {
    nodeType: 1,
    tagName: (options.tag ?? "div").toUpperCase(),
    childNodes: children,
    shadowRoot: options.shadow === undefined
      ? null
      : { nodeType: 11, childNodes: options.shadow },
    display,
    hiddenAttribute: options.hidden ?? false,
    hasAttribute: (name: string): boolean =>
      name === "hidden" && (options.hidden ?? false),
    // The browser answers `false` for an element with no box of its own, and
    // `display: contents` is exactly that.
    checkVisibility: (): boolean =>
      display !== "none" && display !== "contents",
    ...(options.assigned === undefined ? {} : {
      assignedNodes: (): ReadonlyArray<unknown> => options.assigned ?? [],
    }),
  };
  return node as unknown as Element;
};

/** An inline box, which never breaks a line. */
const span = (children: ReadonlyArray<unknown>): Element =>
  element(children, { tag: "span", display: "inline" });

/** A block box, which always breaks a line. */
const block = (children: ReadonlyArray<unknown>): Element =>
  element(children, { tag: "p", display: "block" });

const view: StyleSource = {
  getComputedStyle: (target: Element) => {
    const node = target as unknown as FakeElement;
    return { display: node.display, visibility: "visible" };
  },
};

const collect = (
  body: Element,
  options: {
    readonly maxCharacters?: number;
    readonly deadline?: number;
    readonly checkVisibility?: boolean;
  } = {},
): RunCollection =>
  collectTextRuns({
    view,
    document: {
      nodeType: 9,
      body,
      documentElement: body,
    } as unknown as Document,
    // `false` sends the walk through `getComputedStyle`, which is the path
    // that a browser without `checkVisibility` takes.
    capabilities: { checkVisibility: options.checkVisibility ?? false },
    excludeHost: Option.none(),
    ...(options.maxCharacters === undefined
      ? {}
      : { maxCharacters: options.maxCharacters }),
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
  });

const haystacks = (collection: RunCollection): ReadonlyArray<string> =>
  collection.runs.map((run) => run.haystack);

// ---------------------------------------------------------------------------
// The rendered order and the rendered boundary
// ---------------------------------------------------------------------------

describe("the composed walk", () => {
  it.effect("joins the inline text of one line into one run", () =>
    Effect.sync(() => {
      const collection = collect(
        block([text("hemi"), span([text("sphere")]), text(" tilts")]),
      );
      assert.deepStrictEqual(haystacks(collection), ["hemisphere tilts"]);
      assert.isFalse(collection.stopped);
    }));

  it.effect("ends a run where the browser draws a block boundary", () =>
    Effect.sync(() => {
      // Two paragraphs with nothing between them. The reader sees two lines,
      // so `northwest` is not a word on this page.
      const collection = collect(
        element([block([text("north")]), block([text("west")])]),
      );
      assert.deepStrictEqual(haystacks(collection), ["north", "west"]);
    }));

  it.effect("keeps `display: contents` inside one run", () =>
    Effect.sync(() => {
      // The element draws no box, so the text on both sides of it stays on
      // one line.
      const collection = collect(
        block([
          text("hemi"),
          element([text("sphere")], { display: "contents" }),
          text("s"),
        ]),
      );
      assert.deepStrictEqual(haystacks(collection), ["hemispheres"]);
    }));

  it.effect("ends a run at a `<br>`", () =>
    Effect.sync(() => {
      const collection = collect(
        block([
          text("north"),
          element([], { tag: "br", display: "inline" }),
          text("west"),
        ]),
      );
      assert.deepStrictEqual(haystacks(collection), ["north", "west"]);
    }));

  it.effect("reads an open shadow root in the place of its host", () =>
    Effect.sync(() => {
      // The order of the source is alpha, delta (the light child), gamma, and
      // then beta (the shadow tree). The order of the screen is alpha, beta,
      // delta, gamma, because the shadow content comes before the slot.
      const slot = element([], {
        tag: "slot",
        display: "contents",
        assigned: [span([text("delta")])],
      });
      const host = element([span([text("delta")])], {
        tag: "x-card",
        display: "block",
        shadow: [block([text("beta")]), slot],
      });
      const collection = collect(
        element([block([text("alpha")]), host, block([text("gamma")])]),
      );
      assert.deepStrictEqual(haystacks(collection), [
        "alpha",
        "beta",
        "delta",
        "gamma",
      ]);
    }));

  it.effect("takes a slotted node once, and in the place of the slot", () =>
    Effect.sync(() => {
      const slot = element([], {
        tag: "slot",
        display: "contents",
        assigned: [text("two")],
      });
      const host = element([text("two")], {
        tag: "x-card",
        display: "inline",
        shadow: [text("one "), slot, text(" three")],
      });
      const collection = collect(block([host]));
      assert.deepStrictEqual(haystacks(collection), ["one two three"]);
    }));

  it.effect("drops a light child that no slot takes", () =>
    Effect.sync(() => {
      const host = element([text("delta")], {
        tag: "x-card",
        display: "block",
        shadow: [block([text("beta")])],
      });
      assert.deepStrictEqual(haystacks(collect(element([host]))), ["beta"]);
    }));

  it.effect("descends into a shadow root inside a shadow root", () =>
    Effect.sync(() => {
      const inner = element([], {
        tag: "x-inner",
        display: "inline",
        shadow: [text("two")],
      });
      const outer = element([], {
        tag: "x-outer",
        display: "inline",
        shadow: [text("one "), inner, text(" three")],
      });
      assert.deepStrictEqual(haystacks(collect(block([outer]))), [
        "one two three",
      ]);
    }));

  it.effect("keeps a slot that `checkVisibility` calls invisible", () =>
    Effect.sync(() => {
      // A `<slot>` has `display: contents`, and the browser answers `false`
      // for an element with no box. A check with no second opinion drops every
      // slotted word on the page.
      const slot = element([], {
        tag: "slot",
        display: "contents",
        assigned: [text("two")],
      });
      const host = element([text("two")], {
        tag: "x-card",
        display: "inline",
        shadow: [text("one "), slot, text(" three")],
      });
      const collection = collect(block([host]), { checkVisibility: true });
      assert.deepStrictEqual(haystacks(collection), ["one two three"]);
    }));

  it.effect("drops an invisible subtree and joins the text beside it", () =>
    Effect.sync(() => {
      // A `display: none` element draws nothing, so it adds no boundary: the
      // reader sees `hemisphere` as one word.
      const collection = collect(
        block([
          text("hemi"),
          element([text("XXX")], { display: "none" }),
          text("sphere"),
        ]),
      );
      assert.deepStrictEqual(haystacks(collection), ["hemisphere"]);
    }));

  it.effect("drops the text of a script and of a hidden element", () =>
    Effect.sync(() => {
      const collection = collect(
        block([
          text("keep"),
          element([text("var x = 1")], { tag: "script", display: "none" }),
          element([text("gone")], { hidden: true }),
        ]),
      );
      assert.deepStrictEqual(haystacks(collection), ["keep"]);
    }));

  it.effect("keeps the offsets of each node inside its run", () =>
    Effect.sync(() => {
      const first = text("hemi");
      const second = text("sphere");
      const collection = collect(block([first, span([second])]));
      const run = collection.runs[0];
      assert.isDefined(run);
      assert.deepStrictEqual([...run.nodes], [first, second]);
      assert.deepStrictEqual([...run.lengths], [4, 6]);
      assert.deepStrictEqual([...run.starts], [0, 4]);
    }));
});

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

describe("the walk budget", () => {
  it.effect("slices one text node to what is left of the budget", () =>
    Effect.sync(() => {
      const collection = collect(block([text("a".repeat(1000))]), {
        maxCharacters: 100,
      });
      const run = collection.runs[0];
      assert.isDefined(run);
      assert.strictEqual(run.haystack.length, 100);
      assert.deepStrictEqual([...run.lengths], [100]);
      // The count of the page is now partial, and the HUD must say so.
      assert.isTrue(collection.stopped);
    }));

  it.effect("answers a text node of many megabytes inside a keystroke", () =>
    Effect.sync(() => {
      // The node is far larger than the budget. The cost of the walk is the
      // budget, and not the length of the node: without the slice the whole
      // node is copied, normalised and joined before anything is checked.
      const huge = text("lorem ipsum ".repeat(500_000));
      assert.isAbove(huge.data.length, 5_000_000);
      const body = block([huge]);

      const started = performance.now();
      const collection = collect(body, { maxCharacters: 2_048 });
      const elapsed = performance.now() - started;

      const run = collection.runs[0];
      assert.isDefined(run);
      assert.strictEqual(run.haystack.length, 2_048);
      assert.isTrue(collection.stopped);
      assert.isBelow(elapsed, 25, `the walk cost ${elapsed}ms`);
    }));

  it.effect("spends the budget over the nodes that come first", () =>
    Effect.sync(() => {
      const collection = collect(
        element([
          block([text("aaaa")]),
          block([text("bbbb")]),
          block([text("cccc")]),
        ]),
        { maxCharacters: 6 },
      );
      assert.deepStrictEqual(haystacks(collection), ["aaaa", "bb"]);
      assert.isTrue(collection.stopped);
    }));

  it.effect("reports no stop when the page fits in the budget", () =>
    Effect.sync(() => {
      const collection = collect(block([text("hemisphere")]), {
        maxCharacters: 10,
      });
      assert.deepStrictEqual(haystacks(collection), ["hemisphere"]);
      assert.isFalse(collection.stopped);
    }));

  it.effect("stops a deep page at the deadline, and says so", () =>
    Effect.sync(() => {
      const paragraphs: Element[] = [];
      for (let index = 0; index < 20_000; index++) {
        paragraphs.push(block([text(`line ${index}`)]));
      }
      const body = element(paragraphs);

      const started = performance.now();
      // A deadline that has already passed. The walk must give back what it
      // has, and not read the page to its end.
      const collection = collect(body, { deadline: performance.now() - 1 });
      const elapsed = performance.now() - started;

      assert.isTrue(collection.stopped);
      assert.strictEqual(collection.runs.length, 0);
      assert.isBelow(elapsed, 25, `the walk cost ${elapsed}ms`);
    }));
});
