/**
 * The selection primitives of visual mode and caret mode.
 *
 * Ported from the `content_scripts/mode_visual.js` of Vimium (the `Movement`
 * object), MIT. This is the one subsystem that ports almost unchanged.
 * `Selection.modify()` comes *from WebKit*: it shipped in Safari 1.3, and
 * everything that the upstream implementation uses has been there longer than
 * Vimium has.
 *
 * The only true WebKit work is at the bottom of this file.
 * `ShadowRoot.getSelection()` does not exist in Safari, and
 * `caretPositionFromPoint` arrived only in Safari 26.2.
 *
 * Every function here takes the `Selection`, the `Document` or the
 * `CapabilityReport` that it needs, and gives an answer. None of them reads a
 * global. The service in `Visual.ts` calls them inside `dom.probeOrElse`.
 */

import {
  Array,
  Iterable,
  Match,
  Number,
  Option,
  Ordering,
  Record,
  Result,
  flow,
  pipe,
} from "effect";
import { constVoid } from "effect/Function";
import type { CapabilityReport } from "~/platform/Capabilities.ts";
import { elementAt, isText } from "~/platform/Elements.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * `"extend"` for visual mode, `"move"` for caret mode.
 *
 * That one flag is the whole difference in meaning between the two modes. One
 * drags the focus and leaves the anchor. The other drags both.
 */
export type AlterMethod = "extend" | "move";

export type Direction = "forward" | "backward";

export type Granularity =
  | "character"
  | "word"
  | "line"
  | "lineboundary"
  | "sentence"
  | "paragraph"
  | "documentboundary"
  /** Not native: the `w` of Vim, composed from the `word` primitives below. */
  | "vimword";

export interface MovementSpec {
  readonly direction: Direction;
  readonly granularity: Granularity;
}

export const opposite: (direction: Direction) => Direction = pipe(
  Match.type<Direction>(),
  Match.withReturnType<Direction>(),
  Match.when("forward", () => "backward"),
  Match.when("backward", () => "forward"),
  Match.exhaustive,
);

/**
 * The motion table of Vimium, unchanged.
 *
 * `gg` is keyed as the sequence of two characters. The mode collects it.
 */
export const MOVEMENTS: Record.ReadonlyRecord<string, MovementSpec> = {
  h: { direction: "backward", granularity: "character" },
  l: { direction: "forward", granularity: "character" },
  j: { direction: "forward", granularity: "line" },
  k: { direction: "backward", granularity: "line" },
  e: { direction: "forward", granularity: "word" },
  b: { direction: "backward", granularity: "vimword" },
  w: { direction: "forward", granularity: "vimword" },
  "(": { direction: "backward", granularity: "sentence" },
  ")": { direction: "forward", granularity: "sentence" },
  "{": { direction: "backward", granularity: "paragraph" },
  "}": { direction: "forward", granularity: "paragraph" },
  "0": { direction: "backward", granularity: "lineboundary" },
  $: { direction: "forward", granularity: "lineboundary" },
  G: { direction: "forward", granularity: "documentboundary" },
  gg: { direction: "backward", granularity: "documentboundary" },
};

// ---------------------------------------------------------------------------
// Selection writes
// ---------------------------------------------------------------------------

/**
 * Run a selection write that the browser may refuse.
 *
 * A refusal leaves the selection as it was, and that is the whole answer.
 */
const tolerate = (write: () => void): void => {
  Result.try(write);
};

// ---------------------------------------------------------------------------
// Running a movement
// ---------------------------------------------------------------------------

/** A movement that `Selection.modify` understands as it is. */
interface NativeMovement {
  readonly direction: Direction;
  readonly granularity: Exclude<Granularity, "vimword">;
}

const WORD_FORWARD: NativeMovement = { direction: "forward", granularity: "word" };

const WORD_BACKWARD: NativeMovement = { direction: "backward", granularity: "word" };

/**
 * The selection, when this realm gives it a working `modify`.
 *
 * The DOM library that we compile against declares the method, so this check
 * is for the run time only. A realm, or a script of the page, can still take
 * the method away.
 */
