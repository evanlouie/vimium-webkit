/**
 * The HUD: a short message, the mode indicator and a one-line prompt.
 *
 * Upstream Vimium draws this in a `web_accessible_resources` iframe. We cannot,
 * so the input below is a *true in-page element* that takes part in the focus
 * of the page. Two results of that are designed for here:
 *
 * - `ownsFocus` exists so that insert mode can tell our input from an input of
 *   the page, and does not treat a focus of ours as an entry into insert mode.
 * - A listener of the page on `document` still sees a key press that is aimed
 *   at this input, retargeted to the shadow host. Without an iframe of our own
 *   origin there is no way to prevent that, and we accept it.
 *
 * Four rules hold this service together:
 *
 * 1. **The indicator is derived.** There is no `setIndicator`. A fiber here
 *    watches `Modes.indicator` and `Keyboard.pending`, and draws whichever one
 *    is present. The half-typed keys have priority.
 * 2. **A failure reaches the user through `Report`.** A fiber here reads
 *    `Report.messages` and draws each one. Nothing else calls the HUD to report
 *    a failure.
 * 3. **The auto-hide timer is a fiber, and not a timeout.** A new message
 *    interrupts the fiber that the message before it started.
 * 4. **The line is a live region.** The HUD layer stays in the accessibility
 *    tree, and the one line is a `role="status"` element. A live region must
 *    exist before its text changes, or the change is never announced.
 */

