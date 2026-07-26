/**
 * The visual/caret subsystem (IMPLEMENTATION_PLAN.md §6.10).
 *
 * The safest subsystem on WebKit, and the one that needed the least work:
 * `Selection.modify()` originated in WebKit and has shipped since Safari 1.3,
 * so the upstream Vimium implementation ports almost unchanged. The only real
 * WebKit accommodations live in `movement.ts`.
 */

import type { AppContext, VisualApi } from "~/core/context.ts";
import {
  CaretMode,
  type VisualKind,
  VisualLineMode,
  VisualMode,
} from "./mode.ts";

export type { VisualKind } from "./mode.ts";
export { CaretMode, VisualLineMode, VisualMode } from "./mode.ts";
export type {
  AlterMethod,
  CaretPoint,
  Direction,
  Granularity,
  MovementSpec,
  SelectionBoundaries,
} from "./movement.ts";
export {
  CARET_ANCHOR_MIN_CHARACTERS,
  caretAtPoint,
  collapseToFocus,
  findCaretAnchor,
  getDirection,
  MOVEMENTS,
  opposite,
  readBoundaries,
  reverseSelection,
  runMovement,
} from "./movement.ts";

export const createVisual = (app: AppContext): VisualApi => {
  const enter = (kind: VisualKind): void => {
    if (!app.caps.selectionModify) {
      // Every capability that is `false` gets a user-visible explanation; this
      // one should be unreachable on any WebKit build we target.
      app.hud.error(
        "Selection.modify() is unavailable, so visual mode cannot run here.",
      );
      return;
    }

    const config = { app, switchTo: enter };
    const mode = kind === "caret"
      ? new CaretMode(config)
      : kind === "visual-line"
      ? new VisualLineMode(config)
      : new VisualMode(config);

    // `enter()` evicts any sibling through the shared `visual` singleton, which
    // is what makes `v` → `V` → `c` a hand-off rather than a stack.
    mode.enter();
    mode.start();
  };

  return {
    enterVisual: (): void => enter("visual"),
    enterVisualLine: (): void => enter("visual-line"),
    enterCaret: (): void => enter("caret"),
  };
};
