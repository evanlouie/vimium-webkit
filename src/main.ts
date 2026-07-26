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
import { startStage1 } from "./boot/stage1.ts";

const main = (): void => {
  let stage0: Stage0 | null = null;
  let starting = false;

  // Safe to close over `stage0`: activation is only ever reached from a timer
  // or an event listener, never synchronously from `bootStage0`.
  const activate = (): void => {
    if (starting || stage0 === null) return;
    starting = true;
    void startStage1(stage0).catch((cause: unknown) => {
      // Failing to boot must never break the page. Log once and stay out of the
      // way; Stage 0's remaining listeners are harmless.
      console.error("[vimium-webkit] failed to start", cause);
    });
  };

  // Returns `null` when this realm already has an instance — a manager
  // double-injection, or two copies of the script installed.
  stage0 = bootStage0({ onActivate: activate });
};

main();
