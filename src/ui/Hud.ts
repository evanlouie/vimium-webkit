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
 * 4. **The line is two live regions.** The HUD layer stays in the
 *    accessibility tree, and the one line is drawn into a `role="status"`
 *    region or a `role="alert"` region. A live region must exist before its
 *    text changes, or the change is never announced. Its politeness must not
 *    change either, because several readers keep the politeness that the
 *    region had when it entered the tree.
 */

import {
  Boolean,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  FiberHandle,
  Layer,
  Match,
  Option,
  Ref,
  type Scope,
  Stream,
  pipe,
  Struct,
} from "effect";
import { constVoid } from "effect/Function";
import { Keyboard } from "~/core/Keyboard.ts";
import { isEscape, Modes } from "~/core/Modes.ts";
import { Report, type UserMessage } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import { Dom } from "~/platform/Dom.ts";
import { acceptPointerEvents, Ui } from "~/ui/Ui.ts";

/** How long a message from `show` stays on screen. The upstream value. */
export const DEFAULT_HUD_DURATION_MS = 2200;

/** An error stays twice as long, because it asks the user to act. */
export const ERROR_HUD_DURATION_MS = DEFAULT_HUD_DURATION_MS * 2;

/** How long a message stays on screen. */
export type HudDuration = Data.TaggedEnum<{
  /** The message goes after `duration`. */
  Transient: { readonly duration: Duration.Duration };
  /** The message stays until the next one replaces it. For a live status. */
  Sticky: Record<never, never>;
}>;
export const HudDuration = Data.taggedEnum<HudDuration>();

/** The upstream duration of a message. */
export const BRIEFLY: HudDuration = HudDuration.Transient({
  duration: Duration.millis(DEFAULT_HUD_DURATION_MS),
});

/** The duration of an error. */
const AS_AN_ERROR: HudDuration = HudDuration.Transient({
  duration: Duration.millis(ERROR_HUD_DURATION_MS),
});

export type HudTone = "info" | "error";

/** What the caller of a prompt says about one key press. */
export type KeyClaim = Data.TaggedEnum<{
  /** The caller took the key. The prompt calls `preventDefault` and does nothing more with it. */
  Taken: Record<never, never>;
  /** The prompt acts on the key: Enter submits, Escape cancels, and the field takes the rest. */
  Pass: Record<never, never>;
}>;
export const KeyClaim = Data.taggedEnum<KeyClaim>();

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
   * The claim says whether the caller took the key. This body must not
   * suspend, because `preventDefault` works only inside the dispatch of the
   * browser.
   */
  readonly onKeydown?: (event: KeyboardEvent, value: string) => Effect.Effect<KeyClaim, never, R>;
}

export interface HudLine {
  readonly text: string;
  readonly tone: HudTone;
}

/** The text of the two live regions. */
interface RegionText {
  readonly polite: string;
  readonly urgent: string;
}

/** Both regions say nothing. */
const SILENT: RegionText = { polite: "", urgent: "" };

/** The region that fits the tone of one line gets the text. */
const regionsFor = pipe(
  Match.type<HudLine>(),
  Match.when({ tone: "error" }, ({ text }): RegionText => ({ polite: "", urgent: text })),
  Match.when({ tone: "info" }, ({ text }): RegionText => ({ polite: text, urgent: "" })),
  Match.exhaustive,
);

/**
 * What each of the two live regions says.
 *
 * An error asks the user to act, so it goes to the assertive region and
 * interrupts. Everything else goes to the polite region and waits for a pause
 * in the speech, because the HUD also carries the mode indicator and the
 * half-typed keys, and those change with every key press.
 *
 * The other region is always cleared. A region that kept the last text would
 * hold two lines on screen, and a reader would say the older one again at the
 * next change.
 */
export const regionText: (line: Option.Option<HudLine>) => RegionText = Option.match({
  onNone: () => SILENT,
  onSome: regionsFor,
});

/** The live prompt, as the rest of the service sees it. */
interface LivePrompt {
  readonly id: number;
  /** The span to the right of the field. Find puts `3/17` there. */
  readonly status: HTMLElement;
  /** End the prompt with "the user cancelled". */
  readonly cancel: Effect.Effect<void>;
}

