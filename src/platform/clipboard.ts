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

import { err, ok, type Result } from "neverthrow";
import { type GmSurface, setClipboard } from "./gm.ts";
import { withDeadline } from "./scheduler.ts";

export type ClipboardWriteMethod =
  | "async-clipboard"
  | "gm-set-clipboard"
  | "exec-command";

export type ClipboardErrorKind =
  | "unavailable"
  | "denied"
  | "timeout"
  | "empty"
  | "failed";

export interface ClipboardError {
  readonly kind: ClipboardErrorKind;
  readonly message: string;
}

const clipboardError = (
  kind: ClipboardErrorKind,
  message: string,
): ClipboardError => ({ kind, message });

export interface ClipboardWrite {
  /** Which path was taken, for the HUD confirmation message. */
  readonly method: ClipboardWriteMethod;
  /** Resolves once the write is known to have succeeded or failed. */
  readonly settled: Promise<Result<void, ClipboardError>>;
}

/**
 * Legacy `document.execCommand("copy")` path.
 *
 * Still required, not merely nostalgic: `navigator.clipboard` is `undefined` on
 * insecure origins, and plenty of intranet and localhost pages are `http://`.
 */
const execCommandCopy = (text: string): Result<void, ClipboardError> => {
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
    return succeeded ? ok(undefined) : err(
      clipboardError("failed", "document.execCommand('copy') returned false"),
    );
  } catch (cause) {
    return err(
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
};

const gmCopy = (
  surface: GmSurface,
  text: string,
): Result<void, ClipboardError> =>
  setClipboard(surface, text).mapErr((cause) =>
    clipboardError(
      cause.kind === "unavailable" ? "unavailable" : "failed",
      cause.message,
    )
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
): Result<ClipboardWrite, ClipboardError> => {
  if (text.length === 0) {
    return err(clipboardError("empty", "nothing to copy"));
  }

  const asyncWrite = navigator.clipboard?.writeText;
  if (typeof asyncWrite === "function") {
    // Bound and invoked immediately — no `await` may intervene.
    const promise = asyncWrite.call(navigator.clipboard, text);
    return ok({
      method: "async-clipboard",
      settled: promise
        .then<Result<void, ClipboardError>>(() => ok(undefined))
        .catch((cause: unknown) => {
          // Activation was already spent by the time we get here, so the only
          // viable retry is the manager's, which does not require it.
          const viaGm = gmCopy(surface, text);
          if (viaGm.isOk()) return ok(undefined);
          return err(
            clipboardError(
              "denied",
              cause instanceof Error ? cause.message : String(cause),
            ),
          );
        }),
    });
  }

  const viaGm = gmCopy(surface, text);
  if (viaGm.isOk()) {
    return ok({
      method: "gm-set-clipboard",
      settled: Promise.resolve(ok(undefined)),
    });
  }

  const viaExec = execCommandCopy(text);
  if (viaExec.isOk()) {
    return ok({
      method: "exec-command",
      settled: Promise.resolve(ok(undefined)),
    });
  }
  return err(viaExec.error);
};

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
export const readClipboard = async (): Promise<
  Result<string, ClipboardError>
> => {
  const read = navigator.clipboard?.readText;
  if (typeof read !== "function") {
    return err(
      clipboardError(
        "unavailable",
        "navigator.clipboard.readText is unavailable",
      ),
    );
  }

  const attempt = read.call(navigator.clipboard)
    .then<Result<string, ClipboardError>>((text) => ok(text))
    .catch((cause: unknown) =>
      err(
        clipboardError(
          "denied",
          cause instanceof Error ? cause.message : String(cause),
        ),
      )
    );

  return await withDeadline(
    attempt,
    CLIPBOARD_READ_DEADLINE_MS,
    err(clipboardError("timeout", "clipboard read timed out")),
  );
};