const modifiable = (selection: Selection): Option.Option<Selection> =>
  pipe(
    selection,
    Option.liftPredicate((selection) => typeof selection.modify === "function"),
  );

export const canModify = (selection: Selection): boolean => Option.isSome(modifiable(selection));

const modify = (selection: Selection, alter: AlterMethod, movement: NativeMovement): void =>
  pipe(
    selection,
    modifiable,
    Option.match({
      onNone: constVoid,
      onSome: (target) => target.modify(alter, movement.direction, movement.granularity),
    }),
  );

/**
 * The native movements that one movement is made of.
 *
 * The `word` motions are built by hand, and they must stay that way. The native
 * `word` granularity means "to the end of the word" on macOS, and "to the start
 * of the next word" on Windows and on Linux. `w` and `e` can therefore not both
 * be one native call on any one platform. Building them from the primitives —
 * forward, forward, back — gives the meaning of Vim everywhere, and that is
 * what upstream does.
 */
const nativeMovements = ({ direction, granularity }: MovementSpec): ReadonlyArray<NativeMovement> =>
  pipe(
    Match.value(granularity),
    Match.when("vimword", () => vimWord(direction)),
    Match.orElse((granularity) => [{ direction, granularity }]),
  );

const vimWord = (direction: Direction): ReadonlyArray<NativeMovement> =>
  pipe(
    Match.value(direction),
    // Over the end of this word, over the end of the next one, then back to
    // the start of that word: the `w` of Vim.
    Match.when("forward", () => [WORD_FORWARD, WORD_FORWARD, WORD_BACKWARD]),
    // A backward `word` already lands on the start of a word, which is the `b`
    // of Vim.
    Match.when("backward", () => [WORD_BACKWARD]),
    Match.exhaustive,
  );

/** Run one movement, `count` times, and once at least. */
export const runMovement = (
  selection: Selection,
  alter: AlterMethod,
  spec: MovementSpec,
  count = 1,
): void =>
  pipe(
    spec,
    nativeMovements,
    Array.replicate(Math.max(1, count)),
    Array.flatten,
    Array.forEach((movement) => modify(selection, alter, movement)),
  );

// ---------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------

const probeDirection = (selection: Selection): Direction => {
  const before = selection.toString().length;
  selection.modify("extend", "forward", "character");
  return pipe(
    Number.Order(selection.toString().length, before),
    Ordering.match({
      onGreaterThan: () => undoProbe(selection, "forward"),
      // No change means that we are against the end of the document. Nothing
      // moved, so there is nothing to undo.
      onEqual: (): Direction => "forward",
      onLessThan: () => undoProbe(selection, "backward"),
    }),
  );
};

/**
 * Undo the probe, and give `direction`.
 *
 * The undo is always a backward extend: an extend forward moves the focus one
 * character forward, whichever end it was at.
 */
const undoProbe = (selection: Selection, direction: Direction): Direction => {
  selection.modify("extend", "backward", "character");
  return direction;
};

/**
 * Which end of the selection holds the focus, found by a probe.
 *
 * Extend one character forward, see whether the selection grew or became
 * smaller, then undo it. Upstream does this instead of comparing the positions
 * of the anchor and the focus, because those are *retargeted* across a shadow
 * boundary, and because `anchorNode` and `focusNode` say nothing useful when
 * the selection covers a table or a run of text in the other direction.
 */
export const getDirection: (selection: Selection) => Direction = flow(
  modifiable,
  Option.match({
    onNone: (): Direction => "forward",
    onSome: probeDirection,
  }),
);

/** The anchor and the focus of the selection, when it has both. */
const selectionEnds = (
  selection: Selection,
): Option.Option<{ readonly anchor: CaretPoint; readonly focus: CaretPoint }> =>
  pipe(
    Option.all({
      anchor: Option.fromNullishOr(selection.anchorNode),
      focus: Option.fromNullishOr(selection.focusNode),
    }),
    Option.map(({ anchor, focus }) => ({
      anchor: { node: anchor, offset: selection.anchorOffset },
      focus: { node: focus, offset: selection.focusOffset },
    })),
  );

