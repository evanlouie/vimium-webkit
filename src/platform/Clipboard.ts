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

import { Boolean, Context, Effect, Layer, Option, Predicate, Schema, pipe } from "effect";
import { describeThrown } from "~/domain/Failure.ts";
import { whenSome } from "~/domain/Prelude.ts";
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

export class ClipboardError extends Schema.TaggedError<ClipboardError>()("ClipboardError", {
  reason: ClipboardFailureReason,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** The browser or the user refused a clipboard promise. */
const denied = (cause: unknown): ClipboardError =>
  new ClipboardError({ reason: "denied", detail: describeThrown(cause), cause });

// ---------------------------------------------------------------------------
// The bound browser accessors
// ---------------------------------------------------------------------------

export type ClipboardWriter = (text: string) => Promise<void>;
type ClipboardReader = () => Promise<string>;

/**
 * `navigator.clipboard.writeText`, already bound.
 *
 * Bound, and not given back in two pieces, because the caller must call it
 * synchronously from the key handler.
 *
 * This read can throw, because a userscript does not own its globals. Call it
 * inside `Dom.probeOrElse`.
 */
export const clipboardWriter = (
  window: Window & typeof globalThis,
): Option.Option<ClipboardWriter> =>
  pipe(
    window.navigator.clipboard,
    Option.fromNullishOr,
    Option.filter((clipboard) => typeof clipboard.writeText === "function"),
    Option.map((clipboard): ClipboardWriter => clipboard.writeText.bind(clipboard)),
  );

/** `navigator.clipboard.readText`, already bound. The same rules apply. */
const clipboardReader = (window: Window & typeof globalThis): Option.Option<ClipboardReader> =>
  pipe(
    window.navigator.clipboard,
    Option.fromNullishOr,
    Option.filter((clipboard) => typeof clipboard.readText === "function"),
    Option.map((clipboard): ClipboardReader => clipboard.readText.bind(clipboard)),
  );

// ---------------------------------------------------------------------------
// The `document.execCommand("copy")` path
// ---------------------------------------------------------------------------

/**
 * A text area that holds the text, off screen and not `display:none`.
 *
 * An element that is not rendered cannot be selected. `position:fixed` keeps
 * the focus call from scrolling the page.
 */
const offscreenArea = (doc: Document, text: string): HTMLTextAreaElement => {
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;" +
    "border:0;opacity:0;pointer-events:none;";
  doc.body.appendChild(area);
  return area;
};

/** Give the focus back. The page can have removed the element in the meantime. */
const restoreFocus = (previous: Element | null): Effect.Effect<void> =>
  pipe(
    previous,
    Option.liftPredicate((element) => element instanceof HTMLElement),
    whenSome((element) =>
      pipe(
        Effect.try(() => element.focus({ preventScroll: true })),
        Effect.ignore,
      ),
    ),
  );

/**
 * Copy through a selected text area.
 *
 * Still necessary, because `navigator.clipboard` is `undefined` on an insecure
 * origin. The area is removed, and the focus given back, whatever the copy
 * gives.
 */
const execCommandCopy = (doc: Document, text: string): Effect.Effect<void, ClipboardError> => {
  const acquire = Effect.sync(() => {
    const previous = doc.activeElement;
    return { previous, area: offscreenArea(doc, text) };
  });
  return Effect.acquireUseRelease(
    acquire,
    ({ area }) =>
      pipe(
        Effect.try({
          try: () => {
            area.select();
            area.setSelectionRange(0, text.length);
            return doc.execCommand("copy");
          },
          catch: (cause) =>
            new ClipboardError({ reason: "failed", detail: describeThrown(cause), cause }),
        }),
        Effect.flatMap(
          Boolean.match({
            onFalse: () =>
              Effect.fail(
                new ClipboardError({
                  reason: "failed",
                  detail: "document.execCommand('copy') gave false",
                }),
              ),
            onTrue: () => Effect.void,
          }),
        ),
      ),
    ({ area, previous }) =>
      pipe(
        Effect.sync(() => area.remove()),
        Effect.andThen(restoreFocus(previous)),
      ),
  );
};

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class Clipboard extends Context.Service<
  Clipboard,
  {
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
  }
>()("vimium/platform/Clipboard") {
  static readonly layer: Layer.Layer<Clipboard, never, Gm | Dom> = Layer.effect(
    Clipboard,
    Effect.gen(function* () {
      const gm = yield* Gm;
      const dom = yield* Dom;

      // The accessors are read once, when the layer is built. The key path
      // then holds plain values, and it does no global read of its own.
      const writer = yield* dom.probeOrElse(() => clipboardWriter(dom.window), Option.none);
      const reader = yield* dom.probeOrElse(() => clipboardReader(dom.window), Option.none);
      const execDocument = yield* dom.probeOrElse(
        () =>
          pipe(
            dom.document,
            Option.liftPredicate((doc) => Predicate.isFunction(Reflect.get(doc, "execCommand"))),
          ),
        Option.none,
      );

      /** The `document.execCommand("copy")` path. */
      const execCopy = (text: string): Effect.Effect<void, ClipboardError> =>
        pipe(
          execDocument,
          Effect.fromOption(
            () =>
              new ClipboardError({
                reason: "unavailable",
                detail: "document.execCommand is absent",
              }),
          ),
          Effect.flatMap((doc) => execCommandCopy(doc, text)),
        );

      /**
       * The `navigator.clipboard.writeText` path.
       *
       * `flatMap` does not suspend the fiber, so the promise starts in the same
       * synchronous task as the caller. Only the wait for the promise suspends,
       * and the activation is already spent by then.
       */
      const asyncCopy = (text: string): Effect.Effect<void, ClipboardError> =>
        pipe(
          writer,
          Effect.fromOption(
            () =>
              new ClipboardError({
                reason: "unavailable",
                detail: "navigator.clipboard.writeText is absent",
              }),
          ),
          Effect.flatMap((writeText) => {
            const started = writeText(text);
            return Effect.tryPromise({ try: () => started, catch: denied });
          }),
        );

      const write = (text: string): Effect.Effect<void, ClipboardError> =>
        // The manager write is first, and nothing goes in front of it. It is
        // `Effect.try`, it does not suspend, and it needs no activation.
        pipe(
          gm.setClipboard(text),
          Effect.catch(() => asyncCopy(text)),
          // The last try. The activation is spent if the asynchronous write
          // ran first, so this usually succeeds only on an insecure origin,
          // where the asynchronous API is absent and nothing suspended. The
          // reported error stays the one from the asynchronous write, because
          // that path is the only one that gives a true reason.
          Effect.catch((failure) =>
            pipe(
              execCopy(text),
              Effect.mapError(() => failure),
            ),
          ),
        );

      const read: Effect.Effect<string, ClipboardError> = pipe(
        reader,
        Effect.fromOption(
          () =>
            new ClipboardError({
              reason: "unavailable",
              detail: "navigator.clipboard.readText is absent",
            }),
        ),
        Effect.flatMap((readText) => Effect.tryPromise({ try: () => readText(), catch: denied })),
      );

      // Plain delegation, and not `Effect.fn`. The span costs about 3 µs for
      // each call, and nothing exports the spans in a release build. On the
      // key path that is cost with no result.
      return Clipboard.of({ write, read });
    }),
  );
}
