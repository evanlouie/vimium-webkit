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
 * global. The service in `Visual.ts` calls them inside `dom.probeOr`.
 */

import { Option } from "effect";
import type { CapabilityReport } from "~/platform/Capabilities.ts";

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

export const opposite = (direction: Direction): Direction =>
  direction === "forward" ? "backward" : "forward";

/**
 * The motion table of Vimium, unchanged.
 *
 * `gg` is keyed as the sequence of two characters. The mode collects it.
 */
export const MOVEMENTS: ReadonlyMap<string, MovementSpec> = new Map([
  ["h", { direction: "backward", granularity: "character" }],
  ["l", { direction: "forward", granularity: "character" }],
  ["j", { direction: "forward", granularity: "line" }],
  ["k", { direction: "backward", granularity: "line" }],
  ["e", { direction: "forward", granularity: "word" }],
  ["b", { direction: "backward", granularity: "vimword" }],
  ["w", { direction: "forward", granularity: "vimword" }],
  ["(", { direction: "backward", granularity: "sentence" }],
  [")", { direction: "forward", granularity: "sentence" }],
  ["{", { direction: "backward", granularity: "paragraph" }],
  ["}", { direction: "forward", granularity: "paragraph" }],
  ["0", { direction: "backward", granularity: "lineboundary" }],
  ["$", { direction: "forward", granularity: "lineboundary" }],
  ["G", { direction: "forward", granularity: "documentboundary" }],
  ["gg", { direction: "backward", granularity: "documentboundary" }],
]);

// ---------------------------------------------------------------------------
// Running a movement
// ---------------------------------------------------------------------------

/**
 * `Selection.modify` is not in every DOM library that we compile against, and
 * the libraries that declare it type the arguments as a plain `string`. A
 * narrowing through `unknown` gives the stronger signature without an `any`,
 * and without a dependency on which version of the library is in use.
 */
interface ModifiableSelection {
  modify(alter: string, direction: string, granularity: string): void;
}

const modifiable = (
  selection: Selection,
): Option.Option<ModifiableSelection> => {
  const candidate = selection as unknown as Partial<ModifiableSelection>;
  return typeof candidate.modify === "function"
    ? Option.some(candidate as ModifiableSelection)
    : Option.none();
};

export const canModify = (selection: Selection): boolean =>
  Option.isSome(modifiable(selection));

const modify = (
  selection: Selection,
  alter: AlterMethod,
  direction: Direction,
  granularity: Exclude<Granularity, "vimword">,
): void => {
  const target = modifiable(selection);
  if (Option.isSome(target)) target.value.modify(alter, direction, granularity);
};

/**
 * Run one movement, `count` times.
 *
 * The `word` motions are built by hand, and they must stay that way. The native
 * `word` granularity means "to the end of the word" on macOS, and "to the start
 * of the next word" on Windows and on Linux. `w` and `e` can therefore not both
 * be one native call on any one platform. Building them from the primitives —
 * forward, forward, back — gives the meaning of Vim everywhere, and that is
 * what upstream does.
 */
export const runMovement = (
  selection: Selection,
  alter: AlterMethod,
  spec: MovementSpec,
  count = 1,
): void => {
  for (let iteration = 0; iteration < Math.max(1, count); iteration++) {
    if (spec.granularity === "vimword") {
      if (spec.direction === "forward") {
        // Over the end of this word, over the end of the next one, then back to
        // the start of that word: the `w` of Vim.
        modify(selection, alter, "forward", "word");
        modify(selection, alter, "forward", "word");
        modify(selection, alter, "backward", "word");
      } else {
        // A backward `word` already lands on the start of a word, which is the
        // `b` of Vim.
        modify(selection, alter, "backward", "word");
      }
      continue;
    }
    modify(selection, alter, spec.direction, spec.granularity);
  }
};

// ---------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------

