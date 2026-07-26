/**
 * Selection primitives for visual and caret mode.
 *
 * Ported from Vimium's `content_scripts/mode_visual.js` (the `Movement` object),
 * MIT. This is the one subsystem that ports almost unchanged: `Selection.modify()`
 * is a *WebKit-originated* API, shipped in Safari 1.3, and everything the
 * upstream implementation relies on has been there longer than Vimium has.
 *
 * The only genuinely WebKit-specific work is at the bottom of the file:
 * `ShadowRoot.getSelection()` does not exist in Safari, and
 * `caretPositionFromPoint` only landed in Safari 26.2.
 */

import type { Capabilities } from "~/platform/capabilities.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * `"extend"` for visual mode, `"move"` for caret mode.
 *
 * That single flag is the entire semantic difference between the two modes:
 * one drags the focus and leaves the anchor, the other drags both.
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
  /** Not native: Vim's `w`, composed from `word` primitives below. */
  | "vimword";

export interface MovementSpec {
  readonly direction: Direction;
  readonly granularity: Granularity;
}

export const opposite = (direction: Direction): Direction =>
  direction === "forward" ? "backward" : "forward";

/**
 * Vimium's motion table, unchanged.
 *
 * `gg` is keyed as the two-character sequence; the mode is responsible for
 * accumulating it.
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
 * `Selection.modify` is not in every DOM lib we compile against, and the ones
 * that do declare it type the arguments as bare `string`. Narrowing through
 * `unknown` gives us the stronger signature without an `any` and without
 * depending on which lib version is in play.
 */
interface ModifiableSelection {
  modify(alter: string, direction: string, granularity: string): void;
}

const modifiable = (selection: Selection): ModifiableSelection | null => {
  const candidate = selection as unknown as Partial<ModifiableSelection>;
  return typeof candidate.modify === "function"
    ? (candidate as ModifiableSelection)
    : null;
};

export const canModify = (selection: Selection): boolean =>
  modifiable(selection) !== null;

const modify = (
  selection: Selection,
  alter: AlterMethod,
  direction: Direction,
  granularity: Exclude<Granularity, "vimword">,
): void => {
  modifiable(selection)?.modify(alter, direction, granularity);
};

/**
 * Run one movement, `count` times.
 *
 * The `word` motions are hand-rolled rather than delegated, and they must stay
 * that way. Native `word` granularity means "to the end of the word" on macOS
 * and "to the start of the next word" on Windows and Linux, so `w` and `e`
 * cannot both be a single native call on any one platform. Composing them from
 * primitives — forward, forward, back — gives Vim's semantics everywhere,
 * which is exactly what upstream does.
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
        // Over the end of this word, over the end of the next, then back to
        // that word's start: Vim's `w`.
        modify(selection, alter, "forward", "word");
        modify(selection, alter, "forward", "word");
        modify(selection, alter, "backward", "word");
      } else {
        // Backward `word` already lands on a word start, which is Vim's `b`.
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
 * Which end of the selection the focus is at, by empirical probe.
 *
 * Extend one character forward and see whether the selection grew or shrank,
 * then undo. Upstream does this rather than comparing anchor and focus
 * positions because those are *retargeted* across a shadow boundary, and
 * because `anchorNode`/`focusNode` say nothing useful when the selection spans
 * a table or a bidi run.
 *
 * The undo is always a backward extend: extending forward moves the focus
 * forward one character regardless of which end it was at.
 */
export const getDirection = (selection: Selection): Direction => {
  const before = selection.toString().length;
  const modifier = modifiable(selection);
  if (modifier === null) return "forward";

  modifier.modify("extend", "forward", "character");
  const after = selection.toString().length;

  // No change means we are pinned against the end of the document; nothing was
  // moved, so there is nothing to undo.
  if (after === before) return "forward";

  modifier.modify("extend", "backward", "character");
  return after > before ? "forward" : "backward";
};

/** Swap anchor and focus, preserving the selected text. Vim's `o`. */
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
    // Boundaries in different trees; Safari declines and the selection stands.
  }
};

export const collapseToAnchor = (selection: Selection): void => {
  const { anchorNode, anchorOffset } = selection;
  if (anchorNode === null) return;
  try {
    selection.collapse(anchorNode, anchorOffset);
  } catch {
    // Node removed between the read and the write.
  }
};

/**
 * Collapse onto the focus end.
 *
 * This is the right end to keep when visual mode hands over to caret mode: the
 * focus is where the user's cursor visually is, the anchor is where they
 * started.
 */
export const collapseToFocus = (selection: Selection): void => {
  const { focusNode, focusOffset } = selection;
  if (focusNode === null) return;
  try {
    selection.collapse(focusNode, focusOffset);
  } catch {
    // Node removed between the read and the write.
  }
};

/**
 * Grow the selection one character forward, so caret mode has something to show.
 *
 * A collapsed selection renders as nothing at all inside a non-editable page —
 * there is no page caret to inherit. Upstream solves this by keeping a
 * one-character selection alive, which doubles as the block cursor.
 */
export const extendByOneCharacter = (selection: Selection): number => {
  const before = selection.toString().length;
  modify(selection, "extend", "forward", "character");
  return selection.toString().length - before;
};

// ---------------------------------------------------------------------------
// Point → caret
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
 * Convert viewport coordinates to a caret position.
 *
 * The entry point for placing the caret from a pointer position rather than
 * from the document order.
 *
 * The feature-detection order is **inverted** relative to the usual advice.
 * Everyone tells you to prefer the standard `caretPositionFromPoint` and fall
 * back to the WebKit-legacy `caretRangeFromPoint` — but the standard one only
 * landed in Safari 26.2, while the legacy one has been there since Safari 5.
 * The order below therefore still prefers the standard API when it exists, and
 * simply does not treat its absence as exotic.
 *
 * The DOM lib we compile against does not reliably declare either member, hence
 * the narrowing through `unknown`.
 */
