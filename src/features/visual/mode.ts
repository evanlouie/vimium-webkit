/**
 * Visual, visual-line and caret modes.
 *
 * Ported from Vimium's `content_scripts/mode_visual.js` (MIT). The three modes
 * are one implementation parameterised by two flags:
 *
 * | mode        | `alterMethod` | line-wise |
 * | ----------- | ------------- | --------- |
 * | visual      | `"extend"`    | no        |
 * | visual line | `"extend"`    | yes       |
 * | caret       | `"move"`      | no        |
 *
 * `alterMethod` really is the entire semantic difference between visual and
 * caret mode: `"extend"` drags the focus and pins the anchor, `"move"` drags
 * both.
 */

import type { AppContext } from "~/core/context.ts";
import type { Handler, HandlerResult } from "~/core/handler-stack.ts";
import { SUPPRESS_EVENT } from "~/core/handler-stack.ts";
import { isComposing, keyNotation } from "~/core/key-notation.ts";
import { type ExitReason, Mode } from "~/core/mode.ts";
import { writeClipboard } from "~/platform/clipboard.ts";
import {
  type AlterMethod,
  canModify,
  collapseToAnchor,
  collapseToFocus,
  extendByOneCharacter,
  findCaretAnchor,
  getDirection,
  MOVEMENTS,
  type MovementSpec,
  opposite,
  readBoundaries,
  reverseSelection,
  runMovement,
  scrollSelectionIntoView,
  selectionText,
} from "./movement.ts";

export type VisualKind = "visual" | "visual-line" | "caret";

const INDICATORS: Readonly<Record<VisualKind, string>> = {
  "visual": "Visual",
  "visual-line": "Visual line",
  "caret": "Caret",
};

/**
 * WebKit will not hand a page the clipboard contents outside its own paste
 * affordance, and there is no gesture a userscript can synthesise that changes
 * that. Saying so beats a key that silently does nothing.
 */
const PASTE_EXPLANATION =
  "Paste is unavailable: WebKit only releases clipboard contents through its " +
  "own paste affordance. Use ⌘V (Ctrl+V).";

export interface VisualModeConfig {
  readonly app: AppContext;
  /** Re-enter as a different kind; `v`, `V` and `c` all route through this. */
  readonly switchTo: (kind: VisualKind) => void;
}

export class VisualMode extends Mode {
  readonly #app: AppContext;
  readonly #kind: VisualKind;
  readonly #alter: AlterMethod;
  readonly #lineWise: boolean;
  readonly #switchTo: (kind: VisualKind) => void;

  #count = "";
  #pendingG = false;