/** Exchange the anchor and the focus, and keep the text. The `o` of Vim. */
export const reverseSelection = (selection: Selection): void =>
  pipe(
    selectionEnds(selection),
    Option.match({
      onNone: constVoid,
      // The two boundaries can be in different trees. Safari then refuses, and
      // the selection stays as it is.
      onSome: ({ anchor, focus }) =>
        tolerate(() =>
          selection.setBaseAndExtent(focus.node, focus.offset, anchor.node, anchor.offset),
        ),
    }),
  );

/** Collapse onto a point. The node can be removed between the read and the write. */
const collapseTo = (selection: Selection): ((point: Option.Option<CaretPoint>) => void) =>
  Option.match({
    onNone: constVoid,
    onSome: ({ node, offset }: CaretPoint) => tolerate(() => selection.collapse(node, offset)),
  });

export const collapseToAnchor = (selection: Selection): void =>
  pipe(
    selection.anchorNode,
    Option.fromNullishOr,
    Option.map((node) => ({ node, offset: selection.anchorOffset })),
    collapseTo(selection),
  );

/**
 * Collapse onto the focus end.
 *
 * This is the end to keep when visual mode hands over to caret mode. The focus
 * is where the cursor of the user is, and the anchor is where they started.
 */
export const collapseToFocus = (selection: Selection): void =>
  pipe(
    selection.focusNode,
    Option.fromNullishOr,
    Option.map((node) => ({ node, offset: selection.focusOffset })),
    collapseTo(selection),
  );

/**
 * Grow the selection one character forward, so that caret mode shows something.
 *
 * A collapsed selection draws nothing at all inside a page that is not
 * editable, because there is no caret of the page to inherit. Upstream solves
 * this by keeping a selection of one character alive, and that selection is
 * also the block cursor.
 */
export const extendByOneCharacter = (selection: Selection): number => {
  const before = selection.toString().length;
  modify(selection, "extend", { direction: "forward", granularity: "character" });
  return selection.toString().length - before;
};

/**
 * Round the selection out to whole lines.
 *
 * The shape is ported from the `VisualLineMode.extendSelection` of upstream:
 * extend to the line boundary at the focus end, turn the selection round,
 * extend again, turn it back. The two reversals leave the original direction as
 * it was, which matters because the next `j` must keep growing the selection
 * and not start to make it smaller.
 */
export const extendToLines = (selection: Selection): void => {
  const direction = getDirection(selection);
  pipe(
    [direction, opposite(direction)],
    Array.forEach((step) => {
      runMovement(selection, "extend", { direction: step, granularity: "lineboundary" });
      reverseSelection(selection);
    }),
  );
};

// ---------------------------------------------------------------------------
// A point, mapped to a caret
// ---------------------------------------------------------------------------

export interface CaretPoint {
  readonly node: Node;
  readonly offset: number;
}

type CaretReader = (x: number, y: number) => Option.Option<CaretPoint>;

const positionReader =
  (document: Document): CaretReader =>
  (x, y) =>
    pipe(
      document.caretPositionFromPoint(x, y),
      Option.fromNullishOr,
      Option.map((position) => ({ node: position.offsetNode, offset: position.offset })),
    );

const rangeReader =
  (document: Document): CaretReader =>
  (x, y) =>
    pipe(
      document.caretRangeFromPoint(x, y),
      Option.fromNullishOr,
      Option.map((range) => ({ node: range.startContainer, offset: range.startOffset })),
    );

/**
 * Change coordinates in the viewport into a caret position.
 *
 * The order of the feature detection is the **opposite** of the usual advice.
 * Everybody says to prefer the standard `caretPositionFromPoint` and to fall
 * back to the WebKit `caretRangeFromPoint`. The standard one arrived only in
 * Safari 26.2, and the older one has been there since Safari 5. The order below
 * therefore still prefers the standard API where it exists, and it does not
 * treat the absence of that API as exotic.
 *
 * The capability report decides, so that one probe answers for the whole
 * application. Each method is also looked for, because the DOM library that we
 * compile against declares both, and a realm need not have either.
 */