/**
 * Which end of the selection holds the focus, found by a probe.
 *
 * Extend one character forward, see whether the selection grew or became
 * smaller, then undo it. Upstream does this instead of comparing the positions
 * of the anchor and the focus, because those are *retargeted* across a shadow
 * boundary, and because `anchorNode` and `focusNode` say nothing useful when
 * the selection covers a table or a run of text in the other direction.
 *
 * The undo is always a backward extend: an extend forward moves the focus one
 * character forward, whichever end it was at.
 */
export const getDirection = (selection: Selection): Direction => {
  const before = selection.toString().length;
  const target = modifiable(selection);
  if (Option.isNone(target)) return "forward";

  target.value.modify("extend", "forward", "character");
  const after = selection.toString().length;

  // No change means that we are against the end of the document. Nothing
  // moved, so there is nothing to undo.
  if (after === before) return "forward";

  target.value.modify("extend", "backward", "character");
  return after > before ? "forward" : "backward";
};

/** Exchange the anchor and the focus, and keep the text. The `o` of Vim. */
export const reverseSelection = (selection: Selection): void => {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (anchorNode === null || focusNode === null) return;
  try {
    selection.setBaseAndExtent(
      focusNode,
      focusOffset,
      anchorNode,
      anchorOffset,
    );
  } catch {
    // The two boundaries are in different trees. Safari refuses, and the
    // selection stays as it is.
  }
};

export const collapseToAnchor = (selection: Selection): void => {
  const { anchorNode, anchorOffset } = selection;
  if (anchorNode === null) return;
  try {
    selection.collapse(anchorNode, anchorOffset);
  } catch {
    // The node was removed between the read and the write.
  }
};

/**
 * Collapse onto the focus end.
 *
 * This is the end to keep when visual mode hands over to caret mode. The focus
 * is where the cursor of the user is, and the anchor is where they started.
 */
export const collapseToFocus = (selection: Selection): void => {
  const { focusNode, focusOffset } = selection;
  if (focusNode === null) return;
  try {
    selection.collapse(focusNode, focusOffset);
  } catch {
    // The node was removed between the read and the write.
  }
};

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
  modify(selection, "extend", "forward", "character");
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
  for (const step of [direction, opposite(direction)]) {
    runMovement(selection, "extend", {
      direction: step,
      granularity: "lineboundary",
    });
    reverseSelection(selection);
  }
};

// ---------------------------------------------------------------------------
// A point, mapped to a caret
// ---------------------------------------------------------------------------

export interface CaretPoint {
  readonly node: Node;
  readonly offset: number;
}