export const caretAtPoint = (x: number, y: number): CaretPoint | null => {
  const doc = document as unknown as CaretCapableDocument;

  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    return position === null || position === undefined
      ? null
      : { node: position.offsetNode, offset: position.offset };
  }

  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    return range === null
      ? null
      : { node: range.startContainer, offset: range.startOffset };
  }

  return null;
};

// ---------------------------------------------------------------------------
// Shadow-aware selection reads
// ---------------------------------------------------------------------------

interface ComposedRangeCapableSelection {
  getComposedRanges(
    options?: { shadowRoots?: readonly ShadowRoot[] },
  ): readonly {
    startContainer: Node;
    startOffset: number;
    endContainer: Node;
    endOffset: number;
  }[];
}

export interface SelectionBoundaries {
  readonly start: CaretPoint;
  readonly end: CaretPoint;
  readonly collapsed: boolean;
}

/**
 * Read the selection's real boundaries, piercing open shadow roots.
 *
 * `ShadowRoot.getSelection()` is **not implemented in Safari**, so the
 * Chromium-era trick of asking the shadow root for its own selection is not
 * available. `Selection.getComposedRanges()` (Safari 17+) is the replacement,
 * gated on `caps.composedRanges`.
 *
 * It only pierces roots it is explicitly handed, and we do not have a list of
 * every root on the page. The heuristic below is that retargeting is *visible*:
 * when the selection reports an anchor that is itself a shadow host, the real
 * boundary is inside that host's root, so that root (and its nested roots) is
 * what we pass. Everything else falls back to the plain, non-shadow read.
 */
export const readBoundaries = (
  selection: Selection,
  caps: Capabilities,
): SelectionBoundaries | null => {
  if (caps.composedRanges) {
    const composed = composedBoundaries(selection);
    if (composed !== null) return composed;
  }

  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (anchorNode === null || focusNode === null) return null;
  return {
    start: { node: anchorNode, offset: anchorOffset },
    end: { node: focusNode, offset: focusOffset },
    collapsed: selection.isCollapsed,
  };
};

const composedBoundaries = (
  selection: Selection,
): SelectionBoundaries | null => {
  const capable = selection as unknown as Partial<
    ComposedRangeCapableSelection
  >;
  if (typeof capable.getComposedRanges !== "function") return null;

  try {
    const roots = shadowRootsNear(selection);
    const ranges = capable.getComposedRanges(
      roots.length === 0 ? undefined : { shadowRoots: roots },
    );
    const range = ranges[0];
    if (range === undefined) return null;
    return {
      start: { node: range.startContainer, offset: range.startOffset },
      end: { node: range.endContainer, offset: range.endOffset },
      collapsed: range.startContainer === range.endContainer &&
        range.startOffset === range.endOffset,
    };
  } catch {
    return null;
  }
};

/** Depth-limited so a deeply nested component tree cannot make this quadratic. */
const MAX_SHADOW_DEPTH = 8;

const shadowRootsNear = (selection: Selection): readonly ShadowRoot[] => {
  const roots: ShadowRoot[] = [];
  for (const node of [selection.anchorNode, selection.focusNode]) {
    let host: Element | null = node instanceof Element
      ? node
      : node?.parentElement ?? null;
    for (let depth = 0; host !== null && depth < MAX_SHADOW_DEPTH; depth++) {
      const shadow: ShadowRoot | null = host.shadowRoot;
      if (shadow === null) break;
      roots.push(shadow);
      // A retargeted anchor points at the host; descend one level per hop.
      const child: Element | null = shadow.firstElementChild;
      host = child;
    }
  }
  return roots;
};

// ---------------------------------------------------------------------------
// Caret-mode anchor
// ---------------------------------------------------------------------------

/**
 * How much text a node needs before it is worth putting the caret in it.
 *
 * Upstream's number. Below this you land in a nav link or a cookie banner,
 * which is never where a user pressing `v` on an article wants to start.
 */
export const CARET_ANCHOR_MIN_CHARACTERS = 50;

/**
 * The first substantial, visible, non-editable text node in the document.
 *
 * Ported from Vimium's `mode_visual.js` (`Movement.selectLexicalEntity` /
 * `establishInitialSelectionAnchor`).
 */
export const findCaretAnchor = (): Text | null => {
  const body = document.body;
  if (body === null) return null;

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
    // A rect, not a computed style: this is one call per *candidate* node, of
    // which there are a handful, and it is the only check that catches a
    // zero-height clipping ancestor.
    const rect = parent.getClientRects()[0];
    if (rect === undefined || rect.width === 0 || rect.height === 0) continue;

    return text;
  }

  return null;
};

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

/**
 * Keep the focus end of the selection on screen.
 *
 * `behavior: "instant"` deliberately: Safari's smooth scrolling cannot be
 * cancelled, so a held-down `j` would queue animation the user cannot interrupt.
 */
export const scrollSelectionIntoView = (selection: Selection): void => {
  if (selection.rangeCount === 0) return;
  const range = selection.getRangeAt(selection.rangeCount - 1);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  const height = globalThis.innerHeight;
  const width = globalThis.innerWidth;
  if (
    rect.top >= 0 && rect.bottom <= height && rect.left >= 0 &&
    rect.right <= width
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
