/**
 * Entry point.
 *
 * The whole extension is one IIFE — a userscript cannot code-split, because
 * dynamic `import()` of a `blob:` or `data:` URL is exactly what a page's CSP
 * blocks. "Lazy" therefore means *lazily invoked*, not lazily fetched: Stage 1
 * and every feature sit behind a function that is only called when needed, so
 * engines pay a cheap pre-parse rather than a full compile for code that never
 * runs (§5.5).
 */

import { bootStage0, type Stage0 } from "./boot/stage0.ts";
import { type Stage1, startStage1 } from "./boot/stage1.ts";

const main = (): void => {
  let stage0: Stage0 | null = null;
  let stage1: Stage1 | null = null;
  let starting = false;

  // Safe to close over `stage0`: activation is only ever reached from a timer
  // or an event listener, never synchronously from `bootStage0`.
  const activate = (): void => {
    if (starting || stage0 === null) return;
    starting = true;
    startStage1(stage0)
      .then((started) => {
        stage1 = started;
      })
      .catch((cause: unknown) => {
        // Failing to boot must never break the page. Log once and stay out of
        // the way; Stage 0's remaining listeners are harmless.
        console.error("[vimium-webkit] failed to start", cause);
      });
  };

  /**
   * The page is going away for good.
   *
   * `Stage1.dispose()` had no production caller at all: roughly twenty
   * listeners, a shadow root, a `MutationObserver`, an interval and the frame
   * ports were structurally unreleasable. `persisted` is the whole reason this
   * is not unconditional — a page entering the back/forward cache comes back
   * with its scripts *not* re-run, so tearing down there would leave a dead
   * extension in a live page.
   *
   * Stage 0 deliberately survives. It is five listeners and a boolean, it
   * re-arms itself on `pageshow`, and disposing it leaves the realm's
   * double-injection guard set with nothing behind it — so a frame that
   * navigates from `about:blank` to its real document gets no Stage 0 at all.
   */
  const teardown = (persisted: boolean): void => {
    if (persisted) return;
    stage1?.dispose();
    stage1 = null;
  };

  // Returns `null` when this realm already has an instance — a manager
  // double-injection, or two copies of the script installed.
  stage0 = bootStage0({ onActivate: activate, onTeardown: teardown });
};

main();
