/**
 * The clipboard, as a service.
 *
 * Vimium sends the clipboard through a same-origin extension iframe. A
 * userscript has no such frame, so this module works against the activation
 * state of the page itself. WebKit is strict about that state: the transient
 * activation window is much shorter than one second, and the first suspension
 * spends it.
 *
 * The rule for `write`: nothing on its path may suspend. A caller inside a
 * `keydown` task runs it with `runSyncExit`, and it must still be inside the
 * activation window when the first real write happens. Read `ARCHITECTURE.md`
 * section 3 before you change anything here.
 *
 * The order of the write path follows from that rule:
 *
 * 1. `Gm.setClipboard`. It is `Effect.try`, so it does not suspend, and it does
 *    not need activation at all. It is therefore the only candidate that is
 *    safe to put first, and nothing may go before it.
 * 2. `navigator.clipboard.writeText`. It is the only path that reports its own
 *    failure, but it gives a promise, so it suspends. The promise is started
 *    synchronously, inside the recovery, and only the wait suspends.
 * 3. `document.execCommand("copy")`. It is the only path that works on an
 *    insecure origin, and many intranet and localhost pages are `http://`,
 *    where `navigator.clipboard` is `undefined`.
 */

import { Context, Effect, Layer, Predicate, Schema } from "effect";
import { Dom } from "~/platform/Dom.ts";
import { Gm } from "~/platform/Gm.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ClipboardFailureReason = Schema.Literals([
  /** No clipboard path exists in this realm. */
  "unavailable",
  /** A path exists, and the browser or the user refused it. */
  "denied",
  /** A path exists, and it failed. */
  "failed",
]);

export type ClipboardFailureReason = typeof ClipboardFailureReason.Type;

export class ClipboardError
  extends Schema.TaggedErrorClass<ClipboardError>()("ClipboardError", {
    reason: ClipboardFailureReason,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  })
{}