  constructor(config: VisualModeConfig, kind: VisualKind = "visual") {
    super(config.app.modeHost, {
      name: kind,
      indicator: INDICATORS[kind],
      exitOnEscape: true,
      // The selection modes own the keyboard outright: an unhandled key must
      // not reach the page, or `j` scrolls out from under the selection.
      suppressAllKeyboardEvents: true,
      singleton: "visual",
    });

    this.#app = config.app;
    this.#kind = kind;
    this.#alter = kind === "caret" ? "move" : "extend";
    this.#lineWise = kind === "visual-line";
    this.#switchTo = config.switchTo;

    this.onExit((reason) => this.#onExit(reason));
  }

  get kind(): VisualKind {
    return this.#kind;
  }

  /**
   * Establish the initial selection. Call immediately after `enter()`.
   *
   * An existing selection is adopted rather than replaced — which is what makes
   * `v` after a find, or after a drag with the mouse, do the obvious thing.
   */
  start(): void {
    const selection = globalThis.getSelection();
    if (selection === null || !canModify(selection)) {
      this.#app.hud.error("Text selection is not available in this frame.");
      this.exit("explicit");
      return;
    }

    if (selection.rangeCount === 0 || selection.anchorNode === null) {
      const anchor = findCaretAnchor();
      if (anchor === null) {
        this.#app.hud.show("No text on this page to select.");
        this.exit("explicit");
        return;
      }
      try {
        selection.setBaseAndExtent(anchor, 0, anchor, 0);
      } catch {
        this.#app.hud.error("Could not place the caret on this page.");
        this.exit("explicit");
        return;
      }
    }

    // Caret mode never inherits a range: `c` from visual mode collapses onto
    // the end the user was steering.
    if (this.#alter === "move") collapseToFocus(selection);

    // `isCollapsed` lies when the selection lives wholly inside an open shadow
    // root: both boundaries retarget to the same host node. The composed read
    // is the only one that can tell the difference — and
    // `ShadowRoot.getSelection()`, the trick everyone reaches for first, is not
    // implemented in Safari at all.
    const boundaries = readBoundaries(selection, this.#app.caps);
    const collapsed = boundaries?.collapsed ?? selection.isCollapsed;

    // A collapsed selection renders as nothing in a non-editable page: there is
    // no page caret to inherit, so caret mode has to draw one out of a
    // one-character selection.
    if (collapsed) extendByOneCharacter(selection);
    if (this.#lineWise) this.#extendToLines(selection);
    scrollSelectionIntoView(selection);
  }

  protected override handlers(): Omit<Handler, "name"> {
    return { keydown: (event) => this.#onKeydown(event) };
  }

  // -- keys ------------------------------------------------------------------

  #onKeydown(event: KeyboardEvent): HandlerResult {
    // Mid-composition keystrokes belong to the IME, not to us.
    if (isComposing(event)) return SUPPRESS_EVENT;

    const notation = keyNotation(
      event,
      this.#app.settings().ignoreKeyboardLayout,
    );
    if (notation === null) return SUPPRESS_EVENT;

    this.#handle(notation);
    return SUPPRESS_EVENT;
  }

  #handle(notation: string): void {
    if (this.#pendingG) {
      this.#pendingG = false;
      if (notation === "g") {
        this.#runMotion(MOVEMENTS.get("gg"));
        return;
      }
      // Fall through: `gj` is not a binding, but `g` followed by a real motion
      // should still perform that motion rather than being swallowed.
    }

    if (/^[1-9]$/.test(notation) || (notation === "0" && this.#count !== "")) {
      // Vim's rule: `0` is a motion, except while a count is being typed.
      this.#count += notation;
      return;
    }

    if (notation === "g") {
      this.#pendingG = true;
      return;
    }

    const movement = MOVEMENTS.get(notation);
    if (movement !== undefined) {
      this.#runMotion(movement);
      return;
    }

    switch (notation) {
      case "y":
        this.#yank();
        return;
      case "o":
        this.#swapEnds();
        return;
      case "c":
        this.#count = "";
        this.#switchTo("caret");
        return;
      case "v":
        this.#count = "";
        this.#switchTo("visual");
        return;
      case "V":
        this.#count = "";
        this.#switchTo("visual-line");
        return;
      case "p":
      case "P":
        this.#count = "";
        this.#app.hud.show(PASTE_EXPLANATION, 4000);
        return;
      default:
        this.#count = "";
        return;
    }
  }

  #takeCount(): number {
    const parsed = Number.parseInt(this.#count, 10);
    this.#count = "";
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  // -- motions ---------------------------------------------------------------

  #runMotion(spec: MovementSpec | undefined): void {
    const count = this.#takeCount();
    if (spec === undefined) return;

    const selection = globalThis.getSelection();
    if (selection === null) return;

    if (this.#alter === "move") {
      // Caret mode: fold the one-character display selection away first, so the
      // move starts from the caret rather than from its far end.
      collapseToAnchor(selection);
      runMovement(selection, "move", spec, count);
      extendByOneCharacter(selection);
    } else {
      runMovement(selection, "extend", spec, count);
      if (this.#lineWise) this.#extendToLines(selection);
    }

    scrollSelectionIntoView(selection);
  }

  /**
   * Round the selection out to whole lines.
   *
   * Ported verbatim in shape from upstream's `VisualLineMode.extendSelection`:
   * extend to the line boundary at the focus end, flip, extend again, flip
   * back. The two reversals leave the original direction intact, which matters
   * because the next `j` has to keep growing rather than start shrinking.
   */
  #extendToLines(selection: Selection): void {
    const direction = getDirection(selection);
    for (const step of [direction, opposite(direction)]) {
      runMovement(selection, "extend", {
        direction: step,
        granularity: "lineboundary",
      });
      reverseSelection(selection);
    }
  }

  #swapEnds(): void {
    this.#count = "";
    const selection = globalThis.getSelection();
    if (selection === null) return;
    reverseSelection(selection);
    scrollSelectionIntoView(selection);
  }

  // -- yank ------------------------------------------------------------------

  /**
   * `y`: copy the selection and leave.
   *
   * `writeClipboard` is reached **synchronously** from inside the keydown task.
   * Nothing may be awaited before it: WebKit's transient activation window is
   * short and is consumed by the first `await`, after which
   * `navigator.clipboard.writeText` rejects.
   */
  #yank(): void {
    this.#count = "";
    const selection = globalThis.getSelection();
    const text = selection === null ? "" : selectionText(selection);

    if (text.length === 0) {
      this.#app.hud.show("Nothing to copy");
      this.exit("explicit");
      return;
    }

    const started = writeClipboard(this.#app.gm, text);
    if (started.isErr()) {
      this.#app.hud.error(`Copy failed: ${started.error.message}`);
      this.exit("explicit");
      return;
    }

    this.#app.hud.show(
      `Yanked ${text.length} character${text.length === 1 ? "" : "s"}`,
    );
    void started.value.settled.then((result) => {
      if (result.isErr()) {
        this.#app.hud.error(`Copy failed: ${result.error.message}`);
      }
    });

    this.exit("explicit");
  }

  // -- teardown --------------------------------------------------------------

  #onExit(reason: ExitReason): void {
    // A `singleton` exit means `v`/`V`/`c` is handing over to a sibling mode;
    // the selection is the state being handed over and must survive.
    if (reason === "singleton") return;
    const selection = globalThis.getSelection();
    try {
      selection?.removeAllRanges();
    } catch {
      // Nothing to do; the page owns the selection again either way.
    }
  }
}

/** Visual mode, line-wise. `alterMethod` is still `"extend"`. */
export class VisualLineMode extends VisualMode {
  constructor(config: VisualModeConfig) {
    super(config, "visual-line");
  }
}

/** Caret mode: identical to visual mode but with `alterMethod: "move"`. */
export class CaretMode extends VisualMode {
  constructor(config: VisualModeConfig) {
    super(config, "caret");
  }
}