export const caretAtPoint = (
  document: Document,
  capabilities: CapabilityReport,
  x: number,
  y: number,
): Option.Option<CaretPoint> =>
  pipe(
    positionReader(document),
    Option.liftPredicate(
      () =>
        capabilities.caretPositionFromPoint &&
        typeof document.caretPositionFromPoint === "function",
    ),
    Option.orElse(() =>
      pipe(
        rangeReader(document),
        Option.liftPredicate(
          () =>
            capabilities.caretRangeFromPoint && typeof document.caretRangeFromPoint === "function",
        ),
      ),
    ),
    Option.flatMap((read) => read(x, y)),
  );

// ---------------------------------------------------------------------------
// Selection reads that see into a shadow root
// ---------------------------------------------------------------------------

export interface SelectionBoundaries {
  readonly start: CaretPoint;
  readonly end: CaretPoint;
  readonly collapsed: boolean;
}

/**
 * Read the true boundaries of the selection, through an open shadow root.
 *
 * `ShadowRoot.getSelection()` is **not implemented in Safari**, so the trick of
 * the Chromium era — ask the shadow root for its own selection — is not
 * available. `Selection.getComposedRanges()`, which is Safari 17 and later, is
 * the replacement, and `capabilities.composedRanges` reports it.
 *
 * It only sees into the roots that it is given, and we do not have a list of
 * every root on the page. The rule below uses the fact that the retargeting is
 * *visible*: when the selection reports an anchor that is itself a shadow host,
 * the true boundary is inside the root of that host, so that root and its
 * nested roots are what we pass. Everything else falls back to the plain read.
 */
export const readBoundaries = (
  selection: Selection,
  capabilities: CapabilityReport,
): Option.Option<SelectionBoundaries> =>
  pipe(
    selection,
    Option.liftPredicate(() => capabilities.composedRanges),
    Option.flatMap(composedBoundaries),
    Option.orElse(() =>
      pipe(
        selectionEnds(selection),
        Option.map(({ anchor, focus }) => ({
          start: anchor,
          end: focus,
          collapsed: selection.isCollapsed,
        })),
      ),
    ),
  );

const composedBoundaries = (selection: Selection): Option.Option<SelectionBoundaries> =>
  pipe(
    selection,
    Option.liftPredicate((selection) => typeof selection.getComposedRanges === "function"),
    Option.flatMap(firstComposedRange),
    Option.map((range) => ({
      start: { node: range.startContainer, offset: range.startOffset },
      end: { node: range.endContainer, offset: range.endOffset },
      collapsed:
        range.startContainer === range.endContainer && range.startOffset === range.endOffset,
    })),
  );

/** The first composed range of the selection. A throw gives none. */
const firstComposedRange = (selection: Selection): Option.Option<StaticRange> =>
  pipe(
    Result.try(() =>
      pipe(
        shadowRootsNear(selection),
        Array.match({
          onEmpty: () => selection.getComposedRanges(),
          onNonEmpty: (shadowRoots) =>
            selection.getComposedRanges({ shadowRoots: Array.copy(shadowRoots) }),
        }),
      ),
    ),
    Result.getSuccess,
    Option.flatMap(Array.head),
  );

/**
 * Limited in depth.
 *
 * A deep tree of components must not make this walk quadratic.
 */
const MAX_SHADOW_DEPTH = 8;

const shadowRootsNear = (selection: Selection): ReadonlyArray<ShadowRoot> =>
  pipe(
    [selection.anchorNode, selection.focusNode],
    Array.flatMap(flow(Option.fromNullishOr, Option.flatMap(elementAt), shadowChain)),
  );

/**
 * The shadow root of `host`, the root of its first element, and so on.
 *
 * A retargeted anchor points at the host. The chain goes down one level for
 * each hop.
 */