export interface HudState {
  /** A message that is still inside its timer. */
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

/** The half-typed keys, or else the indicator of the mode. The keys have priority. */
const keysOrMode = (state: HudState): Option.Option<string> =>
  pipe(
    state.pending,
    Option.orElse(() => state.indicator),
  );

const infoLine = (text: string): HudLine => ({ text, tone: "info" });

/**
 * What the one line of the HUD says.
 *
 * A message has priority over the keys, and the keys have priority over the
 * indicator. A mode enters and exits in the same task that produced a message,
 * so an indicator that outranked the message would erase it before the user
 * could read it.
 */
export const visibleLine = (state: HudState): Option.Option<HudLine> =>
  pipe(
    state.transient,
    Option.orElse(() => pipe(keysOrMode(state), Option.map(infoLine))),
  );

/** What the status span beside an open prompt says. */
export const statusText = (state: HudState): string =>
  pipe(
    keysOrMode(state),
    Option.getOrElse(() => ""),
  );

/** The message is over. */
const withoutMessage: (current: HudState) => HudState = Struct.assign({
  transient: Option.none(),
});

/**
 * The prompt `id` is over.
 *
 * A newer prompt may already own the line, and then nothing changes: the old
 * prompt must not take the new one with it.
 */
const withoutPrompt =
  (id: number) =>
  (current: HudState): HudState =>
    pipe(
      current.prompt,
      Option.filter((live) => live.id === id),
      Option.match({
        onNone: () => current,
        onSome: () =>
          pipe(current, Struct.assign({ transient: Option.none(), prompt: Option.none() })),
      }),
    );

/** What the HUD element shows for one state. */
type HudFrame = Data.TaggedEnum<{
  /**
   * A prompt is open, so the HUD stays on screen.
   *
   * The message slot sits beside the field, so an error that arrives during a
   * search stays on screen instead of vanishing.
   */
  Prompting: {
    readonly message: Option.Option<HudLine>;
    /** The span beside the field, and what it says. */
    readonly status: HTMLElement;
    readonly statusLine: string;
  };
  /** One line, and no prompt. */
  Showing: { readonly line: HudLine };
  /** Nothing to say. */
  Hidden: Record<never, never>;
}>;
const HudFrame = Data.taggedEnum<HudFrame>();

/** What the HUD shows for this state. */
const hudFrame = (state: HudState): HudFrame =>
  pipe(
    state.prompt,
    Option.match({
      onSome: ({ status }) =>
        HudFrame.Prompting({ message: state.transient, status, statusLine: statusText(state) }),
      onNone: () =>
        pipe(
          visibleLine(state),
          Option.match({
            onNone: () => HudFrame.Hidden(),
            onSome: (line) => HudFrame.Showing({ line }),
          }),
        ),
    }),
  );

/** What a key press does to an open prompt. */
type PromptKey = Data.TaggedEnum<{
  /** The caller took the key, so the prompt only stops its default action. */
  Taken: Record<never, never>;
  /** Enter ends the prompt with the text. */
  Submit: Record<never, never>;
  /** Escape ends the prompt with "the user cancelled". */
  Cancel: Record<never, never>;
  /** Any other key belongs to the field. */
  Pass: Record<never, never>;
}>;
const PromptKey = Data.taggedEnum<PromptKey>();

const asKeyboardEvent: (event: Event) => Option.Option<KeyboardEvent> = Option.liftPredicate(
  (event: Event): event is KeyboardEvent => event instanceof KeyboardEvent,
);

/** What a key that the caller did not take does to the prompt. */
const promptKey = (event: KeyboardEvent): PromptKey =>
  pipe(
    Match.value(event),
    Match.when({ key: "Enter" }, () => PromptKey.Submit()),
    // Escape, and the `<c-[>` synonym that every mode accepts.
    Match.when(isEscape, () => PromptKey.Cancel()),
    Match.orElse(() => PromptKey.Pass()),
  );

/**
 * Does the focus of `selection` rest on `host`: beside it, or inside it?
 *
 * A point in a shadow tree reads as a point at its host, so a caret in our own
 * input reads as a caret beside our host.
 */
const restsOn =
  (host: Element) =>
  (selection: Selection): boolean =>
    pipe(
      selection.focusNode,
      Option.fromNullishOr,
      Option.exists((node) => {
        const around = host.ownerDocument.createRange();
        around.selectNode(host);
        return around.isPointInRange(node, selection.focusOffset);
      }),
    );

/** Make `saved` the whole selection. `None` leaves no selection at all. */
const selectOnly = (target: Selection, saved: Option.Option<Range>): void => {
  target.removeAllRanges();
  pipe(
    saved,
    Option.match({
      onNone: constVoid,
      onSome: (range) => target.addRange(range),
    }),
  );
};

export class Hud extends Context.Service<
  Hud,
  {
    /** Show a message for `duration`. */
    readonly show: (text: string, duration: HudDuration) => Effect.Effect<void>;
    readonly hide: Effect.Effect<void>;
    /** Ask the user for a line of text. `None` when the user cancels. */
    readonly prompt: <R>(
      options: HudPromptOptions<R>,
    ) => Effect.Effect<Option.Option<string>, never, R>;
    readonly ownsFocus: (target: EventTarget | null) => boolean;
  }
>()("vimium/ui/Hud") {
  static readonly layer: Layer.Layer<Hud, never, Ui | Dom | Settings | Modes | Keyboard | Report> =
    Layer.effect(
      Hud,
      Effect.gen(function* () {
        const ui = yield* Ui;
        const dom = yield* Dom;
        const settings = yield* Settings;
        const modes = yield* Modes;
        const keyboard = yield* Keyboard;
        const report = yield* Report;

        const doc = dom.document;
        const win = dom.window;
        const hudLayer = yield* ui.layer("hud");

        // The HUD layer stays in the accessibility tree for the whole session.
        // A live region must exist before its text changes, or the change is
        // never announced. Both regions are empty while the HUD says nothing,
        // and the other layers stay hidden, so this adds no noise for a user who
        // reads the page. The host therefore keeps `aria-hidden` off from here
        // to the end of the session.
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

        const regions = yield* Effect.acquireRelease(
          Effect.sync(() => {
            // Two regions, built once, and never changed again. The one line of
            // the HUD is a status message: a mode name, a pending key sequence,
            // a count, or a failure. A reader keeps the politeness that a region
            // had when it entered the tree, so a region whose `aria-live`
            // changed with its text could speak an error politely, or not at
            // all. `aria-atomic` makes a reader speak the whole line instead of
            // the characters that changed.
            const make = (role: string, urgency: string): HTMLSpanElement => {
              const span = doc.createElement("span");
              span.setAttribute("role", role);
              span.setAttribute("aria-live", urgency);
              span.setAttribute("aria-atomic", "true");
              element.appendChild(span);
              return span;
            };
            return {
              polite: make("status", "polite"),
              urgent: make("alert", "assertive"),
            };
          }),
          (built) =>
            Effect.sync(() => {
              built.polite.remove();
              built.urgent.remove();
            }),
        );

        /** Put the line in the region that fits its tone, and clear the other. */
        const writeLine = (line: Option.Option<HudLine>): void => {
          const text = regionText(line);
          regions.polite.textContent = text.polite;
          regions.urgent.textContent = text.urgent;
        };

        /** Draw one frame. A hidden HUD keeps its tone while it fades out. */
        const paint = HudFrame.$match({
          Prompting: ({ message, status, statusLine }) => {
            writeLine(message);
            element.dataset["tone"] = pipe(
              message,
              Option.map((line) => line.tone),
              Option.getOrElse(() => "info"),
            );
            element.dataset["visible"] = "true";
            status.textContent = statusLine;
          },
          Showing: ({ line }) => {
            writeLine(Option.some(line));
            element.dataset["tone"] = line.tone;
            element.dataset["visible"] = "true";
          },
          Hidden: () => {
            writeLine(Option.none());
            element.dataset["visible"] = "false";
          },
        });

        const state = yield* Ref.make<HudState>(EMPTY_STATE);
        const nextPromptId = yield* Ref.make(0);
        const timer = yield* FiberHandle.make<void, never>();

        const render: Effect.Effect<void> = Effect.gen(function* () {
          const current = yield* Ref.get(state);
          // The host can be gone: a single-page application replaces the
          // document element, and a hostile page removes what it can name. A
          // message that nobody sees is worse than no message.
          yield* ui.ensureAttached;
          yield* Effect.sync(() => paint(hudFrame(current)));
        });

        const patch = (change: (current: HudState) => HudState): Effect.Effect<void> =>
          pipe(state, Ref.update(change), Effect.andThen(render));

        /**
         * Take the message away when its duration is over.
         *
         * A fiber that sleeps, and not a timeout. The handle holds one fiber, so
         * a new message interrupts the one before it, and the layer scope
         * interrupts the last one. A sticky message keeps no fiber, and stays
         * until the next one replaces it.
         */
        const arm = Effect.fn("Hud.arm")(function* (duration: HudDuration) {
          yield* pipe(
            duration,
            HudDuration.$match({
              Transient: ({ duration: shown }) =>
                pipe(
                  Effect.sleep(shown),
                  Effect.andThen(patch(withoutMessage)),
                  FiberHandle.run(timer),
                ),
              Sticky: () => FiberHandle.clear(timer),
            }),
          );
        });

        const draw = Effect.fn("Hud.draw")(function* (line: HudLine, duration: HudDuration) {
          yield* patch(Struct.assign({ transient: Option.some(line) }));
          yield* arm(duration);
        });

        // `currentUnsafe`, because a command body reaches this from the key
        // path, and nothing on that path may suspend. Every other step of `show`
        // is a `Ref` write or a fork.
        const show = Effect.fn("Hud.show")(function* (text: string, duration: HudDuration) {
          yield* pipe(
            settings.currentUnsafe().hideHud,
            Boolean.match({
              onFalse: () => draw(infoLine(text), duration),
              onTrue: () => Effect.void,
            }),
          );
        });

        // An error ignores `hideHud`. A refused capability that says nothing is
        // the exact failure that `Report` exists to prevent.
        const error = (text: string): Effect.Effect<void> =>
          draw({ text, tone: "error" }, AS_AN_ERROR);

        const clearMessage = pipe(FiberHandle.clear(timer), Effect.andThen(patch(withoutMessage)));

        const hide = pipe(
          Ref.get(state),
          Effect.flatMap(({ prompt }) =>
            pipe(
              prompt,
              Option.match({
                // A prompt owns the line. Hiding it would leave a modal that has
                // the keyboard and no place on screen.
                onSome: () => Effect.void,
                onNone: () => clearMessage,
              }),
            ),
          ),
        );

        // ---------------------------------------------------------------
        // Derived state
        // ---------------------------------------------------------------

        yield* pipe(
          modes.indicator.changes,
          Stream.runForEach((indicator) => patch(Struct.assign({ indicator }))),
          Effect.forkScoped,
        );

        yield* pipe(
          keyboard.pending.changes,
          Stream.runForEach((pending) => patch(Struct.assign({ pending }))),
          Effect.forkScoped,
        );

        /** Draw one message of `Report` in the tone of its level. */
        const deliver = pipe(
          Match.type<UserMessage>(),
          Match.when({ level: "error" }, ({ text }) => error(text)),
          Match.when({ level: "info" }, ({ text }) => show(text, BRIEFLY)),
          Match.exhaustive,
        );

        // The one route from a failure to the user. A storage failure, a
        // clipboard refusal and a command failure all arrive here.
        yield* pipe(report.messages, Stream.runForEach(deliver), Effect.forkScoped);

        // ---------------------------------------------------------------
        // The prompt
        // ---------------------------------------------------------------

        /**
         * The range of the selection, or `None` when there is none.
         *
         * A copy, because the range of the selection itself can follow the
         * selection when the focus moves.
         */
        const readSelectedRange: Effect.Effect<Option.Option<Range>> = dom.probeOrElse(
          () =>
            pipe(
              win.getSelection(),
              Option.fromNullishOr,
              Option.filter((selection) => selection.rangeCount > 0),
              Option.map((selection) => selection.getRangeAt(0).cloneRange()),
            ),
          Option.none,
        );

        /** Give back `saved`, while the selection still rests on our host. */
        const restoreSelection = (saved: Option.Option<Range>): Effect.Effect<void> =>
          dom.probeOrElse(
            () =>
              pipe(
                win.getSelection(),
                Option.fromNullishOr,
                Option.filter(restsOn(ui.shadow.host)),
                Option.match({
                  onNone: constVoid,
                  onSome: (selection) => selectOnly(selection, saved),
                }),
              ),
            constVoid,
          );

        const promptIn = <R>(
          options: HudPromptOptions<R>,
        ): Effect.Effect<Option.Option<string>, never, R | Scope.Scope> =>
          Effect.gen(function* () {
            const done = yield* Deferred.make<Option.Option<string>>();
            const settle = (value: Option.Option<string>): Effect.Effect<void> =>
              pipe(done, Deferred.succeed(value), Effect.asVoid);

            // A second prompt replaces the first one. Each prompt owns its own
            // container, so the removal of the old one cannot take the new one
            // with it.
            const { prompt: previous } = yield* Ref.get(state);
            yield* pipe(
              previous,
              Option.match({
                onNone: () => Effect.void,
                onSome: ({ cancel }) => cancel,
              }),
            );
            yield* FiberHandle.clear(timer);

            const id = yield* pipe(
              nextPromptId,
              Ref.modify((n: number) => [n, n + 1]),
            );

            // The focus of the input moves the selection of the document to
            // our host, and the removal of the input leaves a caret there,
            // which visual mode would adopt. The prompt therefore gives back
            // the selection that it found, as upstream does. This release runs
            // after the release of the input below. A selection anywhere else
            // was placed by the page or by the user meanwhile, and it stays.
            yield* Effect.acquireRelease(readSelectedRange, restoreSelection);

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

            yield* patch(
              Struct.assign({
                prompt: Option.some({
                  id,
                  status: parts.status,
                  cancel: settle(Option.none()),
                }),
              }),
            );

            yield* Effect.addFinalizer(() => patch(withoutPrompt(id)));

            const inputFiber = yield* FiberHandle.make<void, never>();

            yield* pipe(
              options.onInput,
              Option.fromNullishOr,
              Option.match({
                onNone: () => Effect.void,
                onSome: (onInput) =>
                  dom.listenOn(parts.input, "input", () =>
                    // Forked, because a body such as the live search of find can
                    // suspend. A newer keystroke interrupts the older search.
                    pipe(onInput(parts.input.value), FiberHandle.run(inputFiber), Effect.asVoid),
                  ),
              }),
            );

            /** Let the caller see the key first, and then decide what it does. */
            const keyAction = (key: KeyboardEvent): Effect.Effect<PromptKey, never, R> =>
              pipe(
                options.onKeydown,
                Option.fromNullishOr,
                Option.match({
                  onNone: () => Effect.succeed(KeyClaim.Pass()),
                  onSome: (onKeydown) => onKeydown(key, parts.input.value),
                }),
                Effect.map(
                  KeyClaim.$match({
                    Taken: () => PromptKey.Taken(),
                    Pass: () => promptKey(key),
                  }),
                ),
              );

            /** What a key press does. Any other event does nothing. */
            const actionFor = (event: Event): Effect.Effect<PromptKey, never, R> =>
              pipe(
                asKeyboardEvent(event),
                Option.match({
                  onNone: () => Effect.succeed(PromptKey.Pass()),
                  onSome: keyAction,
                }),
              );

            /** Carry out what a key press does. */
            const perform = (event: Event) =>
              PromptKey.$match({
                Taken: () => Effect.sync(() => event.preventDefault()),
                Submit: () =>
                  pipe(
                    Effect.sync(() => event.preventDefault()),
                    Effect.andThen(settle(Option.some(parts.input.value))),
                  ),
                Cancel: () =>
                  pipe(
                    Effect.sync(() => event.preventDefault()),
                    Effect.andThen(settle(Option.none())),
                  ),
                Pass: () => Effect.void,
              });

            // The capture phase, and `stopPropagation` for every key: the prompt
            // owns the keyboard while it is open, and the handler stack must not
            // see these events at all.
            yield* dom.listenOn(
              parts.input,
              "keydown",
              (event) =>
                pipe(
                  Effect.sync(() => event.stopPropagation()),
                  Effect.flatMap(() => actionFor(event)),
                  Effect.flatMap(perform(event)),
                ),
              { capture: true },
            );

            yield* dom.listenOn(parts.input, "blur", () =>
              // The page or the user moved on. Treat it as a cancel, and do not
              // leave an invisible modal that holds the keyboard.
              settle(Option.none()),
            );

            // A press anywhere else on the layer cancels the prompt, and goes
            // no further. The layer covers the page, so the default action
            // would move the focus and then the selection: WebKit puts a caret
            // into our layer after the selection was given back.
            yield* dom.listenOn(hudLayer, "mousedown", (event) =>
              pipe(
                event.target === parts.input,
                Boolean.match({
                  onTrue: () => Effect.void,
                  onFalse: () =>
                    pipe(
                      Effect.sync(() => event.preventDefault()),
                      Effect.andThen(settle(Option.none())),
                    ),
                }),
              ),
            );

            yield* Effect.sync(() => {
              // `preventScroll` matters. Without it the page scrolls to the
              // overlay, which sits at the bottom of the viewport.
              parts.input.focus({ preventScroll: true });
              parts.input.setSelectionRange(parts.input.value.length, parts.input.value.length);
            });

            return yield* Deferred.await(done);
          });

        const prompt = <R>(
          options: HudPromptOptions<R>,
        ): Effect.Effect<Option.Option<string>, never, R> => Effect.scoped(promptIn(options));

        return Hud.of({
          show,
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