interface CaretCapableDocument {
  caretPositionFromPoint?: (
    x: number,
    y: number,
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

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
 * The DOM library that we compile against does not declare either member in a
 * dependable way, which is the reason for the narrowing through `unknown`. The
 * capability report decides, so that one probe answers for the whole
 * application.
 */
export const caretAtPoint = (
  document: Document,
  capabilities: CapabilityReport,
  x: number,
  y: number,
): Option.Option<CaretPoint> => {
  const doc = document as unknown as CaretCapableDocument;

  if (
    capabilities.caretPositionFromPoint &&
    typeof doc.caretPositionFromPoint === "function"
  ) {
    const position = doc.caretPositionFromPoint(x, y);
    return position === null || position === undefined ? Option.none() : Option
      .some({ node: position.offsetNode, offset: position.offset });
  }

  if (
    capabilities.caretRangeFromPoint &&
    typeof doc.caretRangeFromPoint === "function"
  ) {
    const range = doc.caretRangeFromPoint(x, y);
    return range === null
      ? Option.none()
      : Option.some({ node: range.startContainer, offset: range.startOffset });
  }

  return Option.none();
};

// ---------------------------------------------------------------------------
// Selection reads that see into a shadow root
// ---------------------------------------------------------------------------

interface ComposedRangeCapableSelection {
  getComposedRanges(
    options?: { shadowRoots?: ReadonlyArray<ShadowRoot> },
  ): ReadonlyArray<{
    startContainer: Node;
    startOffset: number;
    endContainer: Node;
    endOffset: number;
  }>;
}

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
): Option.Option<SelectionBoundaries> => {
  if (capabilities.composedRanges) {
    const composed = composedBoundaries(selection);
    if (Option.isSome(composed)) return composed;
  }

  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (anchorNode === null || focusNode === null) return Option.none();
  return Option.some({
    start: { node: anchorNode, offset: anchorOffset },
    end: { node: focusNode, offset: focusOffset },
    collapsed: selection.isCollapsed,
  });
};

const composedBoundaries = (
  selection: Selection,
): Option.Option<SelectionBoundaries> => {
  const capable = selection as unknown as Partial<
    ComposedRangeCapableSelection
  >;
  if (typeof capable.getComposedRanges !== "function") return Option.none();

  try {
    const roots = shadowRootsNear(selection);
    const ranges = capable.getComposedRanges(
      roots.length === 0 ? undefined : { shadowRoots: roots },
    );
    const range = ranges[0];
    if (range === undefined) return Option.none();
    return Option.some({
      start: { node: range.startContainer, offset: range.startOffset },
      end: { node: range.endContainer, offset: range.endOffset },
      collapsed: range.startContainer === range.endContainer &&
        range.startOffset === range.endOffset,
    });
  } catch {
    return Option.none();
  }
};

/**
 * Limited in depth.
 *
 * A deep tree of components must not make this walk quadratic.
 */
const MAX_SHADOW_DEPTH = 8;

const shadowRootsNear = (
  selection: Selection,
): ReadonlyArray<ShadowRoot> => {
  const roots: ShadowRoot[] = [];
  for (const node of [selection.anchorNode, selection.focusNode]) {
    let host: Element | null = node instanceof Element
      ? node
      : node?.parentElement ?? null;
    for (let depth = 0; host !== null && depth < MAX_SHADOW_DEPTH; depth++) {
      const shadow: ShadowRoot | null = host.shadowRoot;
      if (shadow === null) break;
      roots.push(shadow);
      // A retargeted anchor points at the host. Go down one level for each hop.
      const child: Element | null = shadow.firstElementChild;
      host = child;
    }
  }
  return roots;
};

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

/**
 * The first text node of the document that is large, drawn and not editable.
 *
 * Ported from the `mode_visual.js` of Vimium
 * (`Movement.selectLexicalEntity` and `establishInitialSelectionAnchor`).
 */
export const findCaretAnchor = (document: Document): Option.Option<Text> => {
  const body = document.body;
  if (body === null) return Option.none();

  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    const content = text.data;
    if (content.replace(/\s/g, "").length < CARET_ANCHOR_MIN_CHARACTERS) {
      continue;
    }

    const parent = text.parentElement;
    if (parent === null) continue;
    if (parent.isContentEditable) continue;
    // A rectangle, and not a computed style: this is one call for each
    // *candidate* node, of which there are a few, and it is the only check that
    // catches an ancestor that clips the node to no height.
    const rect = parent.getClientRects()[0];
    if (rect === undefined || rect.width === 0 || rect.height === 0) continue;

    return Option.some(text);
  }

  return Option.none();
};

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

/** The part of the viewport that the user sees. `Ui.viewport` gives it. */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

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
export const scrollSelectionIntoView = (
  selection: Selection,
  viewport: ViewportSize,
): void => {
  if (selection.rangeCount === 0) return;
  const range = selection.getRangeAt(selection.rangeCount - 1);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  if (
    rect.top >= 0 && rect.bottom <= viewport.height && rect.left >= 0 &&
    rect.right <= viewport.width
  ) {
    return;
  }

  const element = range.startContainer instanceof Element
    ? range.startContainer
    : range.startContainer.parentElement;
  element?.scrollIntoView({
    block: "nearest",
    inline: "nearest",
    behavior: "instant",
  });
};

/** The selected text. `Selection.toString()` is the only portable reader. */
export const selectionText = (selection: Selection): string =>
  selection.toString();
