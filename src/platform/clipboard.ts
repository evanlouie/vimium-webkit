/**
 * Clipboard access (IMPLEMENTATION_PLAN.md §6.4).
 *
 * Vimium routes the clipboard through a same-origin extension iframe. A
 * userscript has no such thing, so we work directly against the page's
 * activation state — which on WebKit is *strict*: the transient-activation
 * window is well under a second and is consumed by the first `await`.
 *
 * The cardinal rule: **`writeText` must be reached synchronously from within
 * the `keydown` task.** Never `await` anything before calling into this module.
 */

import { Context, Duration, Effect, Layer, Schema } from "effect";
import { clipboardReader, clipboardWriter } from "./ambient.ts";
import { Gm, type GmSurface, setClipboard } from "./gm.ts";

export type ClipboardWriteMethod =
  | "async-clipboard"
  | "gm-set-clipboard"
  | "exec-command";

export const ClipboardFailureReason = Schema.Literals([
  "unavailable",
  "denied",
  "timeout",
  "empty",
  "failed",
]);

export type ClipboardFailureReason = typeof ClipboardFailureReason.Type;

export class ClipboardError
  extends Schema.TaggedErrorClass<ClipboardError>()("ClipboardError", {
    reason: ClipboardFailureReason,
    detail: Schema.String,
  })
{}

const clipboardError = (
  reason: ClipboardFailureReason,
  detail: string,
): ClipboardError => new ClipboardError({ reason, detail });

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export interface ClipboardWrite {
  /** Which path was taken, for the HUD confirmation message. */
  readonly method: ClipboardWriteMethod;
  /** Completes once the write is known to have succeeded or failed. */
  readonly settled: Effect.Effect<void, ClipboardError>;
}

/**
 * Legacy `document.execCommand("copy")` path.
 *
 * Still required, not merely nostalgic: `navigator.clipboard` is `undefined` on
 * insecure origins, and plenty of intranet and localhost pages are `http://`.
 */
const execCommandCopy = (text: string): Effect.Effect<void, ClipboardError> =>
  Effect.suspend(() => {
    const previous = document.activeElement;
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.setAttribute("aria-hidden", "true");
    // Off-screen rather than `display:none`: a non-rendered element cannot be
    // selected, and `position:fixed` avoids scrolling the page on focus.
    area.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;" +
      "opacity:0;pointer-events:none;";
    document.body.appendChild(area);

    try {
      area.select();
      area.setSelectionRange(0, text.length);
      const succeeded = document.execCommand("copy");
      return succeeded ? Effect.void : Effect.fail(
        clipboardError("failed", "document.execCommand('copy') returned false"),
      );
    } catch (cause) {
      return Effect.fail(
        clipboardError(
          "failed",
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
    } finally {
      area.remove();
      if (previous instanceof HTMLElement) {
        try {
          previous.focus({ preventScroll: true });
        } catch {
          // The page may have removed it in the meantime.
        }
      }
    }
  });

const gmCopy = (
  surface: GmSurface,
  text: string,
): Effect.Effect<void, ClipboardError> =>
  Effect.mapError(
    setClipboard(surface, text),
    (cause) =>
      clipboardError(
        cause.reason === "unavailable" ? "unavailable" : "failed",
        cause.detail,
      ),
  );

/**
 * Copy `text`. Call this synchronously from the key handler.
 *
 * The fallback chain is `navigator.clipboard.writeText` → `GM_setClipboard` →
 * `document.execCommand`. The first is preferred because it is the only one
 * that reports failure; the second because it does not need activation at all;
 * the third because it is the only one that works on `http://`.
 */
export const writeClipboard = (
  surface: GmSurface,
  text: string,
): Effect.Effect<ClipboardWrite, ClipboardError> =>
  Effect.suspend((): Effect.Effect<ClipboardWrite, ClipboardError> => {
    if (text.length === 0) {
      return Effect.fail(clipboardError("empty", "nothing to copy"));
    }

    const asyncWrite = clipboardWriter();
    if (asyncWrite !== null) {
      // Bound and invoked immediately. `Effect.suspend` does not yield, so the
      // call still happens inside the activation window; anything that
      // suspended before this point would have spent it.
      const promise = asyncWrite(text);
      return Effect.succeed<ClipboardWrite>({
        method: "async-clipboard",
        settled: Effect.tryPromise({
          try: () => promise,
          catch: (cause) => clipboardError("denied", describe(cause)),
        }).pipe(
          Effect.asVoid,
          // Activation was already spent by the time we get here, so the only
          // viable retry is the manager's, which does not need it.
          Effect.catch((denied) =>
            Effect.catch(gmCopy(surface, text), () => Effect.fail(denied))
          ),
        ),
      });
    }

    const viaGm: ClipboardWrite = {
      method: "gm-set-clipboard",
      settled: Effect.void,
    };
    const viaExec: ClipboardWrite = {
      method: "exec-command",
      settled: Effect.void,
    };

    return gmCopy(surface, text).pipe(
      Effect.as(viaGm),
      Effect.catch(() => execCommandCopy(text).pipe(Effect.as(viaExec))),
    );
  });

/** How long we wait for a clipboard read before falling back to the HUD input. */
export const CLIPBOARD_READ_DEADLINE_MS = 250;

/**
 * Attempt to read the clipboard.
 *
 * On WebKit this either shows a native paste affordance (a context menu on
 * macOS, the callout bar on iOS) or rejects outright, unless the clipboard
 * content was written by this same origin. That is unacceptable as the primary
 * path for a keyboard-driven tool, so callers must treat a failure here as
 * routine: `p`/`P` open a pre-focused HUD input and merely *try* to pre-fill it.
 */
export const readClipboard: Effect.Effect<string, ClipboardError> = Effect
  .suspend(() => {
    const read = clipboardReader();
    if (read === null) {
      return Effect.fail(
        clipboardError(
          "unavailable",
          "navigator.clipboard.readText is unavailable",
        ),
      );
    }

    return Effect.tryPromise({
      try: () => read(),
      catch: (cause) => clipboardError("denied", describe(cause)),
    }).pipe(
      Effect.timeout(Duration.millis(CLIPBOARD_READ_DEADLINE_MS)),
      Effect.catchTag(
        "TimeoutError",
        () =>
          Effect.fail(clipboardError("timeout", "clipboard read timed out")),
      ),
    );
  });

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * The clipboard, as a service.
 *
 * `write` keeps the property the free function has: nothing on its path
 * suspends, so a caller inside a `keydown` task can run it with `runSync` and
 * still be inside WebKit's transient-activation window.
 */
export class Clipboard extends Context.Service<Clipboard, {
  readonly write: (
    text: string,
  ) => Effect.Effect<ClipboardWrite, ClipboardError>;
  readonly read: Effect.Effect<string, ClipboardError>;
}>()("vimium/platform/Clipboard") {
  static readonly layer = Layer.effect(
    Clipboard,
    Effect.gen(function*() {
      const { surface } = yield* Gm;
      // Plain delegation, not `Effect.fn`. The span wrapper costs about 3 µs
      // per call and `runtime.ts` disables the tracer precisely because
      // nothing exports the spans — so on the keystroke path it would be pure
      // overhead around an effect that already exists.
      return Clipboard.of({
        write: (text) => writeClipboard(surface, text),
        read: readClipboard,
      });
    }),
  );
}