const shadowChain = (host: Option.Option<Element>): ReadonlyArray<ShadowRoot> =>
  pipe(
    Iterable.unfold(
      host,
      flow(
        Option.flatMapNullishOr((host) => host.shadowRoot),
        Option.map((shadow) => [shadow, Option.fromNullishOr(shadow.firstElementChild)] as const),
      ),
    ),
    Iterable.take(MAX_SHADOW_DEPTH),
    Array.fromIterable,
  );

// ---------------------------------------------------------------------------
// The anchor of caret mode
// ---------------------------------------------------------------------------

/**
 * How much text a node must hold before the caret is worth putting in it.
 *
 * The number comes from upstream. Below it you land in a navigation link or in
 * a cookie banner, which is never where a user who presses `v` on an article
 * wants to start.
 */
export const CARET_ANCHOR_MIN_CHARACTERS = 50;

/** The nodes of `walker` in document order. The walker moves, so read them once. */
const walkedNodes = (walker: TreeWalker): Iterable<Node> =>
  Iterable.unfold(walker, (walker) =>
    pipe(
      walker.nextNode(),
      Option.fromNullishOr,
      Option.map((node) => [node, walker] as const),
    ),
  );

/** Is `text` large, drawn and not editable? */
const isCaretAnchor = (text: Text): boolean =>
  pipe(
    text,
    Option.liftPredicate(
      (text) => text.data.replace(/\s/g, "").length >= CARET_ANCHOR_MIN_CHARACTERS,
    ),
    Option.flatMapNullishOr((text) => text.parentElement),
    Option.filter((parent) => !parent.isContentEditable),
    // A rectangle, and not a computed style: this is one call for each
    // *candidate* node, of which there are a few, and it is the only check that
    // catches an ancestor that clips the node to no height.
    Option.flatMapNullishOr((parent) => parent.getClientRects().item(0)),
    Option.exists((rect) => rect.width !== 0 && rect.height !== 0),
  );

/**
 * The first text node of the document that is large, drawn and not editable.
 *
 * Ported from the `mode_visual.js` of Vimium
 * (`Movement.selectLexicalEntity` and `establishInitialSelectionAnchor`).
 */
export const findCaretAnchor = (document: Document): Option.Option<Text> =>
  pipe(
    document.body,
    Option.fromNullishOr,
    Option.flatMap((body) =>
      pipe(
        walkedNodes(document.createTreeWalker(body, NodeFilter.SHOW_TEXT)),
        Iterable.filter(isText),
        Iterable.findFirst(isCaretAnchor),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

/** The part of the viewport that the user sees. `Ui.viewport` gives it. */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/** Is `rect` drawn, and not wholly inside the viewport? */
const needsScroll = (rect: DOMRect, viewport: ViewportSize): boolean =>
  !(rect.width === 0 && rect.height === 0) &&
  !(
    rect.top >= 0 &&
    rect.bottom <= viewport.height &&
    rect.left >= 0 &&
    rect.right <= viewport.width
  );

/**
 * Keep the focus end of the selection on screen.
 *
 * `behavior: "instant"` on purpose: the smooth scrolling of Safari cannot be
 * cancelled, so a held `j` would queue animation that the user cannot stop.
 *
 * The size comes from the *visual* viewport. Under the dynamic toolbar of iOS,
 * and during a pinch zoom, that is the part of the page that the user sees, and
 * `innerHeight` is not.
 */
export const scrollSelectionIntoView = (selection: Selection, viewport: ViewportSize): void =>
  pipe(
    selection.rangeCount - 1,
    Option.liftPredicate((last) => last >= 0),
    Option.map((last) => selection.getRangeAt(last)),
    Option.filter((range) => needsScroll(range.getBoundingClientRect(), viewport)),
    Option.flatMap((range) => elementAt(range.startContainer)),
    Option.match({
      onNone: constVoid,
      onSome: (element) =>
        element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }),
    }),
  );

/** The selected text. `Selection.toString()` is the only portable reader. */
export const selectionText = (selection: Selection): string => selection.toString();