import {
  Context,
  Deferred,
  Effect,
  FiberHandle,
  Layer,
  Option,
  Ref,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { Keyboard } from "~/core/Keyboard.ts";
import { Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { Dom } from "~/platform/Dom.ts";
import { acceptPointerEvents, Ui } from "~/ui/Ui.ts";

/** How long a message from `show` stays on screen. The upstream value. */
export const DEFAULT_HUD_DURATION_MS = 2200;

/** An error stays twice as long, because it asks the user to act. */
export const ERROR_HUD_DURATION_MS = DEFAULT_HUD_DURATION_MS * 2;

export type HudTone = "info" | "error";

export interface HudPromptOptions<R = never> {
  /** The text in front of the field, for example `/`. */
  readonly label: string;
  /**
   * What assistive technology calls the field.
   *
   * The visible label is one or two characters, because the HUD is one line.
   * `/` is not a name that a screen reader can read out, so a prompt gives a
   * name in words here. It falls back to the visible label.
   */
  readonly ariaLabel?: string;
  readonly initialValue?: string;
  readonly placeholder?: string;
  /** Run for every change of the text. A new run interrupts the one before. */
  readonly onInput?: (value: string) => Effect.Effect<void, never, R>;
  /**
   * Run for every key press, before the prompt acts on it.
   *
   * `true` means "I took this key". The prompt then calls `preventDefault` and
   * does nothing more with it. This body must not suspend, because
   * `preventDefault` works only inside the dispatch of the browser.
   */
  readonly onKeydown?: (
    event: KeyboardEvent,
    value: string,
  ) => Effect.Effect<boolean, never, R>;
}

export interface HudLine {
  readonly text: string;
  readonly tone: HudTone;
}

/**
 * How urgently assistive technology reads the HUD line.
 *
 * An error asks the user to act, so it interrupts. Everything else waits for
 * a pause in the speech, because the HUD also carries the mode indicator and
 * the half-typed keys, and those change with every key press.
 */
export const liveUrgency = (
  line: Option.Option<HudLine>,
): "polite" | "assertive" =>
  Option.isSome(line) && line.value.tone === "error" ? "assertive" : "polite";

/** The live prompt, as the rest of the service sees it. */
interface LivePrompt {
  readonly id: number;
  /** The span to the right of the field. Find puts `3/17` there. */
  readonly status: HTMLElement;
  /** End the prompt with "the user cancelled". */
  readonly cancel: Effect.Effect<void>;
}

export interface HudState {
  /** A message from `show` or `error` that is still inside its timer. */
  readonly transient: Option.Option<HudLine>;
  /** The indicator of the innermost mode. */
  readonly indicator: Option.Option<string>;
  /** The half-typed key sequence. */
  readonly pending: Option.Option<string>;
  readonly prompt: Option.Option<LivePrompt>;
}

const EMPTY_STATE: HudState = {
  transient: Option.none(),
  indicator: Option.none(),
  pending: Option.none(),
  prompt: Option.none(),
};

/**
 * What the one line of the HUD says.
 *
 * A message has priority over the keys, and the keys have priority over the
 * indicator. A mode enters and exits in the same task that produced a message,
 * so an indicator that outranked the message would erase it before the user
 * could read it.
 */
export const visibleLine = (state: HudState): Option.Option<HudLine> => {
  if (Option.isSome(state.transient)) return state.transient;
  if (Option.isSome(state.pending)) {
    return Option.some({ text: state.pending.value, tone: "info" });
  }
  if (Option.isSome(state.indicator)) {
    return Option.some({ text: state.indicator.value, tone: "info" });
  }
  return Option.none();
};

/** What the status span beside an open prompt says. */
export const statusText = (state: HudState): string => {
  if (Option.isSome(state.pending)) return state.pending.value;
  return Option.getOrElse(state.indicator, () => "");
};

const asKeyboardEvent = (event: Event): Option.Option<KeyboardEvent> =>
  event instanceof KeyboardEvent ? Option.some(event) : Option.none();

/** Escape, and the `<c-[>` synonym that Vim and upstream Vimium accept. */
const cancelsPrompt = (event: KeyboardEvent): boolean =>
  event.key === "Escape" || (event.ctrlKey && event.key === "[");

export class Hud extends Context.Service<Hud, {
  readonly show: (text: string, durationMs?: number) => Effect.Effect<void>;
  readonly error: (text: string) => Effect.Effect<void>;
  readonly hide: Effect.Effect<void>;
  /** Ask the user for a line of text. `None` when the user cancels. */
  readonly prompt: <R>(
    options: HudPromptOptions<R>,
  ) => Effect.Effect<Option.Option<string>, never, R>;
  readonly ownsFocus: (target: EventTarget | null) => boolean;
}>()("vimium/ui/Hud") {
  static readonly layer: Layer.Layer<
    Hud,
    never,
    Ui | Dom | Settings | Modes | Keyboard | Report
  > = Layer.effect(
    Hud,
    Effect.gen(function*() {
      const ui = yield* Ui;
      const dom = yield* Dom;
      const settings = yield* Settings;
      const modes = yield* Modes;
      const keyboard = yield* Keyboard;
      const report = yield* Report;

      const doc = dom.document;
      const hudLayer = yield* ui.layer("hud");

      // The HUD layer stays in the accessibility tree for the whole session.
      // A live region must exist before its text changes, or the change is
      // never announced. The region is empty while the HUD says nothing, and
      // the other layers stay hidden, so this adds no noise for a user who
      // reads the page.
      yield* ui.expose(hudLayer);

      const element = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const div = doc.createElement("div");
          div.className = "vw-hud";
          div.dataset["visible"] = "false";
          div.dataset["tone"] = "info";
          hudLayer.appendChild(div);
          return div;
        }),
        (div) =>
          Effect.sync(() => {
            div.remove();
          }),
      );

      const textSpan = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const span = doc.createElement("span");
          // The one line of the HUD is a status message: a mode name, a
          // pending key sequence, a count, or a failure. `role="status"` names
          // it, and `aria-atomic` makes a reader speak the whole line instead
          // of the characters that changed.
          span.setAttribute("role", "status");
          span.setAttribute("aria-live", "polite");
          span.setAttribute("aria-atomic", "true");
          element.appendChild(span);
          return span;
        }),
        (span) =>
          Effect.sync(() => {
            span.remove();
          }),
      );

      const state = yield* Ref.make<HudState>(EMPTY_STATE);
      const nextPromptId = yield* Ref.make(0);
      const timer = yield* FiberHandle.make<void, never>();

      const render: Effect.Effect<void> = Effect.gen(function*() {
        const current = yield* Ref.get(state);
        // The host can be gone: a single-page application replaces the
        // document element, and a hostile page removes what it can name. A
        // message that nobody sees is worse than no message.
        yield* ui.ensureAttached;
        yield* Effect.sync(() => {
          if (Option.isSome(current.prompt)) {
            // The message slot sits beside the field, so an error that
            // arrives during a search stays on screen instead of vanishing.
            const line = current.transient;
            textSpan.setAttribute("aria-live", liveUrgency(line));
            textSpan.textContent = Option.isSome(line) ? line.value.text : "";
            element.dataset["tone"] = Option.isSome(line)
              ? line.value.tone
              : "info";
            element.dataset["visible"] = "true";
            current.prompt.value.status.textContent = statusText(current);
            return;
          }
          const line = visibleLine(current);
          textSpan.setAttribute("aria-live", liveUrgency(line));
          if (Option.isNone(line)) {
            element.dataset["visible"] = "false";
            // The live region keeps its place in the tree, and loses its text.
            // A region that still reads the last message would announce it
            // again at the next change.
            textSpan.textContent = "";
            return;
          }
          textSpan.textContent = line.value.text;
          element.dataset["tone"] = line.value.tone;
          element.dataset["visible"] = "true";
        });
      });

      const patch = (
        change: (current: HudState) => HudState,
      ): Effect.Effect<void> =>
        Effect.andThen(Ref.update(state, change), render);

      /**
       * Take the message away after `durationMs`.
       *
       * A fiber that sleeps, and not a timeout. The handle holds one fiber, so
       * a new message interrupts the one before it, and the layer scope
       * interrupts the last one.
       */
      const arm = Effect.fn("Hud.arm")(function*(durationMs: number) {
        if (durationMs <= 0) {
          yield* FiberHandle.clear(timer);
          return;
        }
        yield* FiberHandle.run(
          timer,
          Effect.andThen(
            Effect.sleep(durationMs),
            patch((current) => ({ ...current, transient: Option.none() })),
          ),
        );
      });

      const draw = Effect.fn("Hud.draw")(
        function*(line: HudLine, durationMs: number) {
          yield* patch((current) => ({
            ...current,
            transient: Option.some(line),
          }));
          yield* arm(durationMs);
        },
      );

      // `currentUnsafe`, because a command body reaches this from the key
      // path, and nothing on that path may suspend. Every other step of `show`
      // is a `Ref` write or a fork.
      const show = Effect.fn("Hud.show")(
        function*(text: string, durationMs: number = DEFAULT_HUD_DURATION_MS) {
          if (settings.currentUnsafe().hideHud) return;
          yield* draw({ text, tone: "info" }, durationMs);
        },
      );

      // An error ignores `hideHud`. A refused capability that says nothing is
      // the exact failure that `Report` exists to prevent.
      const error = (text: string): Effect.Effect<void> =>
        draw({ text, tone: "error" }, ERROR_HUD_DURATION_MS);

      const hide = Effect.gen(function*() {
        const current = yield* Ref.get(state);
        // A prompt owns the line. Hiding it would leave a modal that has the
        // keyboard and no place on screen.
        if (Option.isSome(current.prompt)) return;
        yield* FiberHandle.clear(timer);
        yield* patch((one) => ({ ...one, transient: Option.none() }));
      });

      // ---------------------------------------------------------------
      // Derived state
      // ---------------------------------------------------------------

      yield* Effect.forkScoped(
        Stream.runForEach(
          SubscriptionRef.changes(modes.indicator),
          (value) =>
            patch((current) => ({
              ...current,
              indicator: Option.fromNullishOr(value),
            })),
        ),
      );

      yield* Effect.forkScoped(
        Stream.runForEach(
          SubscriptionRef.changes(keyboard.pending),
          (value) =>
            patch((current) => ({
              ...current,
              pending: Option.fromNullishOr(value),
            })),
        ),
      );

      // The one route from a failure to the user. A storage failure, a
      // clipboard refusal and a command failure all arrive here.
      yield* Effect.forkScoped(
        Stream.runForEach(
          report.messages,
          (message) =>
            message.level === "error"
              ? error(message.text)
              : show(message.text),
        ),
      );

      // ---------------------------------------------------------------
      // The prompt
      // ---------------------------------------------------------------

      const promptIn = <R>(
        options: HudPromptOptions<R>,
      ): Effect.Effect<Option.Option<string>, never, R | Scope.Scope> =>
        Effect.gen(function*() {
          const done = yield* Deferred.make<Option.Option<string>>();
          const settle = (
            value: Option.Option<string>,
          ): Effect.Effect<void> =>
            Effect.asVoid(Deferred.succeed(done, value));

          // A second prompt replaces the first one. Each prompt owns its own
          // container, so the removal of the old one cannot take the new one
          // with it.
          const previous = (yield* Ref.get(state)).prompt;
          if (Option.isSome(previous)) yield* previous.value.cancel;
          yield* FiberHandle.clear(timer);

          const id = yield* Ref.modify(nextPromptId, (n) => [n, n + 1]);

          const parts = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const container = doc.createElement("span");
              // A group with a name, so that a reader says what the field
              // belongs to before it reads the field itself.
              container.setAttribute("role", "group");

              const label = doc.createElement("span");
              label.className = "vw-hud-label";
              label.textContent = options.label;
              // The visible label is one character, and the field carries the
              // same name in words. A reader that spoke both would say the
              // punctuation twice.
              label.setAttribute("aria-hidden", "true");

              const input = doc.createElement("input");
              input.className = "vw-hud-input";
              input.type = "text";
              input.value = options.initialValue ?? "";
              input.placeholder = options.placeholder ?? "";
              // Every autofill and correction aid harms a command line, and
              // iOS turns all of them on by default.
              input.autocapitalize = "off";
              input.autocomplete = "off";
              input.spellcheck = false;
              input.setAttribute("autocorrect", "off");

              const status = doc.createElement("span");
              status.className = "vw-hud-count";
              // The status beside the field: the mode indicator, or the
              // half-typed keys. The id is unique in this shadow root, and the
              // description makes a reader say the status after the value of
              // the field.
              const statusId = `vw-hud-status-${id}`;
              status.id = statusId;
              status.setAttribute("aria-live", "polite");
              status.setAttribute("aria-atomic", "true");

              const name = options.ariaLabel ?? options.label;
              container.setAttribute("aria-label", name);
              input.setAttribute("aria-label", name);
              input.setAttribute("aria-describedby", statusId);

              container.append(label, input, status);
              element.appendChild(container);
              return { container, input, status };
            }),
            (built) =>
              Effect.sync(() => {
                built.container.remove();
              }),
          );

          // The HUD layer must take pointer events while the prompt is live,
          // so that a click into the field does not fall through to the page.
          yield* acceptPointerEvents(hudLayer);

          yield* patch((current) => ({
            ...current,
            prompt: Option.some({
              id,
              status: parts.status,
              cancel: settle(Option.none()),
            }),
          }));

          yield* Effect.addFinalizer(() =>
            patch((current) =>
              Option.isSome(current.prompt) && current.prompt.value.id === id
                ? {
                  ...current,
                  transient: Option.none(),
                  prompt: Option.none(),
                }
                : current
            )
          );

          const inputFiber = yield* FiberHandle.make<void, never>();

          if (options.onInput !== undefined) {
            const onInput = options.onInput;
            yield* dom.listenOn(parts.input, "input", () =>
              // Forked, because a body such as the live search of find can
              // suspend. A newer keystroke interrupts the older search.
              Effect.asVoid(
                FiberHandle.run(inputFiber, onInput(parts.input.value)),
              ));
          }

          // The capture phase, and `stopPropagation` for every key: the prompt
          // owns the keyboard while it is open, and the handler stack must not
          // see these events at all.
          yield* dom.listenOn(
            parts.input,
            "keydown",
            (event) =>
              Effect.gen(function*() {
                event.stopPropagation();
                const key = asKeyboardEvent(event);
                if (Option.isNone(key)) return;
                if (options.onKeydown !== undefined) {
                  const taken = yield* options.onKeydown(
                    key.value,
                    parts.input.value,
                  );
                  if (taken) {
                    event.preventDefault();
                    return;
                  }
                }
                if (key.value.key === "Enter") {
                  event.preventDefault();
                  yield* settle(Option.some(parts.input.value));
                  return;
                }
                if (cancelsPrompt(key.value)) {
                  event.preventDefault();
                  yield* settle(Option.none());
                }
              }),
            { capture: true },
          );

          yield* dom.listenOn(parts.input, "blur", () =>
            // The page or the user moved on. Treat it as a cancel, and do not
            // leave an invisible modal that holds the keyboard.
            settle(Option.none()));

          yield* Effect.sync(() => {
            // `preventScroll` matters. Without it the page scrolls to the
            // overlay, which sits at the bottom of the viewport.
            parts.input.focus({ preventScroll: true });
            parts.input.setSelectionRange(
              parts.input.value.length,
              parts.input.value.length,
            );
          });

          return yield* Deferred.await(done);
        });

      const prompt = <R>(
        options: HudPromptOptions<R>,
      ): Effect.Effect<Option.Option<string>, never, R> =>
        Effect.scoped(promptIn(options));

      return Hud.of({
        show,
        error,
        hide,
        prompt,
        /**
         * Does this target belong to the overlay?
         *
         * Given to the UI root, which knows about the retargeting of a closed
         * shadow root. It is wider than "the prompt has focus" on purpose:
         * every caller asks the same question. Insert mode must not claim a
         * field of ours, and every modal mode must know whether a key press
         * was aimed at its own input or at the page.
         */
        ownsFocus: (target) => ui.owns(target),
      });
    }),
  );
}