const clipboardError = (
  reason: ClipboardFailureReason,
  detail: string,
  cause?: unknown,
): ClipboardError =>
  new ClipboardError({
    reason,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const describe = (cause: unknown): string => {
  if (Predicate.isError(cause)) return cause.message;
  if (Predicate.isString(cause)) return cause;
  return String(cause);
};

// ---------------------------------------------------------------------------
// The bound browser accessors
// ---------------------------------------------------------------------------

export type ClipboardWriter = (text: string) => Promise<void>;
export type ClipboardReader = () => Promise<string>;

/**
 * `navigator.clipboard.writeText`, already bound.
 *
 * Bound, and not given back in two pieces, because the caller must call it
 * synchronously from the key handler.
 *
 * This read can throw, because a userscript does not own its globals. Call it
 * inside `Dom.probeOr`.
 */
export const clipboardWriter = (
  window: Window & typeof globalThis,
): ClipboardWriter | null => {
  const clipboard: unknown = window.navigator.clipboard;
  if (!Predicate.hasProperty(clipboard, "writeText")) return null;
  const write: unknown = Reflect.get(clipboard, "writeText");
  if (!Predicate.isFunction(write)) return null;
  const call = write as (this: unknown, text: string) => Promise<void>;
  return (text) => Reflect.apply(call, clipboard, [text]);
};

/** `navigator.clipboard.readText`, already bound. The same rules apply. */
export const clipboardReader = (
  window: Window & typeof globalThis,
): ClipboardReader | null => {
  const clipboard: unknown = window.navigator.clipboard;
  if (!Predicate.hasProperty(clipboard, "readText")) return null;
  const read: unknown = Reflect.get(clipboard, "readText");
  if (!Predicate.isFunction(read)) return null;
  const call = read as (this: unknown) => Promise<string>;
  return () => Reflect.apply(call, clipboard, []);
};

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Clipboard extends Context.Service<Clipboard, {
  /**
   * Write text.
   *
   * This must stay synchronous up to the first attempt. Do not put an effect
   * that suspends in front of the manager write.
   */
  readonly write: (text: string) => Effect.Effect<void, ClipboardError>;

  /**
   * Read the clipboard.
   *
   * On WebKit this either shows a native paste control or fails, unless the
   * same origin wrote the text. Treat a failure as normal: `p` and `P` open a
   * HUD input, and they only try to fill it first. Put a deadline on the read
   * at the call site with `Effect.timeoutTo`.
   */
  readonly read: Effect.Effect<string, ClipboardError>;

  readonly canRead: boolean;
  readonly canWrite: boolean;
}>()("vimium/platform/Clipboard") {
  static readonly layer: Layer.Layer<Clipboard, never, Gm | Dom> = Layer.effect(
    Clipboard,
    Effect.gen(function*() {
      const gm = yield* Gm;
      const dom = yield* Dom;

      // The accessors are read once, when the layer is built. The key path
      // then holds two plain values, and it does no global read of its own.
      const writer = yield* dom.probeOr(
        () => clipboardWriter(dom.window),
        null,
      );
      const reader = yield* dom.probeOr(
        () => clipboardReader(dom.window),
        null,
      );
      const canExec = yield* dom.probeOr(() => {
        const exec: unknown = Reflect.get(dom.document, "execCommand");
        return Predicate.isFunction(exec);
      }, false);

      /**
       * The `document.execCommand("copy")` path.
       *
       * Still necessary, because `navigator.clipboard` is `undefined` on an
       * insecure origin. The element is off screen and not `display:none`,
       * because an element that is not rendered cannot be selected.
       * `position:fixed` keeps the focus call from scrolling the page.
       */
      const execCommandCopy = (
        text: string,
      ): Effect.Effect<void, ClipboardError> =>
        Effect.suspend(() => {
          if (!canExec) {
            return Effect.fail(
              clipboardError("unavailable", "document.execCommand is absent"),
            );
          }
          const doc = dom.document;
          const previous = doc.activeElement;
          const area = doc.createElement("textarea");
          area.value = text;
          area.setAttribute("readonly", "");
          area.setAttribute("aria-hidden", "true");
          area.style.cssText =
            "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;" +
            "border:0;opacity:0;pointer-events:none;";
          doc.body.appendChild(area);

          try {
            area.select();
            area.setSelectionRange(0, text.length);
            const copied = doc.execCommand("copy");
            return copied ? Effect.void : Effect.fail(
              clipboardError(
                "failed",
                "document.execCommand('copy') gave false",
              ),
            );
          } catch (cause) {
            return Effect.fail(
              clipboardError("failed", describe(cause), cause),
            );
          } finally {
            area.remove();
            if (previous instanceof HTMLElement) {
              try {
                previous.focus({ preventScroll: true });
              } catch {
                // The page can have removed the element in the meantime.
              }
            }
          }
        });

      /**
       * The `navigator.clipboard.writeText` path.
       *
       * `Effect.suspend` does not suspend the fiber, so the promise starts in
       * the same synchronous task as the caller. Only the wait for the promise
       * suspends, and the activation is already spent by then.
       */
      const asyncCopy = (text: string): Effect.Effect<void, ClipboardError> =>
        Effect.suspend(() => {
          if (writer === null) {
            return Effect.fail(
              clipboardError(
                "unavailable",
                "navigator.clipboard.writeText is absent",
              ),
            );
          }
          const started = writer(text);
          return Effect.tryPromise({
            try: () => started,
            catch: (cause) => clipboardError("denied", describe(cause), cause),
          }).pipe(Effect.asVoid);
        });

      const write = (text: string): Effect.Effect<void, ClipboardError> =>
        // The manager write is first, and nothing goes in front of it. It is
        // `Effect.try`, it does not suspend, and it needs no activation.
        gm.setClipboard(text).pipe(
          Effect.mapError((cause) =>
            clipboardError(
              cause.reason === "unavailable" ? "unavailable" : "failed",
              cause.detail,
              cause,
            )
          ),
          Effect.catch(() => asyncCopy(text)),
          // The last try. The activation is spent if the asynchronous write
          // ran first, so this usually succeeds only on an insecure origin,
          // where the asynchronous API is absent and nothing suspended. The
          // reported error stays the one from the asynchronous write, because
          // that path is the only one that gives a true reason.
          Effect.catch((denied) =>
            Effect.mapError(execCommandCopy(text), () => denied)
          ),
        );

      const read: Effect.Effect<string, ClipboardError> = Effect.suspend(() => {
        if (reader === null) {
          return Effect.fail(
            clipboardError(
              "unavailable",
              "navigator.clipboard.readText is absent",
            ),
          );
        }
        return Effect.tryPromise({
          try: () => reader(),
          catch: (cause) => clipboardError("denied", describe(cause), cause),
        });
      });

      // Plain delegation, and not `Effect.fn`. The span costs about 3 µs for
      // each call, and nothing exports the spans in a release build. On the
      // key path that is cost with no result.
      return Clipboard.of({
        write,
        read,
        canRead: reader !== null,
        canWrite: gm.canSetClipboard || writer !== null || canExec,
      });
    }),
  );
}
